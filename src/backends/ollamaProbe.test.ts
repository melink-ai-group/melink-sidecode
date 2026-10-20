import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BackendError } from './types.ts';

// OllamaBackend imports `vscode` at runtime. Register the loader fixture via
// `module.register` (available on Node 22.6/22.12, unlike `registerHooks`) so
// these real-adapter tests run on the project's tested Node range, with no
// skip and no minimum-version change.
register(pathToFileURL(resolve('src/backends/testSupport/vscodeLoader.mjs')).href);

const originalFetch = globalThis.fetch;

async function ollamaBackend(): Promise<import('./ollama.ts').OllamaBackend> {
  const { OllamaBackend } = await import('./ollama.ts');
  const context = {
    secrets: { get: async () => 'token-abc' },
    extensionPath: 'C:/extension',
    globalStorageUri: { fsPath: 'C:/storage' }
  };
  return new OllamaBackend(context as never);
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

test('listModels times out when /api/tags resolves but /api/show never settles', async () => {
  const calls: string[] = [];
  const stub: typeof fetch = async (input) => {
    const url = urlOf(input);
    calls.push(url);
    if (url.endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: [{ name: 'm1' }] }), { status: 200 });
    }
    if (url.endsWith('/api/show')) {
      return new Promise<Response>(() => {});
    }
    return new Response('', { status: 404 });
  };
  globalThis.fetch = stub;
  const guard = setTimeout(() => {}, 1000);
  try {
    const backend = await ollamaBackend();
    const started = Date.now();
    await assert.rejects(backend.listModels(20), (error: unknown) => {
      assert.ok(error instanceof BackendError);
      assert.equal(error.code, 'unavailable');
      assert.match(error.message, /The Ollama Cloud probe timed out after 0\.02s\./);
      assert.equal(/token-abc|authorization|bearer/i.test(error.message), false);
      return true;
    });
    assert.ok(Date.now() - started < 1000);
    assert.ok(calls.some((url) => url.endsWith('/api/show')));
  } finally {
    globalThis.fetch = originalFetch;
    clearTimeout(guard);
  }
});

test('listModels times out when the /api/tags body never settles', async () => {
  const stub: typeof fetch = async () =>
    ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => new Promise(() => {})
    }) as unknown as Response;
  globalThis.fetch = stub;
  const guard = setTimeout(() => {}, 1000);
  try {
    const backend = await ollamaBackend();
    const started = Date.now();
    await assert.rejects(
      backend.listModels(20),
      (error: unknown) => {
        assert.ok(error instanceof BackendError);
        assert.equal(error.code, 'unavailable');
        assert.match(error.message, /timed out after 0\.02s/);
        return true;
      }
    );
    assert.ok(Date.now() - started < 1000);
  } finally {
    globalThis.fetch = originalFetch;
    clearTimeout(guard);
  }
});

test('a non-timeout /api/show failure still degrades that model to unknown', async () => {
  const stub: typeof fetch = async (input) => {
    const url = urlOf(input);
    if (url.endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: [{ name: 'm1' }] }), { status: 200 });
    }
    return new Response('', { status: 500 });
  };
  globalThis.fetch = stub;
  try {
    const backend = await ollamaBackend();
    const models = await backend.listModels(20);
    assert.equal(models.length, 1);
    assert.equal(models[0]?.id, 'm1');
    assert.equal(models[0]?.capabilities, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
