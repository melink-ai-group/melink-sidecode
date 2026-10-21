import test from 'node:test';
import assert from 'node:assert/strict';
import { skillToggleWrites } from './skillWrites.ts';

/**
 * Persistence rule: a toggle persists cliSource, the local path (even when
 * bundled), the application-scoped enabled flag and the legacy mirror only
 * after the apply succeeded.
 */

test('a failed apply writes nothing', () => {
  assert.deepEqual(
    skillToggleWrites({
      skill: 'zvecGrep',
      enabled: true,
      source: 'bundled',
      path: 'C:\\tools\\zg.exe',
      applied: false
    }),
    []
  );
});

test('zvec-grep persists every changed field in one plan', () => {
  const writes = skillToggleWrites({
    skill: 'zvecGrep',
    enabled: true,
    source: 'bundled',
    path: '  C:\\tools\\zg.exe  ',
    applied: true
  });
  assert.deepEqual(writes, [
    { key: 'melink.skills.zvecGrep.cliSource', value: 'bundled' },
    { key: 'melink.skills.zvecGrep.path', value: 'C:\\tools\\zg.exe' },
    { key: 'melink.skills.zvecGrep', value: true },
    { key: 'melink.ollama.opencode.zvecGrep', value: true }
  ]);
});

test('ast-grep persists source, path and enabled without a legacy mirror', () => {
  const writes = skillToggleWrites({
    skill: 'astGrep',
    enabled: false,
    source: 'local',
    path: '',
    applied: true
  });
  assert.deepEqual(writes, [
    { key: 'melink.skills.astGrep.cliSource', value: 'local' },
    { key: 'melink.skills.astGrep.path', value: 'ast-grep' },
    { key: 'melink.skills.astGrep', value: false }
  ]);
});
