import assert from 'node:assert/strict';
import { createServer, Agent, type RequestOptions } from 'node:http';
import http from 'node:http';
import test from 'node:test';
import { serverFetch } from './interactive.ts';

test('loopback requests bypass the proxy agent and send the server password', async () => {
  const seen: { authorization?: string; directory?: string | string[] } = {};
  const server = createServer((req, res) => {
    seen.authorization = req.headers.authorization;
    seen.directory = req.headers['x-opencode-directory'];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"ok":');
    res.write('true}');
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const previous = http.globalAgent;
  let proxied = false;
  const proxy = new Agent();
  proxy.addRequest = ((_req: unknown, _options: RequestOptions) => {
    proxied = true;
  }) as Agent['addRequest'];
  http.globalAgent = proxy;
  try {
    const response = await serverFetch(
      `http://127.0.0.1:${port}`,
      'C:\\work\\sidecar',
      '/global/health',
      { method: 'GET' },
      {
        OPENCODE_SERVER_USERNAME: 'opencode',
        OPENCODE_SERVER_PASSWORD: 'secret'
      }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(seen.authorization, `Basic ${Buffer.from('opencode:secret', 'utf8').toString('base64')}`);
    assert.equal(seen.directory, undefined);
    assert.equal(proxied, false);
  } finally {
    http.globalAgent = previous;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
