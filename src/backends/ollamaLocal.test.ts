import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BackendError } from './types.ts';
import { ProviderTimeoutError } from './probeTimeout.ts';
import { OLLAMA_LOCAL_PROFILE } from './ollamaProfile.ts';
import {
  OLLAMA_LOCAL_MISSING_V1_MESSAGE,
  OLLAMA_LOCAL_NO_KEY_MESSAGE,
  probeOllamaLocal
} from './ollamaLocalHealth.ts';

register(pathToFileURL(resolve('src/backends/testSupport/vscodeLoader.mjs')).href);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function refused(): Promise<Response> {
  const error = new Error('fetch failed');
  (error as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
  return Promise.reject(error);
}

test('a reachable server with /api/tags and /v1/models is connected', async () => {
  const result = await probeOllamaLocal({
    baseUrl: 'http://localhost:11434',
    request: async (path) =>
      path === '/api/tags' ? jsonResponse({ models: [{ name: 'm1' }] }) : jsonResponse({ data: [] })
  });
  assert.equal(result.backendId, 'ollama-local');
  assert.equal(result.outcome, 'ok');
  assert.match(result.message, /Connected to http:\/\/localhost:11434/);
});

test('a refused host names the start command instead of a credential', async () => {
  const result = await probeOllamaLocal({
    baseUrl: 'http://localhost:11434',
    request: refused
  });
  assert.equal(result.outcome, 'host');
  assert.match(result.message, /ollama serve/);
  assert.equal(/credential|api key/i.test(result.message), false);
});

test('a timed-out probe names the deadline', async () => {
  const result = await probeOllamaLocal({
    baseUrl: 'http://localhost:11434',
    timeoutMs: 10_000,
    request: async () => {
      throw new ProviderTimeoutError('Ollama Local', 10_000);
    }
  });
  assert.equal(result.outcome, 'unavailable');
  assert.match(result.message, /within 10s/);
});

test('a key-protected endpoint says Ollama Local does not use keys', async () => {
  const result = await probeOllamaLocal({
    baseUrl: 'http://localhost:11434',
    request: async () => jsonResponse({ error: 'unauthorized' }, 401)
  });
  assert.equal(result.outcome, 'provider');
  assert.equal(result.message, OLLAMA_LOCAL_NO_KEY_MESSAGE);
});

test('a non-Ollama JSON response is identified as the wrong host', async () => {
  const result = await probeOllamaLocal({
    baseUrl: 'http://localhost:11434',
    request: async () => jsonResponse({ hello: 'world' })
  });
  assert.equal(result.outcome, 'provider');
  assert.match(result.message, /did not answer like Ollama/);
});

test('a missing /v1 endpoint asks the user to update Ollama', async () => {
  const result = await probeOllamaLocal({
    baseUrl: 'http://localhost:11434',
    request: async (path) =>
      path === '/api/tags' ? jsonResponse({ models: [] }) : jsonResponse({ error: 'not found' }, 404)
  });
  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.message, OLLAMA_LOCAL_MISSING_V1_MESSAGE);
});

test('a server that refuses /v1 after answering tags is reported as stopped, not outdated', async () => {
  const result = await probeOllamaLocal({
    baseUrl: 'http://localhost:11434',
    request: async (path) => {
      if (path === '/api/tags') {
        return jsonResponse({ models: [] });
      }
      return refused();
    }
  });
  assert.equal(result.outcome, 'host');
  assert.match(result.message, /ollama serve/);
  assert.notEqual(result.message, OLLAMA_LOCAL_MISSING_V1_MESSAGE);
});

test('a /v1 timeout keeps the deadline copy instead of blaming the Ollama version', async () => {
  const result = await probeOllamaLocal({
    baseUrl: 'http://localhost:11434',
    timeoutMs: 5_000,
    request: async (path) => {
      if (path === '/api/tags') {
        return jsonResponse({ models: [] });
      }
      throw new ProviderTimeoutError('Ollama Local', 5_000);
    }
  });
  assert.equal(result.outcome, 'unavailable');
  assert.match(result.message, /within 5s/);
  assert.notEqual(result.message, OLLAMA_LOCAL_MISSING_V1_MESSAGE);
});

test('a non-timeout transport failure on /v1 is a network problem, not a missing endpoint', async () => {
  const reset = new Error('fetch failed');
  (reset as { cause?: unknown }).cause = { code: 'ECONNRESET' };
  const result = await probeOllamaLocal({
    baseUrl: 'http://localhost:11434',
    request: async (path) => {
      if (path === '/api/tags') {
        return jsonResponse({ models: [] });
      }
      throw reset;
    }
  });
  assert.equal(result.outcome, 'network');
  assert.notEqual(result.message, OLLAMA_LOCAL_MISSING_V1_MESSAGE);
});

/** A transport for the real adapter, capturing headers per URL. */
function adapterTransport(options: {
  onTags?: () => Response | Promise<Response>;
  onShow?: () => Response | Promise<Response>;
  onModels?: () => Response | Promise<Response>;
}): {
  transport: (url: string, init: RequestInit) => Promise<Response>;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  return {
    headers,
    transport: async (url, init) => {
      Object.assign(headers, init.headers as Record<string, string>);
      if (url.endsWith('/api/tags')) {
        return options.onTags ? options.onTags() : jsonResponse({ models: [{ name: 'm1' }, { name: 'm2' }] });
      }
      if (url.endsWith('/api/show')) {
        return options.onShow
          ? options.onShow()
          : jsonResponse({
              capabilities: ['completion', 'tools', 'thinking'],
              model_info: { 'llama.context_length': 8192 }
            });
      }
      if (url.endsWith('/v1/models')) {
        return options.onModels ? options.onModels() : jsonResponse({ data: [] });
      }
      return jsonResponse({}, 404);
    }
  };
}

async function localBackend(transport: (url: string, init: RequestInit) => Promise<Response>) {
  const { OllamaBackend } = await import('./ollama.ts');
  const context = {
    secrets: { get: async () => undefined },
    extensionPath: 'C:/extension',
    globalStorageUri: { fsPath: 'C:/storage' }
  };
  return new OllamaBackend(context as never, undefined, undefined, transport, OLLAMA_LOCAL_PROFILE);
}

test('the local adapter lists models and reads capabilities without a token', async () => {
  const { transport, headers } = adapterTransport({});
  const backend = await localBackend(transport);
  const models = await backend.listModels();
  assert.deepEqual(models.map((model) => model.id), ['m1', 'm2']);
  assert.equal(models[0]?.capabilities?.tools, true);
  assert.equal(models[0]?.capabilities?.contextWindow.max, 8192);
  // No credential exists, so no Authorization header is sent.
  assert.equal('Authorization' in headers, false);
  assert.equal(backend.id, 'ollama-local');
  assert.equal(backend.label, 'Ollama Local');
  assert.equal(backend.hasApprovalChannel, true);
  assert.deepEqual([...backend.permissionLevels], ['read-only', 'default', 'unrestricted']);
});

test('isAuthenticated throws an actionable unavailable error when the server is down', async () => {
  const backend = await localBackend(() => refused());
  await assert.rejects(backend.isAuthenticated(), (error: unknown) => {
    assert.ok(error instanceof BackendError);
    assert.equal(error.code, 'unavailable');
    assert.match(error.message, /ollama serve/);
    assert.equal(/no usable credential/i.test(error.message), false);
    return true;
  });
});

test('isAuthenticated is true when both /api/tags and /v1/models answer', async () => {
  const { transport } = adapterTransport({});
  const backend = await localBackend(transport);
  assert.equal(await backend.isAuthenticated(), true);
});

test('testConnection reports a missing /v1 with the actionable copy', async () => {
  const { transport } = adapterTransport({ onModels: () => jsonResponse({}, 404) });
  const backend = await localBackend(transport);
  const result = await backend.testConnection();
  assert.equal(result.backendId, 'ollama-local');
  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.message, OLLAMA_LOCAL_MISSING_V1_MESSAGE);
});

test('testConnection reports a non-Ollama host as a provider problem', async () => {
  const { transport } = adapterTransport({ onTags: () => jsonResponse({ nope: true }) });
  const backend = await localBackend(transport);
  const result = await backend.testConnection();
  assert.equal(result.outcome, 'provider');
  assert.match(result.message, /did not answer like Ollama/);
});
