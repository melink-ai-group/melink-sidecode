import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserBridge, type BridgeCall } from './bridge.ts';
import { browserEndpointFileName } from './config.ts';
import type { ToolResult } from './tools.ts';

const OK: ToolResult = { content: [{ type: 'text', text: 'ok' }] };

async function post(url: string, token: string, body: unknown): Promise<number> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  await response.text();
  return response.status;
}

test('the bridge forwards the provider named by the shim and ignores an invalid one', async () => {
  const calls: BridgeCall[] = [];
  const bridge = new BrowserBridge(async (call) => {
    calls.push(call);
    return OK;
  });
  const url = await bridge.start('token-a');
  try {
    assert.equal(await post(url, 'token-a', { name: 'browser_click', arguments: { selector: '#save' }, provider: 'codex' }), 200);
    assert.deepEqual(calls[0], { name: 'browser_click', arguments: { selector: '#save' }, provider: 'codex' });

    assert.equal(await post(url, 'token-a', { name: 'browser_click', arguments: {}, provider: 'not-a-provider' }), 200);
    assert.deepEqual(calls[1], { name: 'browser_click', arguments: {} });

    assert.equal(await post(url, 'wrong-token', { name: 'browser_click', arguments: {}, provider: 'codex' }), 401);
    assert.equal(calls.length, 2, 'an unauthorized call never reaches the handler');
  } finally {
    await bridge.close();
  }
});

test('two windows get distinct endpoint files and one stop removes only its own', async () => {
  const calls: BridgeCall[] = [];
  const first = new BrowserBridge(async (call) => {
    calls.push(call);
    return OK;
  });
  const second = new BrowserBridge(async () => OK);
  const firstUrl = await first.start('token-first');
  const secondUrl = await second.start('token-second');
  const directory = await mkdtemp(join(tmpdir(), 'melink-browser-endpoints-'));
  try {
    assert.notEqual(firstUrl, secondUrl);
    const firstFile = join(directory, browserEndpointFileName('token-first', 111));
    const secondFile = join(directory, browserEndpointFileName('token-second', 111));
    assert.notEqual(firstFile, secondFile);
    await writeFile(firstFile, JSON.stringify({ url: firstUrl, token: 'token-first' }), { mode: 0o600 });
    await writeFile(secondFile, JSON.stringify({ url: secondUrl, token: 'token-second' }), { mode: 0o600 });

    assert.equal(JSON.parse(await readFile(firstFile, 'utf8')).token, 'token-first');
    assert.equal(JSON.parse(await readFile(secondFile, 'utf8')).token, 'token-second');
    assert.equal(await post(firstUrl, 'token-first', { name: 'browser_snapshot', arguments: {} }), 200);
    assert.equal(await post(firstUrl, 'token-second', { name: 'browser_snapshot', arguments: {} }), 401);

    // What one window's stop does: remove its file and close its own bridge.
    await rm(firstFile, { force: true });
    await first.close();
    await assert.rejects(stat(firstFile));
    assert.equal(JSON.parse(await readFile(secondFile, 'utf8')).token, 'token-second');
    assert.equal(await post(secondUrl, 'token-second', { name: 'browser_snapshot', arguments: {} }), 200);
  } finally {
    await first.close();
    await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});
