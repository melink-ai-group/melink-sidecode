import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  bundledOpencodeExecutable,
  bundledOpencodeInstallDir,
  opencodeInstallDirFor,
  readOpencodeCliSource,
  resolveOpencodeExecutable
} from './resolve.ts';

const roots = { extensionPath: join('C:', 'ext') };

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

test('install dir for bundled is always vendor/opencode/bin', () => {
  assert.equal(
    opencodeInstallDirFor({ source: 'bundled', path: 'C:\\Tools\\OpenCode\\opencode.exe', roots }),
    bundledOpencodeInstallDir(roots)
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
