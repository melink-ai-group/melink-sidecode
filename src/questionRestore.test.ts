import test from 'node:test';
import assert from 'node:assert/strict';
import type { PendingQuestion } from './questionStore.ts';
import { NATIVE_QUESTION_LOST, restorePendingQuestion } from './questionRestore.ts';

function pending(source: 'fence' | 'native'): PendingQuestion {
  return {
    source,
    request: {
      id: 'req_1',
      backendId: 'codex',
      threadId: 'thread_1',
      questions: [{ id: 'q1', prompt: 'Which?', options: ['A'] }]
    }
  };
}

test('a fence question is restored after a reload', () => {
  const stored = pending('fence');
  assert.deepEqual(restorePendingQuestion(stored), { kind: 'restore', pending: stored });
});

test('a native question becomes a notice because its request died', () => {
  const restored = restorePendingQuestion(pending('native'));
  assert.equal(restored?.kind, 'notice');
  assert.equal(restored && 'message' in restored ? restored.message : '', NATIVE_QUESTION_LOST);
});

test('no stored question means nothing to do', () => {
  assert.equal(restorePendingQuestion(undefined), undefined);
});
