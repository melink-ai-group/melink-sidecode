import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChangeFileView, ChangeHunkView, ChangeView } from '../changes/changeStore.ts';
import { REVIEW_HUNK_LINE_LIMIT } from '../changes/reviewLines.ts';
import { DIFF_REVIEW_REQUEST_CHAR_LIMIT, buildTurnDiffReviewInput } from './reviewInput.ts';

/**
 * The input builder is the boundary between the host's full change snapshot and
 * the bounded reviewer prompt. These tests pin that it renders the same 120-line
 * slice as the inline review, bounds the request, and never mutates the view.
 */

function hunk(lines: ChangeHunkView['lines']): ChangeHunkView {
  return {
    id: 'hunk_1',
    header: '@@ -1,2 +1,2 @@',
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 2,
    additions: 1,
    deletions: 1,
    lines,
    decision: 'pending'
  };
}

function file(overrides: Partial<ChangeFileView> = {}): ChangeFileView {
  return {
    absPath: '/w/src/a.ts',
    path: 'src/a.ts',
    status: 'modified',
    source: 'reported',
    binary: false,
    diffable: true,
    additions: 1,
    deletions: 1,
    decision: 'pending',
    hunks: [
      hunk([
        { kind: 'context', text: 'keep' },
        { kind: 'del', text: 'old' },
        { kind: 'add', text: 'new' }
      ])
    ],
    ...overrides
  };
}

function view(files: ChangeFileView[]): ChangeView {
  return {
    backendId: 'codex',
    threadId: 'thread_1',
    turnId: 'turn_1',
    messageId: 'user_1',
    files,
    additions: 1,
    deletions: 1,
    fullyDecided: false
  };
}

test('the input carries the request and a readable unified diff per file', () => {
  const input = buildTurnDiffReviewInput(view([file()]), 'Please change the header.');

  assert.equal(input.request, 'Please change the header.');
  assert.equal(input.files.length, 1);
  assert.equal(input.files[0].path, 'src/a.ts');
  assert.match(input.files[0].diff, /@@ -1,2 \+1,2 @@/);
  assert.match(input.files[0].diff, /-old/);
  assert.match(input.files[0].diff, /\+new/);
});

test('a file with no inline diff still counts as changed in the input', () => {
  const input = buildTurnDiffReviewInput(
    view([
      file({ path: 'assets/logo.png', binary: true, diffable: false, hunks: [] }),
      file({ path: 'src/large.ts', diffable: false, hunks: [] })
    ]),
    'Please update assets/logo.png and src/large.ts.'
  );

  assert.match(input.files[0].diff, /binary file changed/);
  assert.match(input.files[1].diff, /inline diff unavailable/);
});

test('a large file is capped at the same 120 hunk lines the inline review shows', () => {
  const lines = Array.from({ length: REVIEW_HUNK_LINE_LIMIT + 20 }, (_, index) => ({
    kind: 'add' as const,
    text: `line ${index}`
  }));
  const input = buildTurnDiffReviewInput(
    view([file({ hunks: [hunk(lines)], additions: lines.length, deletions: 0 })]),
    'Review the large file.'
  );

  assert.equal(input.files[0].diff.split('\n').filter((line) => line.startsWith('+')).length, REVIEW_HUNK_LINE_LIMIT);
  assert.ok(input.files[0].diff.endsWith('…'));
});

test('a very long request is bounded with a truncation marker', () => {
  const request = 'x'.repeat(DIFF_REVIEW_REQUEST_CHAR_LIMIT + 100);
  const input = buildTurnDiffReviewInput(view([file()]), request);

  assert.equal(input.request.length, DIFF_REVIEW_REQUEST_CHAR_LIMIT);
  assert.ok(input.request.endsWith('…'));
});

test('building the input never mutates the change view', () => {
  const changeView = view([file()]);
  const snapshot = JSON.stringify(changeView);

  buildTurnDiffReviewInput(changeView, 'Please change the header.');

  assert.equal(JSON.stringify(changeView), snapshot);
});
