import test from 'node:test';
import assert from 'node:assert/strict';
import { opencodeRuntimeView } from './runtimeStatus.ts';

const zvecOff = { enabled: false, cli: 'missing' as const };

test('an off runtime reports the disabled tone, never a stale probe result', () => {
  const view = opencodeRuntimeView({
    enabled: false,
    cliSource: 'local',
    path: 'opencode',
    status: 'detected',
    version: '1.1.65',
    zvecGrep: zvecOff
  });
  assert.equal(view.tone, 'disabled');
  assert.equal(view.version, undefined);
});

test('a detected runtime carries the version', () => {
  const view = opencodeRuntimeView({
    enabled: true,
    cliSource: 'local',
    path: 'opencode',
    status: 'detected',
    version: '1.1.65',
    zvecGrep: zvecOff
  });
  assert.equal(view.tone, 'detected');
  assert.equal(view.version, '1.1.65');
});

test('missing and not-runnable are distinct from detected and disabled', () => {
  assert.equal(
    opencodeRuntimeView({
      enabled: true,
      cliSource: 'local',
      path: 'opencode',
      status: 'missing',
      zvecGrep: zvecOff
    }).tone,
    'missing'
  );
  assert.equal(
    opencodeRuntimeView({
      enabled: true,
      cliSource: 'bundled',
      path: '/x',
      status: 'not-runnable',
      zvecGrep: zvecOff
    }).tone,
    'not-runnable'
  );
});
