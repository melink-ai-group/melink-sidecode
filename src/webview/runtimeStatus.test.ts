import test from 'node:test';
import assert from 'node:assert/strict';
import { opencodeRuntimeView } from './runtimeStatus.ts';

const zvecOff = { enabled: false, cli: 'missing' as const };

const localDetected = {
  path: 'opencode',
  status: 'detected' as const,
  version: '1.1.65'
};
const bundledMissing = { path: '/storage/opencode/bin/opencode', status: 'missing' as const };

test('an off Ollama runtime still reports a detected CLI for Zen and the CLI tab', () => {
  const view = opencodeRuntimeView({
    enabled: false,
    cliSource: 'local',
    path: 'opencode',
    status: 'detected',
    version: '1.1.65',
    local: localDetected,
    bundled: bundledMissing,
    zvecGrep: zvecOff
  });
  assert.equal(view.tone, 'detected');
  assert.equal(view.version, '1.1.65');
  assert.match(view.label, /direct adapter/i);
});

test('a detected runtime carries the version', () => {
  const view = opencodeRuntimeView({
    enabled: true,
    cliSource: 'local',
    path: 'opencode',
    status: 'detected',
    version: '1.1.65',
    local: localDetected,
    bundled: bundledMissing,
    zvecGrep: zvecOff
  });
  assert.equal(view.tone, 'detected');
  assert.equal(view.version, '1.1.65');
});

test('the draft source picks the matching probe without waiting for save', () => {
  const opencode = {
    enabled: true,
    cliSource: 'local' as const,
    path: 'opencode',
    status: 'detected' as const,
    version: '1.1.65',
    local: localDetected,
    bundled: bundledMissing,
    zvecGrep: zvecOff
  };
  assert.equal(opencodeRuntimeView(opencode, { source: 'bundled' }).tone, 'missing');
  assert.equal(opencodeRuntimeView(opencode, { source: 'local' }).tone, 'detected');
});

test('missing and not-runnable are distinct from detected', () => {
  assert.equal(
    opencodeRuntimeView({
      enabled: true,
      cliSource: 'local',
      path: 'opencode',
      status: 'missing',
      local: { path: 'opencode', status: 'missing' },
      bundled: bundledMissing,
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
      local: localDetected,
      bundled: { path: '/x', status: 'not-runnable' },
      zvecGrep: zvecOff
    }).tone,
    'not-runnable'
  );
});
