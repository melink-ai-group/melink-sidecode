import test from 'node:test';
import assert from 'node:assert/strict';
import { contentBeforePatches, contentBeforeReplacements } from './patchReverse.ts';
import { diffLines } from './diff.ts';

const original = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].join('\n') + '\n';
const edited = ['alpha', 'beta', 'GAMMA', 'delta', 'epsilon'].join('\n') + '\n';

test('a one-line edit restores the previous file instead of the whole file', () => {
  const diff = ['@@ -2,3 +2,3 @@', ' beta', '-gamma', '+GAMMA', ' delta', ''].join('\n');
  const before = contentBeforePatches(edited, [diff]);
  assert.equal(before, original);
  const review = diffLines(before ?? '', edited);
  assert.equal(review.additions, 1);
  assert.equal(review.deletions, 1);
});

test('a headerless hunk still locates the changed line', () => {
  const diff = ['@@', ' beta', '-gamma', '+GAMMA', ' delta'].join('\n');
  assert.equal(contentBeforePatches(edited, [diff]), original);
});

test('an insertion is reversed to the file without that line', () => {
  const withLine = ['alpha', 'beta', 'NEW', 'gamma'].join('\n') + '\n';
  const diff = ['@@ -2,1 +2,2 @@', ' beta', '+NEW', ' gamma'].join('\n');
  const before = contentBeforePatches(withLine, [diff]);
  assert.equal(before, 'alpha\nbeta\ngamma\n');
  assert.equal(diffLines(before ?? '', withLine).additions, 1);
});

test('a deletion is put back at the hunk position', () => {
  const after = 'alpha\nbeta\ndelta\n';
  const diff = '@@ -3,1 +3,0 @@\n-gamma\n';
  assert.equal(contentBeforePatches(after, [diff]), 'alpha\nbeta\ngamma\ndelta\n');
});

test('two successive patches are undone from last to first', () => {
  const first = '@@ -1,1 +1,1 @@\n-alpha\n+ALPHA\n';
  const second = '@@ -3,1 +3,1 @@\n-gamma\n+GAMMA\n';
  const after = 'ALPHA\nbeta\nGAMMA\ndelta\n';
  assert.equal(contentBeforePatches(after, [first, second]), 'alpha\nbeta\ngamma\ndelta\n');
});

test('an apply_patch wrapper around one hunk is ignored', () => {
  const diff = ['*** Begin Patch', '*** Update File: notes.txt', '@@', ' beta', '-gamma', '+GAMMA', ' delta', '*** End Patch'].join('\n');
  assert.equal(contentBeforePatches(edited, [diff]), original);
});

test('a patch that does not match the file is refused', () => {
  assert.equal(contentBeforePatches(edited, ['@@\n-missing\n+nope\n']), undefined);
});

test('an exact old/new pair restores that span and leaves the rest of the file', () => {
  const before = contentBeforeReplacements(edited, [{ before: 'gamma', after: 'GAMMA' }]);
  assert.equal(before, original);
});

test('a replacement that occurs twice is skipped instead of guessing', () => {
  assert.equal(contentBeforeReplacements('a\na\n', [{ before: 'b', after: 'a' }]), undefined);
});

test('a repeated copy of the same patch is applied once', () => {
  const diff = '@@ -3,1 +3,1 @@\n-gamma\n+GAMMA\n';
  assert.equal(contentBeforePatches(edited, [diff, diff]), original);
});
