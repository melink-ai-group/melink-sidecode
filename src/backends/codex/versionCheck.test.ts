import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessGeneratedProtocol,
  assessProtocolProbe,
  versionCheckResult
} from './versionCheck.ts';
import { allowValidatedVersion, normalizeValidatedVersions, ValidatedCodexVersions } from './validatedVersions.ts';

const clientRequest = [
  'initialize',
  'thread/start',
  'thread/resume',
  'thread/delete',
  'thread/list',
  'thread/turns/list',
  'thread/items/list',
  'thread/compact/start',
  'model/list',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'getAuthStatus'
]
  .map((method) => `{ "method": "${method}" }`)
  .join(' | ');

test('a complete probe with the methods this app calls is allowed', () => {
  const probe = assessProtocolProbe({
    userAgent: 'melink-agent-sidebar/9.9.9 (Windows)',
    modelList: { data: [], nextCursor: null },
    threadList: { data: [], nextCursor: null },
    authStatus: { authMethod: null, authToken: null, requiresOpenaiAuth: true },
    failures: []
  });
  const protocol = assessGeneratedProtocol({
    clientRequest,
    threadStartParams: 'developerInstructions?: string | null'
  });
  const result = versionCheckResult(probe, protocol);
  assert.equal(result.ok, true);
  assert.equal(result.version, '9.9.9');
  assert.match(result.message, /now allowed/);
});

test('a probe that did not answer is not allowed', () => {
  const probe = assessProtocolProbe({
    failures: ['The Codex CLI refused model/list, so this version is still unsupported.']
  });
  assert.equal(probe.ok, false);
  assert.match(probe.message, /model\/list/);
});

test('a model list without data is not the protocol this app uses', () => {
  const probe = assessProtocolProbe({
    userAgent: 'codex-cli 9.9.9',
    modelList: { models: [] },
    threadList: { data: [] },
    authStatus: { authMethod: 'chatgpt' },
    failures: []
  });
  assert.equal(probe.ok, false);
  assert.equal(probe.version, '9.9.9');
});

test('a generated protocol missing a method is not allowed', () => {
  const protocol = assessGeneratedProtocol({
    clientRequest: '{ "method": "initialize" }',
    threadStartParams: 'developerInstructions?: string | null'
  });
  assert.equal(protocol.ok, false);
  assert.match(protocol.message, /thread\/start/);
});

test('a generated protocol without developer instructions is not allowed', () => {
  const protocol = assessGeneratedProtocol({
    clientRequest,
    threadStartParams: 'cwd?: string | null'
  });
  assert.equal(protocol.ok, false);
  assert.match(protocol.message, /developer instructions/);
});

test('a version already in the window is reported as already supported', () => {
  const result = versionCheckResult(
    { ok: true, version: '0.163.0', message: '' },
    { ok: true, message: '' }
  );
  assert.equal(result.ok, true);
  assert.match(result.message, /already in the supported range/);
});

test('validated versions keep only exact out-of-range releases', () => {
  assert.deepEqual(allowValidatedVersion(['9.9.9'], '9.9.9'), ['9.9.9']);
  assert.deepEqual(allowValidatedVersion([], '0.163.0'), []);
  assert.deepEqual(normalizeValidatedVersions(['nope', '9.9.9', '9.9.9', 3]), ['9.9.9']);
});

test('the store remembers an allowed version and ignores one inside the window', async () => {
  const data = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, fallback?: T): T => (data.has(key) ? (data.get(key) as T) : (fallback as T)),
    update: async (key: string, value: unknown): Promise<void> => {
      data.set(key, value);
    }
  };
  const store = new ValidatedCodexVersions(state);
  await store.allow('9.9.9');
  await store.allow('0.163.0');
  assert.deepEqual(store.list(), ['9.9.9']);
});
