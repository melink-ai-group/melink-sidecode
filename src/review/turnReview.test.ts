import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChangeFileView, ChangeView } from '../changes/changeStore.ts';
import type { TranscriptItem } from '../backends/types.ts';
import { DIFF_REVIEW_FAILURE_NOTICE, type DiffReviewResult } from './diffReview.ts';
import {
  DIFF_REVIEW_NO_REQUEST_NOTICE,
  runTurnDiffReview,
  shouldRunDiffReview,
  turnRequestText,
  type TurnDiffReviewStore
} from './turnReview.ts';

/**
 * A host-free eval fixture for the orchestration seam. The fake store records
 * exactly what the host would persist; the default local runner proves the
 * request-vs-diff fixture finds the one named path the turn skipped and leaves
 * every product file untouched.
 */

function file(path: string): ChangeFileView {
  return {
    absPath: `/w/${path}`,
    path,
    status: 'modified',
    source: 'reported',
    binary: false,
    diffable: true,
    additions: 1,
    deletions: 1,
    decision: 'pending',
    hunks: [
      {
        id: 'hunk_1',
        header: '@@ -1 +1 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        additions: 1,
        deletions: 1,
        lines: [
          { kind: 'del', text: 'old' },
          { kind: 'add', text: 'new' }
        ],
        decision: 'pending'
      }
    ]
  };
}

function view(paths: readonly string[]): ChangeView {
  return {
    backendId: 'codex',
    threadId: 'thread_1',
    turnId: 'turn_1',
    messageId: 'user_1',
    files: paths.map(file),
    additions: paths.length,
    deletions: paths.length,
    fullyDecided: false
  };
}

function fakeStore(): TurnDiffReviewStore & { stored: Map<string, DiffReviewResult> } {
  const stored = new Map<string, DiffReviewResult>();
  return {
    stored,
    async set(backendId, threadId, turnId, result): Promise<void> {
      stored.set(`${backendId}:${threadId}:${turnId}`, result);
    }
  };
}

test('the eval fixture flags the named path the turn did not change and stores it', async () => {
  const store = fakeStore();
  const result = await runTurnDiffReview({
    view: view(['src/a.ts']),
    request: 'Please edit `src/a.ts` and src/b.ts.',
    store
  });

  assert.equal(result.status, 'reviewed');
  assert.deepEqual(result.findings, [
    {
      path: 'src/b.ts',
      line: 1,
      severity: 'warning',
      message: 'The request mentions src/b.ts, but the turn did not change it.'
    }
  ]);
  assert.deepEqual(store.stored.get('codex:thread_1:turn_1'), result);
});

test('the setting gate runs only when enabled and the turn has entries', () => {
  assert.equal(shouldRunDiffReview(false, []), false);
  assert.equal(shouldRunDiffReview(false, [{ path: 'a.ts' }]), false);
  assert.equal(shouldRunDiffReview(true, []), false);
  assert.equal(shouldRunDiffReview(true, [{ path: 'a.ts' }]), true);
});

test('no opening request stores a failed result with a plain notice', async () => {
  const store = fakeStore();
  let runnerCalls = 0;
  const result = await runTurnDiffReview({
    view: view(['src/a.ts']),
    store,
    runner: async () => {
      runnerCalls += 1;
      return [];
    }
  });

  assert.equal(runnerCalls, 0, 'the runner is never called without a request');
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.findings, []);
  assert.equal(result.notice, DIFF_REVIEW_NO_REQUEST_NOTICE);
  assert.equal(store.stored.get('codex:thread_1:turn_1')?.status, 'failed');
});

test('a throwing runner stores the standard failed notice and does not throw', async () => {
  const store = fakeStore();
  const result = await runTurnDiffReview({
    view: view(['src/a.ts']),
    request: 'Please edit src/a.ts.',
    store,
    runner: async () => {
      throw new Error('model unavailable');
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.notice, DIFF_REVIEW_FAILURE_NOTICE);
  assert.equal(store.stored.get('codex:thread_1:turn_1')?.notice, DIFF_REVIEW_FAILURE_NOTICE);
});

test('a store failure never fails the turn or hides the computed result', async () => {
  const result = await runTurnDiffReview({
    view: view(['src/a.ts']),
    request: 'Please edit src/a.ts.',
    store: {
      async set(): Promise<void> {
        throw new Error('workspaceState unavailable');
      }
    }
  });

  assert.equal(result.status, 'no-findings');
});

test('the opening message id wins, and the latest user message is the fallback', () => {
  const transcript: TranscriptItem[] = [
    { id: 'user_0', kind: 'message', role: 'user', text: 'older request' },
    { id: 'assistant_1', kind: 'message', role: 'assistant', text: 'reply' },
    { id: 'user_2', kind: 'message', role: 'user', text: 'newest request' }
  ];

  assert.equal(turnRequestText(transcript, 'user_0'), 'older request');
  assert.equal(turnRequestText(transcript, 'missing'), 'newest request');
  assert.equal(turnRequestText(transcript), 'newest request');
  assert.equal(turnRequestText([{ id: 'assistant_1', kind: 'message', role: 'assistant', text: 'reply' }]), undefined);
});
