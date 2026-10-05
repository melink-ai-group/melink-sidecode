import test from 'node:test';
import assert from 'node:assert/strict';
import { prettyPath, setPrettyPathRoots } from './prettyPath.ts';

const KANBAN = 'C:\\work\\acme-app';
const FILE = 'C:\\work\\acme-app\\frontend\\src\\components\\analytics\\AnalyticsSection.tsx';

test('a path inside a workspace root becomes the project path', () => {
  assert.equal(
    prettyPath(FILE, [KANBAN]),
    'frontend/src/components/analytics/AnalyticsSection.tsx'
  );
});

test('the longest matching root wins', () => {
  assert.equal(
    prettyPath(FILE, ['C:\\work', KANBAN]),
    'frontend/src/components/analytics/AnalyticsSection.tsx'
  );
});

test('an absolute path outside the workspace drops the drive and work parent', () => {
  assert.equal(
    prettyPath(FILE, ['C:\\work\\project']),
    'acme-app/frontend/src/components/analytics/AnalyticsSection.tsx'
  );
});

test('a home directory is not part of the visual path', () => {
  assert.equal(
    prettyPath('C:\\Users\\dev\\projects\\app\\src\\index.ts', []),
    'app/src/index.ts'
  );
});

test('a relative path and a plain title stay as written', () => {
  assert.equal(prettyPath('frontend/src/components/analytics/AnalyticsSection.tsx', [KANBAN]), 'frontend/src/components/analytics/AnalyticsSection.tsx');
  assert.equal(prettyPath('Reading AnalyticsSection.tsx', [KANBAN]), 'Reading AnalyticsSection.tsx');
});

test('absolute paths inside a command are shortened and urls are not', () => {
  assert.equal(
    prettyPath(`rg -n "status" ${FILE}`, [KANBAN]),
    'rg -n "status" frontend/src/components/analytics/AnalyticsSection.tsx'
  );
  assert.equal(prettyPath('https://example.com/a/b', [KANBAN]), 'https://example.com/a/b');
});

test('setPrettyPathRoots supplies the roots for later calls', () => {
  setPrettyPathRoots([KANBAN]);
  assert.equal(prettyPath(FILE), 'frontend/src/components/analytics/AnalyticsSection.tsx');
  setPrettyPathRoots([]);
});
