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

test('bundled v2 status uses its own probe and cannot inherit a detected v1', () => {
  const snapshot = { cliSource: 'bundled' as const, path: 'opencode', status: 'detected' as const,
    local: localDetected, bundled: localDetected, zvecGrep: zvecOff };
  assert.equal(opencodeRuntimeView(snapshot, { source: 'bundled-v2' }).tone, 'missing');
  assert.equal(opencodeRuntimeView({ ...snapshot, bundledV2: { ...localDetected, version: '2.2.6' } },
    { source: 'bundled-v2' }).version, '2.2.6');
});

test('a detected runtime carries the version and no disabled state', () => {
  const view = opencodeRuntimeView({
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
  assert.equal(/direct adapter/i.test(view.label), false);
  assert.equal(/disabled/i.test(view.label), false);
});

test('the draft source picks the matching probe without waiting for save', () => {
  const opencode = {
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
