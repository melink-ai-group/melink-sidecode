import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOUBLE_CHECK_NAME_CAP,
  DOUBLE_CHECK_SETTLE_MS,
  collectDoubleCheck,
  doubleCheckNotice,
  type DoubleCheckDiagnostic
} from './doubleCheck.ts';

const error: DoubleCheckDiagnostic = { severity: 'error' };
const warning: DoubleCheckDiagnostic = { severity: 'warning' };

test('the settle delay is the documented 1500ms', () => {
  assert.equal(DOUBLE_CHECK_SETTLE_MS, 1500);
  assert.equal(DOUBLE_CHECK_NAME_CAP, 3);
});

test('a clean sweep reports the file count and an info notice', () => {
  const result = collectDoubleCheck(['src/a.ts', 'src/b.ts'], (path) =>
    path.endsWith('a.ts') ? [warning] : []
  );
  assert.deepEqual(result, {
    status: 'clean',
    fileCount: 2,
    errorCount: 0,
    names: []
  });
  assert.deepEqual(doubleCheckNotice(result), {
    level: 'info',
    message: 'Double-check: no errors in 2 changed files.'
  });
});

test('errors are counted and the warning notice names the files', () => {
  const diagnostics: Record<string, DoubleCheckDiagnostic[]> = {
    'src/a.ts': [error, warning, error],
    'src/b.ts': [error]
  };
  const result = collectDoubleCheck(['src/a.ts', 'src/b.ts'], (path) => diagnostics[path] ?? []);
  assert.deepEqual(result, {
    status: 'issues',
    fileCount: 2,
    errorCount: 3,
    names: ['src/a.ts', 'src/b.ts']
  });
  assert.deepEqual(doubleCheckNotice(result), {
    level: 'warning',
    message:
      'Double-check: 3 errors in 2 changed files: src/a.ts, src/b.ts. Open Problems for details.'
  });
});

test('names are capped at three while the error count stays complete', () => {
  const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
  const result = collectDoubleCheck(files, () => [error]);
  assert.equal(result.errorCount, 4);
  assert.deepEqual(result.names, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.equal(doubleCheckNotice(result)?.message, 
    'Double-check: 4 errors in 4 changed files: src/a.ts, src/b.ts, src/c.ts. Open Problems for details.'
  );
});

test('read failures are skipped and never fail the sweep', () => {
  const result = collectDoubleCheck(['src/a.ts', 'src/missing.ts', 'src/b.ts'], (path) => {
    if (path === 'src/missing.ts') {
      throw new Error('gone');
    }
    return [];
  });
  assert.deepEqual(result, {
    status: 'clean',
    fileCount: 2,
    errorCount: 0,
    names: []
  });
});

test('all reads failing or no changed files produces no notice', () => {
  const failed = collectDoubleCheck(['src/a.ts', 'src/b.ts'], () => {
    throw new Error('gone');
  });
  assert.deepEqual(failed, {
    status: 'none',
    fileCount: 0,
    errorCount: 0,
    names: []
  });
  assert.equal(doubleCheckNotice(failed), undefined);

  const empty = collectDoubleCheck([], () => []);
  assert.equal(empty.status, 'none');
  assert.equal(doubleCheckNotice(empty), undefined);
});

test('only errors count, including VS Code numeric severity zero', () => {
  const result = collectDoubleCheck(['src/a.ts'], () => [
    { severity: 0 },
    { severity: 1 },
    { severity: 'warning' },
    { severity: 'hint' }
  ]);
  assert.equal(result.errorCount, 1);
  assert.equal(result.status, 'issues');
});

test('duplicate paths are read once', () => {
  let reads = 0;
  const result = collectDoubleCheck(['src/a.ts', 'src/a.ts'], () => {
    reads += 1;
    return [];
  });
  assert.equal(reads, 1);
  assert.equal(result.fileCount, 1);
});

test('singular counts read correctly', () => {
  const result = collectDoubleCheck(['src/a.ts'], () => [error]);
  assert.equal(doubleCheckNotice(result)?.message,
    'Double-check: 1 error in 1 changed file: src/a.ts. Open Problems for details.'
  );
});
