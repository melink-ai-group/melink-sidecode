import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Wire tests for the browser MCP shim.
 *
 * OpenCode 1.19.x speaks newline-delimited JSON; older clients use
 * `Content-Length` headers. A shim that only parses headers answers a line
 * handshake with zero bytes, so OpenCode offers no browser tools at all. Each
 * test runs the real shim against a fake bridge and checks the reply framing,
 * the forwarded call, and the provider it carries.
 */

type Framing = 'line' | 'header';

interface RpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: {
    protocolVersion?: string;
    serverInfo?: { name?: string };
    tools?: { name?: string }[];
    content?: { type: string; text?: string }[];
  };
  error?: { message?: string };
}

interface BridgeCall {
  name?: unknown;
  arguments?: unknown;
  provider?: unknown;
}

const shim = join(process.cwd(), 'src', 'browser', 'mcp.ts');
const TOKEN = 'browser-test-token';

async function startBridge(): Promise<{ url: string; calls: BridgeCall[]; close: () => Promise<void> }> {
  const calls: BridgeCall[] = [];
  const server: Server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ content: [{ type: 'text', text: 'refused' }], isError: true }));
      return;
    }
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      calls.push(JSON.parse(body) as BridgeCall);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ content: [{ type: 'text', text: 'bridge answered' }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/call`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

async function endpointFile(url: string): Promise<{ directory: string; file: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'melink-browser-mcp-'));
  const file = join(directory, 'browser-endpoint.json');
  await writeFile(file, JSON.stringify({ url, token: TOKEN }), 'utf8');
  return { directory, file };
}

/**
 * Send the messages in one framing, then read exactly one reply per request in
 * the same framing. The child is stopped once all replies arrive.
 */
function runShim(file: string, framing: Framing, messages: unknown[]): Promise<{ responses: RpcResponse[]; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', shim, '--endpoint-file', file, '--provider', 'opencode'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    const responses: RpcResponse[] = [];
    let pending = Buffer.alloc(0);
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve({ responses, stdout, stderr });
    };

    const drain = (): void => {
      while (responses.length < messages.length) {
        if (framing === 'line') {
          const newline = pending.indexOf(0x0a);
          if (newline < 0) {
            return;
          }
          const line = pending.subarray(0, newline).toString('utf8').trim();
          pending = pending.subarray(newline + 1);
          if (line.length > 0) {
            responses.push(JSON.parse(line) as RpcResponse);
          }
          continue;
        }
        const headerEnd = pending.indexOf('\r\n\r\n');
        if (headerEnd < 0) {
          return;
        }
        const header = pending.subarray(0, headerEnd).toString('ascii');
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match?.[1]) {
          pending = pending.subarray(headerEnd + 4);
          continue;
        }
        const start = headerEnd + 4;
        const length = Number(match[1]);
        if (pending.length < start + length) {
          return;
        }
        responses.push(JSON.parse(pending.subarray(start, start + length).toString('utf8')) as RpcResponse);
        pending = pending.subarray(start + length);
      }
      finish();
    };

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`));
    }, 20_000);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      pending = Buffer.concat([pending, chunk]);
      drain();
    });
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('exit', () => finish());

    for (const message of messages) {
      const json = JSON.stringify(message);
      child.stdin?.write(
        framing === 'line'
          ? `${json}\n`
          : `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`
      );
    }
    child.stdin?.end();
  });
}

const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test' } } },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'http://localhost:3000/' } } }
];

for (const framing of ['line', 'header'] as const) {
  test(`the shim reads ${framing}-framed JSON and replies in the same framing`, async () => {
    const bridge = await startBridge();
    const endpoint = await endpointFile(bridge.url);
    try {
      const result = await runShim(endpoint.file, framing, requests);
      assert.equal(result.stderr.includes('Missing --endpoint-file'), false, result.stderr);
      assert.deepEqual(
        result.responses.map((response) => response.id),
        [1, 2, 3]
      );

      const [initialize, list, call] = result.responses;
      assert.equal(initialize?.result?.serverInfo?.name, 'melink-browser');
      assert.equal(initialize?.result?.protocolVersion, '2025-11-25');
      const names = (list?.result?.tools ?? []).map((tool) => tool.name);
      for (const name of [
        'browser_navigate',
        'browser_resize',
        'browser_snapshot',
        'browser_click',
        'browser_type',
        'browser_press',
        'browser_console',
        'browser_assert'
      ]) {
        assert.ok(names.includes(name), `${name} in ${names.join(',')}`);
      }
      assert.equal(call?.result?.content?.[0]?.text, 'bridge answered');
      assert.deepEqual(bridge.calls, [
        { name: 'browser_navigate', arguments: { url: 'http://localhost:3000/' }, provider: 'opencode' }
      ]);

      if (framing === 'line') {
        assert.equal(/Content-Length:/i.test(result.stdout), false, 'a line client must not receive header replies');
        assert.equal(result.stdout.includes('\r\n\r\n'), false);
      } else {
        assert.match(result.stdout, /Content-Length:\s*\d+\r\n\r\n/);
      }
    } finally {
      await bridge.close();
      await rm(endpoint.directory, { recursive: true, force: true });
    }
  });
}

test('the shim answers a line-framed initialize with bytes (OpenCode regression)', async () => {
  const bridge = await startBridge();
  const endpoint = await endpointFile(bridge.url);
  try {
    const result = await runShim(endpoint.file, 'line', [requests[0]]);
    assert.equal(result.responses.length, 1, result.stderr);
    assert.ok(result.stdout.trim().length > 0);
    assert.equal(result.responses[0]?.result?.serverInfo?.name, 'melink-browser');
    assert.deepEqual(bridge.calls, []);
  } finally {
    await bridge.close();
    await rm(endpoint.directory, { recursive: true, force: true });
  }
});
