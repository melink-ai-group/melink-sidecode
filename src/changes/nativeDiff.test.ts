import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MELINK_CHANGES_SCHEME,
  changesViewRow,
  diffSides,
  hasBaseline,
  parseVirtualDocument,
  resolveVirtualContent,
  virtualUriParts
} from './nativeDiff.ts';

/**
 * The native-diff planner is the host-free half of the workbench integration.
 * These tests pin the contract between a recorded file status and the sides a
 * diff opens with, so a created file never shows a missing left and a deleted
 * file never shows a missing right.
 */

test('a modified file diffs the pre-turn virtual document against the working file', () => {
  const sides = diffSides({ status: 'modified', hasBefore: true, hasAfter: true });
  assert.deepEqual(sides.left, { kind: 'virtual', side: 'before' });
  assert.deepEqual(sides.right, { kind: 'file' });
});

test('a created file has an empty left side, so no before blob is required', () => {
  const sides = diffSides({ status: 'created', hasBefore: false, hasAfter: true });
  assert.deepEqual(sides.left, { kind: 'virtual', side: 'empty' });
  assert.deepEqual(sides.right, { kind: 'file' });
});

test('a deleted file has an empty right side', () => {
  const sides = diffSides({ status: 'deleted', hasBefore: true, hasAfter: false });
  assert.deepEqual(sides.left, { kind: 'virtual', side: 'before' });
  assert.deepEqual(sides.right, { kind: 'virtual', side: 'empty' });
});

test('a modified file without a before snapshot is not a baseline', () => {
  assert.equal(hasBaseline({ status: 'modified', hasBefore: false, hasAfter: true }), false);
  assert.equal(hasBaseline({ status: 'created', hasBefore: false, hasAfter: true }), true);
  assert.equal(hasBaseline({ status: 'modified', hasBefore: true, hasAfter: true }), true);
});

test('a modified file whose before blob was not stored degrades to an empty left, never a missing URI', () => {
  const sides = diffSides({ status: 'modified', hasBefore: false, hasAfter: true });
  assert.deepEqual(sides.left, { kind: 'virtual', side: 'empty' });
  assert.deepEqual(sides.right, { kind: 'file' });
});

test('a renamed file diffs its pre-turn content against the working file', () => {
  const sides = diffSides({ status: 'renamed', hasBefore: true, hasAfter: true });
  assert.deepEqual(sides.left, { kind: 'virtual', side: 'before' });
  assert.deepEqual(sides.right, { kind: 'file' });
});

test('a changes-view row labels a deleted file with its virtual pre-turn document', () => {
  const row = changesViewRow({ status: 'deleted', hasBefore: true, hasAfter: false });
  assert.deepEqual(row.label, { kind: 'virtual', side: 'before' });
  assert.deepEqual(row.original, { kind: 'virtual', side: 'before' });
  assert.deepEqual(row.modified, { kind: 'virtual', side: 'empty' });
});

test('a changes-view row labels a live file with the working file URI', () => {
  const row = changesViewRow({ status: 'modified', hasBefore: true, hasAfter: true });
  assert.deepEqual(row.label, { kind: 'file' });
  assert.deepEqual(row.original, { kind: 'virtual', side: 'before' });
  assert.deepEqual(row.modified, { kind: 'file' });
});

test('virtual URI parts round-trip through the parser', () => {
  const parts = virtualUriParts({ turnId: 'turn 1', relPath: 'src/a b.ts', side: 'before' });
  assert.equal(MELINK_CHANGES_SCHEME, 'melink-changes');
  assert.equal(parts.path, '/src/a b.ts');
  const parsed = parseVirtualDocument(parts);
  assert.deepEqual(parsed, { turnId: 'turn 1', relPath: 'src/a b.ts', side: 'before' });
});

test('the parser rejects a malformed URI rather than throwing', () => {
  assert.equal(parseVirtualDocument({ path: '/x.ts', query: '' }), undefined);
  assert.equal(parseVirtualDocument({ path: '/x.ts', query: 'turnId=t&side=sideways' }), undefined);
  assert.equal(parseVirtualDocument({ path: '/', query: 'turnId=t&side=before' }), undefined);
});

test('an empty side resolves to the empty document without a journal read', async () => {
  let reads = 0;
  const content = await resolveVirtualContent({ turnId: 't', relPath: 'x.ts', side: 'empty' }, async () => {
    reads += 1;
    return undefined;
  });
  assert.equal(content, '');
  assert.equal(reads, 0);
});

test('a before side resolves to the journal content, and missing content is empty not an error', async () => {
  const content = await resolveVirtualContent({ turnId: 't', relPath: 'x.ts', side: 'before' }, async () =>
    new TextEncoder().encode('old line\n')
  );
  assert.equal(content, 'old line\n');
  const missing = await resolveVirtualContent({ turnId: 't', relPath: 'x.ts', side: 'before' }, async () => undefined);
  assert.equal(missing, '');
});
