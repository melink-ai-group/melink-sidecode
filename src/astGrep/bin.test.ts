import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAstGrepBinValue } from './bin.ts';

/**
 * The ast-grep MCP shim spawns the CLI with the workspace as its working
 * directory, so a configured value that names a relative file would run a
 * file from the repository. The Windows drive-relative form (`C:evil.exe`)
 * is the sharpest case: it carries no separator, so a "relative path with a
 * separator" rule alone would let it through.
 */

test('an absolute ast-grep path is used as-is', () => {
  assert.equal(resolveAstGrepBinValue('C:\\tools\\ast-grep.exe'), 'C:\\tools\\ast-grep.exe');
  assert.equal(resolveAstGrepBinValue('/usr/local/bin/ast-grep'), '/usr/local/bin/ast-grep');
});

test('a bare ast-grep name is left for PATH resolution', () => {
  assert.equal(resolveAstGrepBinValue('ast-grep'), 'ast-grep');
});

test('a relative ast-grep path is refused', () => {
  for (const value of ['./evil', '..\\evil', 'sub/ast-grep']) {
    assert.equal(resolveAstGrepBinValue(value), undefined, value);
  }
});

test('a drive-relative ast-grep path is refused', () => {
  for (const value of ['C:evil.exe', 'C:', 'C:..\\evil', 'z:ast-grep.exe']) {
    assert.equal(resolveAstGrepBinValue(value), undefined, value);
  }
});

test('an empty ast-grep value falls back to the PATH lookup', () => {
  assert.equal(resolveAstGrepBinValue(undefined), undefined);
  assert.equal(resolveAstGrepBinValue('   '), undefined);
});
