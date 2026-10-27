import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFileReference } from './fileReferences.ts';

test('a relative file path keeps its line and column', () => {
  assert.deepEqual(parseFileReference('src/webview/Markdown.tsx:14:3'), {
    path: 'src/webview/Markdown.tsx',
    line: 14,
    column: 3
  });
  assert.deepEqual(parseFileReference('src/editorNavigation.ts'), {
    path: 'src/editorNavigation.ts'
  });
});

test('an absolute path is a file reference on Windows and Unix', () => {
  assert.deepEqual(parseFileReference('C:\\work\\melink\\melink-sidecode\\sidebar\\package.json'), {
    path: 'C:\\work\\melink\\melink-sidecode\\sidebar\\package.json'
  });
  assert.deepEqual(parseFileReference('/work/melink/sidebar/README.md'), {
    path: '/work/melink/sidebar/README.md'
  });
});

test('extensionless names that are files still open', () => {
  assert.deepEqual(parseFileReference('Dockerfile'), { path: 'Dockerfile' });
  assert.deepEqual(parseFileReference('Makefile'), { path: 'Makefile' });
  assert.deepEqual(parseFileReference('.gitignore'), { path: '.gitignore' });
});

test('ordinary prose, commands, URLs and versions stay plain text', () => {
  for (const value of [
    'npm test',
    'useState',
    'https://localhost:3000/app',
    'mailto:team@example.com',
    'version 1.2.3',
    'Read Markdown.tsx and tell me why',
    'src/webview/'
  ]) {
    assert.equal(parseFileReference(value), undefined, value);
  }
});
