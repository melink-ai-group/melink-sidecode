import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReplaceArgs, buildSearchArgs } from './args.ts';

test('search defaults to the workspace and keeps the JSON output', () => {
  assert.deepEqual(buildSearchArgs({ pattern: 'console.log($$$ARGS)' }), [
    'run',
    '-p',
    'console.log($$$ARGS)',
    '--json=compact',
    '.'
  ]);
  assert.deepEqual(buildSearchArgs({ pattern: 'x', lang: 'ts', context: 2, paths: ['src'] }), [
    'run',
    '-p',
    'x',
    '--json=compact',
    '-l',
    'ts',
    '-C',
    '2',
    'src'
  ]);
});

test('replace previews by default and never writes without approval', () => {
  assert.deepEqual(buildReplaceArgs({ pattern: 'a', rewrite: 'b', paths: ['src'] }), [
    'run',
    '-p',
    'a',
    '-r',
    'b',
    '--json=compact',
    'src'
  ]);

  assert.throws(
    () => buildReplaceArgs({ pattern: 'a', rewrite: 'b', dryRun: false, paths: ['src'] }),
    /approve: true/
  );
  assert.throws(
    () => buildReplaceArgs({ pattern: 'a', rewrite: 'b', dryRun: false, approve: true }),
    /explicit paths/
  );
});

test('replace writes only an explicit approved path list', () => {
  assert.deepEqual(
    buildReplaceArgs({
      pattern: 'a',
      rewrite: 'b',
      dryRun: false,
      approve: true,
      paths: ['src/a.ts']
    }),
    ['run', '-p', 'a', '-r', 'b', '--update-all', 'src/a.ts']
  );
});

test('a pattern is required', () => {
  assert.throws(() => buildSearchArgs({}), /requires a pattern/);
  assert.throws(() => buildReplaceArgs({ pattern: 'a' }), /pattern and rewrite/);
});
