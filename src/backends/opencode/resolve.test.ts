import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  bundledOpencodeExecutable,
  bundledOpencodeInstallDir,
  bundledOpencodePreferredExecutable,
  opencodeInstallDirFor,
  readOpencodeCliSource,
  resolveOpencodeExecutable
} from './resolve.ts';

const roots = { extensionPath: join('C:', 'ext'), globalStoragePath: join('C:', 'storage') };

test('bundled v2 is isolated from v1 and never falls back to the v1 binary or PATH', () => {
  assert.equal(readOpencodeCliSource('bundled-v2'), 'bundled-v2');
  const options = { source: 'bundled-v2' as const, path: 'opencode', roots };
  assert.equal(opencodeInstallDirFor(options), join(roots.globalStoragePath, 'opencode-v2', 'bin'));
  assert.equal(resolveOpencodeExecutable(options), bundledOpencodePreferredExecutable(roots, 2));
  assert.notEqual(resolveOpencodeExecutable(options), bundledOpencodeExecutable(roots));
});

test('cli source falls back to local for unknown values', () => {
  assert.equal(readOpencodeCliSource('bundled'), 'bundled');
  assert.equal(readOpencodeCliSource('local'), 'local');
  assert.equal(readOpencodeCliSource(undefined), 'local');
  assert.equal(readOpencodeCliSource('other'), 'local');
});

test('bundled resolve ignores the path setting', () => {
  assert.equal(
    resolveOpencodeExecutable({ source: 'bundled', path: 'C:\\Tools\\OpenCode\\opencode.exe', roots }),
    bundledOpencodeExecutable(roots)
  );
  assert.equal(
    resolveOpencodeExecutable({ source: 'bundled', path: 'opencode', roots }),
    join(bundledOpencodeInstallDir(roots), process.platform === 'win32' ? 'opencode.exe' : 'opencode')
  );
});

test('local resolve uses the configured path or the bare default', () => {
  assert.equal(
    resolveOpencodeExecutable({ source: 'local', path: 'C:\\Tools\\OpenCode\\opencode.exe', roots }),
    'C:\\Tools\\OpenCode\\opencode.exe'
  );
  assert.equal(resolveOpencodeExecutable({ source: 'local', path: '  ', roots }), 'opencode');
  assert.equal(resolveOpencodeExecutable({ source: 'local', path: 'opencode', roots }), 'opencode');
});

test('install dir for bundled uses persistent global storage', () => {
  assert.equal(
    opencodeInstallDirFor({ source: 'bundled', path: 'C:\\Tools\\OpenCode\\opencode.exe', roots }),
    bundledOpencodeInstallDir(roots)
  );
  assert.equal(bundledOpencodeInstallDir(roots), join('C:', 'storage', 'opencode', 'bin'));
  assert.equal(
    bundledOpencodePreferredExecutable(roots),
    join('C:', 'storage', 'opencode', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode')
  );
});

test('bundled install dir falls back to extension vendor without global storage', () => {
  const legacyRoots = { extensionPath: join('C:', 'ext') };
  assert.equal(
    bundledOpencodeInstallDir(legacyRoots),
    join('C:', 'ext', 'vendor', 'opencode', 'bin')
  );
});

test('install dir for a local absolute path is that file parent', () => {
  assert.equal(
    opencodeInstallDirFor({
      source: 'local',
      path: join('C:', 'Tools', 'OpenCode', 'opencode.exe'),
      roots
    }),
    join('C:', 'Tools', 'OpenCode')
  );
});
