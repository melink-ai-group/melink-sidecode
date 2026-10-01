import test from 'node:test';
import assert from 'node:assert/strict';
import { opencodeRuntimeView } from './runtimeStatus.ts';

test('an off runtime reports the disabled tone, never a stale probe result', () => {
  const view = opencodeRuntimeView({ enabled: false, path: 'opencode', status: 'detected', version: '1.1.65' });
  assert.equal(view.tone, 'disabled');
  assert.equal(view.version, undefined);
});

test('a detected runtime carries the version', () => {
  const view = opencodeRuntimeView({ enabled: true, path: 'opencode', status: 'detected', version: '1.1.65' });
  assert.equal(view.tone, 'detected');
  assert.equal(view.version, '1.1.65');
});

test('missing and not-runnable are distinct from detected and disabled', () => {
  assert.equal(opencodeRuntimeView({ enabled: true, path: 'opencode', status: 'missing' }).tone, 'missing');
  assert.equal(opencodeRuntimeView({ enabled: true, path: '/x', status: 'not-runnable' }).tone, 'not-runnable');
});
