import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OLLAMA_BASE_URL,
  OllamaClient,
  isHttpOllamaUrl,
  normalizeOllamaBaseUrl,
  ollamaProbe,
  ollamaRequest,
  ollamaRequestUrl,
  resolveOllamaBaseUrl,
  type OllamaTransport
} from './ollamaBaseUrl.ts';

/**
 * The host the Ollama Cloud bearer token is sent to.
 *
 * The transport seam lets a test observe the exact URL a request goes to, so
 * "the workspace cannot redirect the token" is an assertion about an observed
 * request, not about a helper's return value.
 */

function recordingTransport(): { transport: OllamaTransport; urls: string[]; headers: string[] } {
  const urls: string[] = [];
  const headers: string[] = [];
  const transport: OllamaTransport = async (url, init) => {
    urls.push(url);
    headers.push(String((init.headers as Record<string, string>)?.Authorization ?? ''));
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

test('a workspace base URL is ignored and the user host is used', () => {
  const inspected = {
    defaultValue: DEFAULT_OLLAMA_BASE_URL,
    globalValue: 'https://user.example',
    workspaceValue: 'https://evil.example'
  };
  assert.equal(resolveOllamaBaseUrl(inspected), 'https://user.example');
});

test('a workspace-only base URL falls back to the contributed default', () => {
  const inspected = {
    defaultValue: DEFAULT_OLLAMA_BASE_URL,
    workspaceValue: 'https://evil.example'
  };
  assert.equal(resolveOllamaBaseUrl(inspected), DEFAULT_OLLAMA_BASE_URL);
});

test('the base URL is trimmed and loses its trailing slashes', () => {
  assert.equal(normalizeOllamaBaseUrl('  https://user.example///  '), 'https://user.example');
  assert.equal(ollamaRequestUrl('https://user.example/', '/api/tags'), 'https://user.example/api/tags');
});

test('a non-http base URL is refused', () => {
  assert.equal(isHttpOllamaUrl('https://user.example'), true);
  assert.equal(isHttpOllamaUrl('http://user.example'), true);
  assert.equal(isHttpOllamaUrl('file:///etc/passwd'), false);
  assert.equal(isHttpOllamaUrl('not a url'), false);
});

test('the request goes to the user host and never to the workspace host', async () => {
  const { transport, urls, headers } = recordingTransport();
  const client = new OllamaClient(
    {
      defaultValue: DEFAULT_OLLAMA_BASE_URL,
      globalValue: 'https://user.example',
      workspaceValue: 'https://evil.example'
    },
    transport
  );
  await client.request('/api/tags', 'secret-token');
  assert.deepEqual(urls, ['https://user.example/api/tags']);
  assert.equal(urls.some((url) => url.includes('evil.example')), false);
  // The credential travels in the header, and only to the user host.
  assert.equal(headers.length, 1);
  assert.equal(headers[0], 'Bearer secret-token');
});

test('the request URL is built from the resolved base URL alone', async () => {
  const { transport, urls } = recordingTransport();
  await ollamaRequest({
    baseUrl: 'https://user.example',
    path: '/api/chat',
    token: 'secret-token',
    transport
  });
  assert.deepEqual(urls, ['https://user.example/api/chat']);
});

test('a rejected credential is reported without echoing it', async () => {
  const transport: OllamaTransport = async () =>
    ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: new Headers(),
      json: async () => ({})
    }) as unknown as Response;
  await assert.rejects(
    ollamaRequest({ baseUrl: 'https://user.example', path: '/api/tags', token: 'secret-token', transport }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : '';
      assert.equal(message.includes('secret-token'), false);
      assert.match(message, /rejected/);
      return true;
    }
  );
});

/**
 * The status-preserving probe.
 *
 * The settings screen's "Test connection" has to tell a rejected key (`401`)
 * apart from a host-side failure (any other non-2xx), so the probe keeps the
 * status instead of turning it into an error. It still goes through the same
 * transport seam, so the host that receives the credential is observable.
 */
test('the probe keeps the status so the caller can classify it', async () => {
  const transport: OllamaTransport = async () =>
    ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: new Headers(),
      json: async () => ({})
    }) as unknown as Response;
  const response = await ollamaProbe({
    baseUrl: 'https://user.example',
    path: '/api/tags',
    token: 'secret-token',
    transport
  });
  assert.equal(response.status, 401);
});

test('the probe goes to the user host and never to the workspace host', async () => {
  const { transport, urls, headers } = recordingTransport();
  const client = new OllamaClient(
    {
      defaultValue: DEFAULT_OLLAMA_BASE_URL,
      globalValue: 'https://user.example',
      workspaceValue: 'https://evil.example'
    },
    transport
  );
  await client.probe('/api/tags', 'secret-token');
  assert.deepEqual(urls, ['https://user.example/api/tags']);
  assert.equal(urls.some((url) => url.includes('evil.example')), false);
  assert.equal(headers[0], 'Bearer secret-token');
});
