import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { astGrepWorkspaceRoot, resolveWorkspacePaths, validateWorkspaceGlobs } from './paths.ts';

const root = resolve(process.cwd(), 'workspace-root');

test('paths stay relative to the workspace', () => {
  const checked = resolveWorkspacePaths(['src/a.ts', '.'], root);
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.paths, [join('src', 'a.ts'), '.']);
  assert.deepEqual(resolveWorkspacePaths([root], root).paths, ['.']);
  assert.deepEqual(resolveWorkspacePaths([join(root, 'src')], root).paths, ['src']);
});

test('paths outside the workspace are refused', () => {
  for (const value of ['..', '../secret.txt', join(root, '..', 'secret.txt'), join(root, '..')]) {
    const checked = resolveWorkspacePaths([value], root);
    assert.equal(checked.ok, false, value);
    assert.match(checked.error ?? '', /outside the workspace/);
  }
});

test('drive-relative Windows paths are refused everywhere', () => {
  const checked = resolveWorkspacePaths(['C:secret.txt'], root);
  assert.equal(checked.ok, false);
  assert.match(checked.error ?? '', /drive-relative/);
});

test('empty paths are refused', () => {
  assert.equal(resolveWorkspacePaths(['  '], root).ok, false);
});

test('globs may not walk out of the workspace', () => {
  assert.equal(validateWorkspaceGlobs(['src/**/*.ts', '!**/node_modules/**']).ok, true);
  for (const glob of ['../**', '/etc/**', 'C:evil/**', 'C:\\evil\\**', '!C:/evil/**']) {
    assert.equal(validateWorkspaceGlobs([glob]).ok, false, glob);
  }
});

test('the workspace root falls back to the process cwd', () => {
  assert.equal(astGrepWorkspaceRoot({}), process.cwd());
  assert.equal(astGrepWorkspaceRoot({ AST_GREP_WORKSPACE: '/tmp/repo' }), '/tmp/repo');
  assert.equal(astGrepWorkspaceRoot({ AST_GREP_WORKSPACE: '   ' }), process.cwd());
});
