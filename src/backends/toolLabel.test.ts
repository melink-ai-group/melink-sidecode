import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyToolTitle, targetForTool, toolCardPresentation } from './toolLabel.ts';

test('friendly titles name the action and the real target', () => {
  assert.equal(friendlyToolTitle('read', 'src/webview/App.tsx'), 'Reading App.tsx');
  assert.equal(friendlyToolTitle('grep', 'transcriptRef'), 'Searching for transcriptRef');
  assert.equal(friendlyToolTitle('search', 'token'), 'Searching for token');
  assert.equal(friendlyToolTitle('glob', '**/*.ts'), 'Finding files **/*.ts');
  assert.equal(friendlyToolTitle('bash', 'npm test'), 'Running npm test');
  assert.equal(friendlyToolTitle('edit', 'src/a.ts'), 'Editing a.ts');
  assert.equal(friendlyToolTitle('write', 'notes.md'), 'Writing notes.md');
  assert.equal(friendlyToolTitle('list', 'src'), 'Listing src');
});

test('a missing target stays a verb and never invents a path', () => {
  assert.equal(friendlyToolTitle('read'), 'Reading');
  assert.equal(friendlyToolTitle('glob'), 'Finding files');
  assert.equal(friendlyToolTitle('bash'), 'Running command');
  assert.equal(friendlyToolTitle('read', 'completed'), 'Reading');
  assert.equal(friendlyToolTitle('grep', 'completed'), 'Searching');
});

test('tool targets come from the call payload, not the status', () => {
  assert.equal(targetForTool('read', { filePath: 'src/App.tsx' }), 'src/App.tsx');
  assert.equal(targetForTool('grep', { pattern: 'token', path: 'src' }), 'token');
  assert.equal(targetForTool('glob', { pattern: '**/*.ts' }), '**/*.ts');
  assert.equal(targetForTool('bash', { command: 'ls', description: 'list' }), 'ls');
  assert.equal(targetForTool('read', { filePath: 'completed' }), undefined);
});

test('a collapsed card relabels a raw tool id and hides a status detail', () => {
  assert.deepEqual(toolCardPresentation({ title: 'glob', detail: 'completed' }), {
    title: 'Finding files',
    detail: undefined
  });
  assert.deepEqual(toolCardPresentation({ title: 'read', command: 'src/webview/App.tsx' }), {
    title: 'Reading App.tsx',
    detail: 'src/webview/App.tsx'
  });
  assert.deepEqual(toolCardPresentation({ title: 'grep', command: 'completed' }), {
    title: 'Searching',
    detail: undefined
  });
  assert.deepEqual(
    toolCardPresentation({ title: 'Running ls', command: 'ls' }),
    { title: 'Running ls', detail: 'ls' }
  );
});
