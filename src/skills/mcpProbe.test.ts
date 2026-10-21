import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeOpencodeServer, runMcpSession } from './mcpProbe.ts';

/**
 * The handshake probe is the difference between "the CLI file exists" and
 * "the MCP server OpenCode starts actually answers". It must read both
 * framings: zvec-grep 0.2.x writes one JSON object per line, while older
 * servers use `Content-Length` headers.
 */

const SERVER_SCRIPT = String.raw`
let buffer = Buffer.alloc(0);
let mode = process.env.FAKE_FRAMING;
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});
process.stdin.resume();
function drain() {
  while (true) {
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) return;
    const line = buffer.subarray(0, newline).toString('utf8').trim();
    buffer = buffer.subarray(newline + 1);
    if (line.length === 0) continue;
    handle(JSON.parse(line));
  }
}
function handle(message) {
  if (message.id === undefined) return;
  let result = {};
  if (message.method === 'initialize') {
    result = { protocolVersion: '2024-11-05', serverInfo: { name: 'fake', version: '1.0.0' } };
  } else if (message.method === 'tools/list') {
    result = { tools: [{ name: 'alpha' }, { name: 'beta' }] };
  } else if (message.method === 'tools/call') {
    result = { content: [{ type: 'text', text: 'echo:' + message.params.arguments.value }] };
  }
  send({ jsonrpc: '2.0', id: message.id, result });
}
function send(message) {
  const json = JSON.stringify(message);
  if (mode === 'newline') {
    process.stdout.write(json + '\n');
  } else {
    const bytes = Buffer.from(json, 'utf8');
    process.stdout.write('Content-Length: ' + bytes.length + '\r\n\r\n');
    process.stdout.write(bytes);
  }
}
`;

async function withServer(run: (script: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'melink-mcp-probe-'));
  const script = join(dir, 'server.cjs');
  await writeFile(script, SERVER_SCRIPT, 'utf8');
  try {
    await run(script);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('probe reads newline-delimited JSON and lists tools', async () => {
  await withServer(async (script) => {
    const result = await runMcpSession(process.execPath, [script], {
      env: { FAKE_FRAMING: 'newline' }
    });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.tools, ['alpha', 'beta']);
    assert.equal(result.serverInfo?.name, 'fake');
  });
});

test('probe reads Content-Length framed responses', async () => {
  await withServer(async (script) => {
    const result = await runMcpSession(process.execPath, [script], {
      env: { FAKE_FRAMING: 'header' }
    });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.tools, ['alpha', 'beta']);
  });
});

test('probe runs a read-only tool call', async () => {
  await withServer(async (script) => {
    const result = await runMcpSession(process.execPath, [script], {
      env: { FAKE_FRAMING: 'newline' },
      calls: [{ name: 'echo', arguments: { value: 'hi' } }]
    });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.calls, [{ ok: true, text: 'echo:hi' }]);
  });
});

test('probe refuses a config entry with no command', async () => {
  const result = await probeOpencodeServer({ type: 'local', command: [], enabled: true });
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /no command/);
});

test('probe reports a missing server binary instead of hanging', async () => {
  const result = await probeOpencodeServer({
    type: 'local',
    command: ['definitely-not-a-real-mcp-binary-sidecode', 'server', '--stdio'],
    enabled: true
  });
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /not found|exited|could not be started/i);
});

test('probe reports an early exit with its stderr line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'melink-mcp-exit-'));
  const script = join(dir, 'exit.cjs');
  await writeFile(script, "process.stderr.write('server exploded\\n'); process.exit(2);\n", 'utf8');
  try {
    const result = await runMcpSession(process.execPath, [script], { timeoutMs: 3000 });
    assert.equal(result.ok, false);
    assert.match(result.message ?? '', /server exploded/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('probe times out a server that never answers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'melink-mcp-silent-'));
  const script = join(dir, 'silent.cjs');
  await writeFile(script, 'process.stdin.resume();\n', 'utf8');
  try {
    const result = await runMcpSession(process.execPath, [script], { timeoutMs: 400 });
    assert.equal(result.ok, false);
    assert.match(result.message ?? '', /did not answer/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
