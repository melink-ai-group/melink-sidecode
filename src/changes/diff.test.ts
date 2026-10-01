import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, applyRejectedHunks } from './diff.ts';

test('pure additions report a correct hunk header and count', () => {
  const diff = diffLines('a\nb\n', 'a\nb\nc\n');
  assert.equal(diff.additions, 1);
  assert.equal(diff.deletions, 0);
  assert.equal(diff.hunks.length, 1);
  assert.equal(diff.hunks[0].header, '@@ -1,2 +1,3 @@');
  assert.deepEqual(
    diff.hunks[0].lines.map((line) => line.kind),
    ['context', 'context', 'add']
  );
});

test('pure deletions report a correct hunk header and count', () => {
  const diff = diffLines('a\nb\nc\n', 'a\nc\n');
  assert.equal(diff.additions, 0);
  assert.equal(diff.deletions, 1);
  assert.equal(diff.hunks[0].header, '@@ -1,3 +1,2 @@');
});

test('a single-line change mid-file produces one del and one add', () => {
  const diff = diffLines('a\nb\nc\nd\ne\n', 'a\nb\nX\nd\ne\n');
  assert.equal(diff.additions, 1);
  assert.equal(diff.deletions, 1);
  assert.equal(diff.hunks.length, 1);
  assert.equal(diff.hunks[0].header, '@@ -1,5 +1,5 @@');
  assert.deepEqual(
    diff.hunks[0].lines.map((line) => `${line.kind}:${line.text}`),
    ['context:a', 'context:b', 'del:c', 'add:X', 'context:d', 'context:e']
  );
});

test('a change at the first line is diffed in place', () => {
  const diff = diffLines('a\nb\nc\n', 'X\nb\nc\n');
  assert.equal(diff.hunks[0].header, '@@ -1,3 +1,3 @@');
  assert.deepEqual(
    diff.hunks[0].lines.map((line) => line.kind),
    ['del', 'add', 'context', 'context']
  );
});

test('a change at the last line is diffed in place', () => {
  const diff = diffLines('a\nb\nc\n', 'a\nb\nZ\n');
  assert.equal(diff.hunks[0].header, '@@ -1,3 +1,3 @@');
  assert.deepEqual(
    diff.hunks[0].lines.map((line) => line.kind),
    ['context', 'context', 'del', 'add']
  );
});

test('CRLF and LF with the same content produce no diff', () => {
  const diff = diffLines('a\r\nb\r\nc\r\n', 'a\nb\nc\n');
  assert.equal(diff.hunks.length, 0);
  assert.equal(diff.additions, 0);
  assert.equal(diff.deletions, 0);
});

test('a CRLF line change is reported against its LF counterpart', () => {
  const diff = diffLines('a\r\nb\r\nc\r\n', 'a\nX\nc\n');
  assert.equal(diff.additions, 1);
  assert.equal(diff.deletions, 1);
  assert.equal(diff.hunks[0].header, '@@ -1,3 +1,3 @@');
});

test('a missing trailing newline is a real line difference', () => {
  const diff = diffLines('a\nb\n', 'a\nb');
  assert.equal(diff.additions, 1);
  assert.equal(diff.deletions, 1);
  const last = diff.hunks[0].lines[diff.hunks[0].lines.length - 1];
  assert.equal(last.kind, 'add');
  assert.equal(last.noNewline, true);
});

test('an added line at the end without a trailing newline carries the flag', () => {
  const diff = diffLines('a\n', 'a\nb');
  assert.equal(diff.additions, 1);
  assert.equal(diff.deletions, 0);
  const added = diff.hunks[0].lines.find((line) => line.kind === 'add');
  assert.ok(added);
  assert.equal(added.noNewline, true);
});

test('a created file diffs from empty with a zeroed old range', () => {
  const diff = diffLines('', 'line one\nline two\n');
  assert.equal(diff.hunks[0].header, '@@ -0,0 +1,2 @@');
  assert.equal(diff.additions, 2);
  assert.equal(diff.deletions, 0);
});

test('a deleted file diffs to empty with a zeroed new range', () => {
  const diff = diffLines('line one\nline two\n', '');
  assert.equal(diff.hunks[0].header, '@@ -1,2 +0,0 @@');
  assert.equal(diff.deletions, 2);
  assert.equal(diff.additions, 0);
});

test('two distant changes become two hunks with their own ids', () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const after = before.replace('line 1\n', 'changed one\n').replace('line 25\n', 'changed two\n');
  const diff = diffLines(before, after);
  assert.equal(diff.hunks.length, 2);
  assert.notEqual(diff.hunks[0].id, diff.hunks[1].id);
});

test('nearby changes merge into one hunk', () => {
  const before = 'a\nb\nc\nd\n';
  const after = 'A\nb\nc\nD\n';
  const diff = diffLines(before, after);
  assert.equal(diff.hunks.length, 1);
});

test('the same inputs produce byte-identical output across runs', () => {
  const before = 'one\ntwo\nthree\nfour\nfive\n';
  const after = 'one\nTWO\nthree\nfour\nFIVE\nsix\n';
  const first = JSON.stringify(diffLines(before, after, 'x.ts'));
  const second = JSON.stringify(diffLines(before, after, 'x.ts'));
  assert.equal(first, second);
});

test('an unchanged file has no hunks and zero counts', () => {
  const diff = diffLines('same\ncontent\n', 'same\ncontent\n');
  assert.deepEqual(diff.hunks, []);
  assert.equal(diff.additions, 0);
  assert.equal(diff.deletions, 0);
});

test('an empty-to-empty diff is empty', () => {
  const diff = diffLines('', '');
  assert.deepEqual(diff.hunks, []);
});

test('hunk ids are stable across runs and differ by content', () => {
  const a = diffLines('a\n', 'a\nb\n').hunks[0].id;
  const b = diffLines('a\n', 'a\nb\n').hunks[0].id;
  const c = diffLines('a\n', 'a\nc\n').hunks[0].id;
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('added and removed counts cover every hunk of a multi-hunk diff', () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n') + '\n';
  const after = before.replace('l0\n', 'X\n').replace('l19\n', 'Y\nZ\n');
  const diff = diffLines(before, after);
  const added = diff.hunks.reduce((sum, hunk) => sum + hunk.additions, 0);
  const removed = diff.hunks.reduce((sum, hunk) => sum + hunk.deletions, 0);
  assert.equal(diff.additions, added);
  assert.equal(diff.deletions, removed);
  assert.equal(diff.additions, 3);
  assert.equal(diff.deletions, 2);
});

test('rejecting a hunk reverses only that hunk and leaves the rest applied', () => {
  const before = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') + '\n';
  const after = before.replace('l1\n', 'changed1\n').replace('l25\n', 'changed2\n');
  const diff = diffLines(before, after);
  assert.equal(diff.hunks.length, 2);
  const result = applyRejectedHunks(before, after, new Set([diff.hunks[0].id]));
  assert.match(result, /l1\n/);
  assert.match(result, /changed2\n/);
  assert.doesNotMatch(result, /changed1\n/);
});

test('rejecting every hunk returns the pre-turn spelling', () => {
  const before = 'a\nb\nc\nd\ne\n';
  const after = 'a\nB\nc\nD\ne\n';
  const diff = diffLines(before, after);
  assert.equal(diff.hunks.length, 1);
  const result = applyRejectedHunks(before, after, new Set([diff.hunks[0].id]));
  assert.equal(result, before);
});

test('rejecting no hunk returns the post-turn content unchanged', () => {
  const before = 'a\nb\n';
  const after = 'a\nX\nb\n';
  assert.equal(applyRejectedHunks(before, after, new Set()), after);
});

test('reverse-application preserves a CRLF line ending in the restored side', () => {
  const before = 'a\r\nb\r\nc\r\n';
  const after = 'a\r\nB\r\nc\r\n';
  const diff = diffLines(before, after);
  const result = applyRejectedHunks(before, after, new Set([diff.hunks[0].id]));
  assert.equal(result, before);
});
