import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { astGrepReleaseFilename } from './install.ts';
import {
  bundledAstGrepInstallDir,
  resolveAstGrepExecutable,
  readAstGrepCliSource
} from './resolve.ts';
import { buildReplaceArgs, buildSearchArgs } from '../../astGrep/args.ts';

test('cli source coerces unknown values to local', () => {
  assert.equal(readAstGrepCliSource('bundled'), 'bundled');
  assert.equal(readAstGrepCliSource('local'), 'local');
  assert.equal(readAstGrepCliSource('other'), 'local');
});

test('bundled install dir prefers global storage', () => {
  assert.equal(
    bundledAstGrepInstallDir({ extensionPath: '/ext', globalStoragePath: '/storage' }),
    join('/storage', 'ast-grep', 'bin')
  );
  assert.equal(
    bundledAstGrepInstallDir({ extensionPath: '/ext' }),
    join('/ext', 'vendor', 'ast-grep', 'bin')
  );
});

test('resolve ignores path when bundled', () => {
  const roots = { extensionPath: '/ext', globalStoragePath: '/storage' };
  const path = resolveAstGrepExecutable({ source: 'bundled', path: 'ignored', roots });
  assert.equal(path, join('/storage', 'ast-grep', 'bin', process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep'));
});

test('release filename matches GitHub assets', () => {
  assert.equal(astGrepReleaseFilename({ os: 'windows', arch: 'x64' }), 'app-x86_64-pc-windows-msvc.zip');
  assert.equal(astGrepReleaseFilename({ os: 'darwin', arch: 'arm64' }), 'app-aarch64-apple-darwin.zip');
  assert.equal(astGrepReleaseFilename({ os: 'linux', arch: 'x64' }), 'app-x86_64-unknown-linux-gnu.zip');
});

test('search args use pattern and optional lang', () => {
  assert.deepEqual(buildSearchArgs({ pattern: 'console.log($A)', lang: 'typescript' }), [
    'run',
    '-p',
    'console.log($A)',
    '--json=compact',
    '-l',
    'typescript',
    '.'
  ]);
});

test('replace args default to dry-run', () => {
  assert.deepEqual(buildReplaceArgs({ pattern: 'foo($A)', rewrite: 'bar($A)' }), [
    'run',
    '-p',
    'foo($A)',
    '-r',
    'bar($A)',
    '--json=compact',
    '.'
  ]);
  assert.deepEqual(buildReplaceArgs({ pattern: 'foo($A)', rewrite: 'bar($A)', dryRun: false }), [
    'run',
    '-p',
    'foo($A)',
    '-r',
    'bar($A)',
    '--update-all',
    '.'
  ]);
});
