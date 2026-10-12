import test from 'node:test';
import assert from 'node:assert/strict';
import { excludedByIgnore, hasIgnoredSegment, isIgnoredRelPath } from './ignore.ts';

test('dependency and tool directories are ignored at any depth', () => {
  assert.equal(hasIgnoredSegment('node_modules/left-pad/index.js'), true);
  assert.equal(hasIgnoredSegment('.opencode/node_modules/@opencode-ai/sdk/package.json'), true);
  assert.equal(hasIgnoredSegment('.git/objects/ab'), true);
  assert.equal(hasIgnoredSegment('frontend/dist/assets/index.js'), true);
  assert.equal(hasIgnoredSegment('frontend/src/Card.tsx'), false);
  assert.equal(hasIgnoredSegment('src/app.ts'), false);
});

test('a gitignore directory pattern hides files nested inside it', () => {
  assert.equal(isIgnoredRelPath('frontend/dist/assets/index-abc.css', '**/dist'), true);
  assert.equal(isIgnoredRelPath('frontend/dist/index.html', '**/dist'), true);
  assert.equal(isIgnoredRelPath('frontend/src/Card.tsx', '**/dist'), false);
});

test('a root gitignore hides matching paths and keeps everything else', () => {
  const gitignore = `
# build output
dist/
*.log
!keep.log
`;
  assert.equal(isIgnoredRelPath('dist/app.js', gitignore), true);
  assert.equal(isIgnoredRelPath('src/debug.log', gitignore), true);
  assert.equal(isIgnoredRelPath('keep.log', gitignore), false);
  assert.equal(isIgnoredRelPath('src/app.ts', gitignore), false);
  assert.equal(isIgnoredRelPath('.opencode/bun.lock', gitignore), true);
});

test('a directory rule blocks a later negation of a file inside it', () => {
  const gitignore = `
dist/
!dist/app.js
`;
  assert.equal(isIgnoredRelPath('dist/app.js', gitignore), true);
  assert.equal(isIgnoredRelPath('src/app.js', gitignore), false);
});

test('a nested gitignore excludes its own paths and can un-ignore a file rule', () => {
  const sources = [
    { directory: '', text: '*.log\npkg/\n' },
    { directory: 'src', text: '!keep.log\n' },
    { directory: 'pkg', text: '!secret.txt\n' }
  ];
  assert.equal(excludedByIgnore('src/keep.log', sources), false);
  assert.equal(excludedByIgnore('src/other.log', sources), true);
  assert.equal(excludedByIgnore('pkg/secret.txt', sources), true);
  assert.equal(excludedByIgnore('pkg/keep.ts', sources), true);
  assert.equal(excludedByIgnore('src/app.ts', sources), false);
});
