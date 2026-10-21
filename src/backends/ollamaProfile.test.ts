import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OLLAMA_CLOUD_PROFILE,
  OLLAMA_LOCAL_PROFILE,
  ollamaProfileFor
} from './ollamaProfile.ts';
import {
  OllamaClient,
  normalizeOllamaBaseUrl,
  ollamaRequest,
  resolveOllamaBaseUrl,
  type OllamaTransport
} from './ollamaBaseUrl.ts';

test('the cloud and local profiles differ only in identity, keys and credential mode', () => {
  assert.equal(OLLAMA_CLOUD_PROFILE.id, 'ollama');
  assert.equal(OLLAMA_CLOUD_PROFILE.label, 'Ollama Cloud');
  assert.equal(OLLAMA_CLOUD_PROFILE.badge, 'Ollama');
  assert.equal(OLLAMA_CLOUD_PROFILE.baseUrlKey, 'melink.ollama.baseUrl');
  assert.equal(OLLAMA_CLOUD_PROFILE.defaultBaseUrl, 'https://ollama.com');
  assert.equal(OLLAMA_CLOUD_PROFILE.defaultModelKey, 'melink.ollama.defaultModel');
  assert.equal(OLLAMA_CLOUD_PROFILE.credential, 'secret');

  assert.equal(OLLAMA_LOCAL_PROFILE.id, 'ollama-local');
  assert.equal(OLLAMA_LOCAL_PROFILE.label, 'Ollama Local');
  assert.equal(OLLAMA_LOCAL_PROFILE.badge, 'Ollama');
  assert.equal(OLLAMA_LOCAL_PROFILE.baseUrlKey, 'melink.ollamaLocal.baseUrl');
  assert.equal(OLLAMA_LOCAL_PROFILE.defaultBaseUrl, 'http://localhost:11434');
  assert.equal(OLLAMA_LOCAL_PROFILE.defaultModelKey, 'melink.ollamaLocal.defaultModel');
  assert.equal(OLLAMA_LOCAL_PROFILE.credential, 'none');

  assert.equal(ollamaProfileFor('ollama'), OLLAMA_CLOUD_PROFILE);
  assert.equal(ollamaProfileFor('ollama-local'), OLLAMA_LOCAL_PROFILE);
  assert.equal(ollamaProfileFor('codex'), undefined);
});

test('the local base URL is user-scoped and normalized', () => {
  assert.equal(
    resolveOllamaBaseUrl(
      {
        defaultValue: 'http://localhost:11434',
        globalValue: 'http://127.0.0.1:1234///',
        workspaceValue: 'http://evil.example'
      },
      'http://localhost:11434'
    ),
    'http://127.0.0.1:1234'
  );
  assert.equal(
    resolveOllamaBaseUrl(
      { defaultValue: 'http://localhost:11434', workspaceValue: 'http://evil.example' },
      'http://localhost:11434'
    ),
    'http://localhost:11434'
  );
  assert.equal(normalizeOllamaBaseUrl(' http://localhost:11434/ '), 'http://localhost:11434');
});

function recordingTransport(): {
  transport: OllamaTransport;
  urls: string[];
  headers: Array<Record<string, string>>;
} {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const transport: OllamaTransport = async (url, init) => {
    urls.push(url);
    headers.push((init.headers as Record<string, string>) ?? {});
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => ({ models: [] })
    } as unknown as Response;
  };
  return { transport, urls, headers };
}

test('a tokenless local request omits the Authorization header entirely', async () => {
  const { transport, urls, headers } = recordingTransport();
  await ollamaRequest({
    baseUrl: 'http://localhost:11434',
    path: '/api/tags',
    providerLabel: 'Ollama Local',
    transport
  });
  assert.deepEqual(urls, ['http://localhost:11434/api/tags']);
  assert.equal('Authorization' in headers[0], false);
});

test('a cloud request still carries the bearer token', async () => {
  const { transport, headers } = recordingTransport();
  await ollamaRequest({
    baseUrl: 'https://ollama.com',
    path: '/api/tags',
    token: 'secret-token',
    transport
  });
  assert.equal(headers[0].Authorization, 'Bearer secret-token');
});

test('the local client reads the local key and sends no credential', async () => {
  const { transport, headers } = recordingTransport();
  const client = new OllamaClient(
    { globalValue: 'http://localhost:11434' },
    transport,
    'http://localhost:11434',
    'Ollama Local'
  );
  await client.request('/api/tags');
  assert.equal(client.baseUrl, 'http://localhost:11434');
  assert.equal('Authorization' in headers[0], false);
});
