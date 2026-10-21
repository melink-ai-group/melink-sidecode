import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BackendError } from './types.ts';
import {
  PROVIDER_PROBE_TIMEOUT_MS,
  ProviderTimeoutError,
  fetchWithProbeSignal,
  probeOllamaConnection,
  probeSignal,
  requestWithProbeTimeout,
  timeoutMessage
} from './probeTimeout.ts';

/** A fetch that never settles and ignores its signal, as a stalled host would. */
const neverFetch: typeof fetch = () => new Promise<Response>(() => {});

function tokenFree(message: string): boolean {
  return !message.includes('super-secret') && !/authorization|bearer/i.test(message);
}

test('the shared deadline and timeout sentence are stable', () => {
  assert.equal(PROVIDER_PROBE_TIMEOUT_MS, 10_000);
  assert.equal(
    timeoutMessage('Ollama Cloud', PROVIDER_PROBE_TIMEOUT_MS),
    'The Ollama Cloud probe timed out after 10s. Try again.'
  );
});

test('probeSignal fires after the injected deadline', async () => {
  const signal = probeSignal(20);
  assert.equal(signal.aborted, false);
  await new Promise<void>((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('probe signal did not fire')), 1000);
    const done = (): void => {
      clearTimeout(guard);
      resolve();
    };
    if (signal.aborted) {
      done();
      return;
    }
    signal.addEventListener('abort', done, { once: true });
  });
  assert.equal(signal.aborted, true);
});

/** Keep the event loop alive while an unref'd deadline timer is pending. */
async function keepAlive<T>(run: () => Promise<T>): Promise<T> {
  const guard = setTimeout(() => {}, 1000);
  try {
    return await run();
  } finally {
    clearTimeout(guard);
  }
}

test('a timed-out Ollama model list rejects as unavailable with the timeout message', async () => {
  const started = Date.now();
  await keepAlive(async () => {
    await assert.rejects(
      requestWithProbeTimeout({
        url: 'https://ollama.invalid/api/tags',
        init: { headers: { Authorization: 'Bearer super-secret' } },
        provider: 'Ollama Cloud',
        timeoutMs: 20,
        fetchImpl: neverFetch
      }),
      (error: unknown) => {
        assert.ok(error instanceof BackendError);
        assert.equal(error.code, 'unavailable');
        assert.match(error.message, /timed out after 0\.02s/);
        assert.equal(tokenFree(error.message), true);
        return true;
      }
    );
  });
  assert.ok(Date.now() - started < 1000);
});

test('Ollama testConnection returns a distinct timeout result and passes a signal', async () => {
  const calls: RequestInit[] = [];
  const stub: typeof fetch = (_input, init) => {
    calls.push(init ?? {});
    return new Promise<Response>(() => {});
  };
  const started = Date.now();
  const result = await keepAlive(() =>
    probeOllamaConnection({
      baseUrl: 'https://ollama.invalid',
      token: 'super-secret',
      timeoutMs: 20,
      fetchImpl: stub
    })
  );
  assert.equal(result.outcome, 'unavailable');
  assert.match(result.message, /timed out after 0\.02s/);
  assert.equal(tokenFree(result.message), true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.signal instanceof AbortSignal);
  assert.ok(Date.now() - started < 1000);
});

test('Ollama probe keeps 401/403, DNS/refused, provider and ok distinct', async () => {
  const base = { baseUrl: 'https://ollama.invalid', token: 'super-secret' };
  const invalidKey = await probeOllamaConnection({
    ...base,
    fetchImpl: async () => new Response('', { status: 401 })
  });
  assert.equal(invalidKey.outcome, 'invalid-key');

  const forbidden = await probeOllamaConnection({
    ...base,
    fetchImpl: async () => new Response('', { status: 403 })
  });
  assert.equal(forbidden.outcome, 'invalid-key');

  const dns = await probeOllamaConnection({
    ...base,
    fetchImpl: async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }
  });
  assert.equal(dns.outcome, 'host');

  const refused = await probeOllamaConnection({
    ...base,
    fetchImpl: async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }
  });
  assert.equal(refused.outcome, 'host');

  const provider = await probeOllamaConnection({
    ...base,
    fetchImpl: async () => new Response('', { status: 500 })
  });
  assert.equal(provider.outcome, 'provider');

  const ok = await probeOllamaConnection({
    ...base,
    fetchImpl: async () => new Response('{"models":[]}', { status: 200 })
  });
  assert.equal(ok.outcome, 'ok');
});

test('a caller-canceled probe request stays a cancel, not a timeout', async () => {
  const controller = new AbortController();
  controller.abort();
  const stub: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const abort = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (init?.signal?.aborted) {
        abort();
        return;
      }
      init?.signal?.addEventListener('abort', abort, { once: true });
    });
  await assert.rejects(
    requestWithProbeTimeout({
      url: 'https://ollama.invalid/api/tags',
      init: { signal: controller.signal },
      provider: 'Ollama Cloud',
      timeoutMs: 20,
      fetchImpl: stub
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'AbortError');
      assert.equal(error instanceof BackendError, false);
      return true;
    }
  );
});

test('the combine fallback aborts the fetch at the deadline without AbortSignal.any', async () => {
  const originalAny = (AbortSignal as unknown as { any?: unknown }).any;
  let fetchAborted = false;
  const stub: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          fetchAborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        },
        { once: true }
      );
    });
  const guard = setTimeout(() => {}, 1000);
  try {
    (AbortSignal as unknown as { any?: unknown }).any = undefined;
    await assert.rejects(
      fetchWithProbeSignal(
        'https://ollama.invalid/api/tags',
        { signal: new AbortController().signal },
        'Ollama Cloud',
        20,
        probeSignal(20),
        stub
      ),
      (error: unknown) => error instanceof ProviderTimeoutError
    );
  } finally {
    (AbortSignal as unknown as { any?: unknown }).any = originalAny;
    clearTimeout(guard);
  }
  assert.equal(fetchAborted, true);
});

test('OpenCode testConnection reports a Zen catalog timeout as unavailable', async () => {
  const source = await readFile('src/backends/opencodeBackend.ts', 'utf8');
  assert.match(
    source,
    /if \(error instanceof ProviderTimeoutError\) \{\s*return \{\s*backendId: this\.id,\s*outcome: 'unavailable',\s*message: error\.message\s*\};/
  );
});

test('both probe fetch paths pass an abort signal and no bare probe fetch remains', async () => {
  const probe = await readFile('src/backends/probeTimeout.ts', 'utf8');
  assert.match(probe, /fetchImpl\(url, \{ \.\.\.init, signal: fetchSignal \}\)/);

  const zen = await readFile('src/backends/opencode/zenCatalog.ts', 'utf8');
  assert.match(zen, /fetchImpl\(url, \{ signal \}\)/);

  // The Ollama adapter keeps the observable client seam, so the deadline is
  // applied inside the client and the adapter passes it explicitly.
  const ollama = await readFile('src/backends/ollama.ts', 'utf8');
  assert.match(ollama, /this\.client\.probe\('\/api\/tags', token, undefined, \{ timeoutMs \}\)/);
  assert.match(ollama, /readProbeJson<OllamaTagsResponse>/);
  assert.match(ollama, /probeSignal as createProbeSignal/);

  const client = await readFile('src/backends/ollamaBaseUrl.ts', 'utf8');
  assert.match(client, /withProbeTimeout\(label, timeoutMs, signal, run\)/);
});
