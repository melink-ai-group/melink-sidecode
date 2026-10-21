import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildZvecIndex,
  parseZvecIndexState,
  zvecIndexGuidance,
  type IndexRunner
} from './zvecIndex.ts';
import type { SpawnOutcome } from './zvecGrep.ts';

test('status output maps to ready, missing, building and unknown', () => {
  assert.equal(parseZvecIndexState('✓ Workspace index is ready'), 'ready');
  assert.equal(parseZvecIndexState('○ Workspace index is not created'), 'missing');
  assert.equal(parseZvecIndexState('? Workspace index is not configured'), 'missing');
  assert.equal(parseZvecIndexState('◐ Workspace index is updating'), 'building');
  assert.equal(parseZvecIndexState('INDEX_MISSING: Search requires an existing index'), 'missing');
  assert.equal(parseZvecIndexState('something else'), 'unknown');
});

test('missing index guidance names Build index and INDEX_MISSING', () => {
  assert.match(zvecIndexGuidance('missing'), /Build index/);
  assert.match(zvecIndexGuidance('missing'), /INDEX_MISSING/);
  assert.match(zvecIndexGuidance('ready'), /ready/);
});

test('build runs zg index in the workspace and confirms with status', async () => {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const run: IndexRunner = async (_command, args, _timeout, cwd) => {
    calls.push({ args: [...args], cwd });
    return args[0] === 'status'
      ? ok('✓ Workspace index is ready')
      : ok('Indexed 120 files');
  };
  const result = await buildZvecIndex({ run, command: 'zg', cwd: '/work/repo' });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'ready');
  assert.match(result.message, /ready/i);
  assert.deepEqual(calls, [
    { args: ['index'], cwd: '/work/repo' },
    { args: ['status'], cwd: '/work/repo' }
  ]);
});

test('a missing embedding model is reported with the exact next command', async () => {
  const run: IndexRunner = async (_command, args) =>
    args[0] === 'status'
      ? ok('? Workspace index is not configured')
      : fail('New indexes require --embedding, ZVEC_GREP_EMBEDDING, or a configured default.');
  const result = await buildZvecIndex({ run, command: 'zg', cwd: '/work/repo' });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'missing');
  assert.match(result.message, /zg config model set/);
});

test('timeout and missing binary each have actionable copy', async () => {
  const timeout: IndexRunner = async () => ({
    code: null,
    stdout: '',
    stderr: '',
    error: 'timeout'
  });
  assert.match(
    (await buildZvecIndex({ run: timeout, command: 'zg', cwd: '/work/repo' })).message,
    /took too long/
  );

  const missing: IndexRunner = async () => ({
    code: null,
    stdout: '',
    stderr: '',
    error: 'missing'
  });
  const result = await buildZvecIndex({ run: missing, command: 'zg', cwd: '/work/repo' });
  assert.equal(result.ok, false);
  assert.match(result.message, /not found/);
});

test('a non-zero exit keeps the last useful line', async () => {
  const run: IndexRunner = async () => fail('permission denied writing .zvec-grep');
  const result = await buildZvecIndex({ run, command: 'zg', cwd: '/work/repo' });
  assert.equal(result.ok, false);
  assert.match(result.message, /permission denied/);
});

function ok(stdout: string): SpawnOutcome {
  return { code: 0, stdout, stderr: '' };
}

function fail(stderr: string): SpawnOutcome {
  return { code: 1, stdout: '', stderr };
}
