import test from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptItem } from './backends/types.ts';
import { extractSidecodeQuestions } from './questions.ts';
import { findFenceQuestionItem, shouldCaptureFenceQuestions } from './questionsCapture.ts';

const items: TranscriptItem[] = [
  { id: 'u1', kind: 'message', role: 'user', text: 'Plan this.' },
  { id: 'a1', kind: 'message', role: 'assistant', text: 'First reply.', status: 'completed' },
  { id: 't1', kind: 'tool', title: 'read' },
  { id: 'a2', kind: 'message', role: 'assistant', text: 'Streaming.', status: 'pending' },
  { id: 'a3', kind: 'message', role: 'assistant', text: 'Older but complete.', status: 'completed' }
];

test('the latest completed assistant message is the capture target', () => {
  assert.equal(findFenceQuestionItem(items)?.id, 'a3');
  const withoutLast = items.slice(0, 3);
  assert.equal(findFenceQuestionItem(withoutLast)?.id, 'a1');
});

test('a live assistant message without a status counts as completed', () => {
  const live: TranscriptItem[] = [{ id: 'a1', kind: 'message', role: 'assistant', text: 'Live.' }];
  assert.equal(findFenceQuestionItem(live)?.id, 'a1');
});

test('an explicit item id wins over the latest message', () => {
  assert.equal(findFenceQuestionItem(items, 'a1')?.id, 'a1');
  assert.equal(findFenceQuestionItem(items, 'missing'), undefined);
});

test('capture happens on item and turn completion or interruption, in agent and plan only', () => {
  for (const mode of ['agent', 'plan'] as const) {
    assert.equal(shouldCaptureFenceQuestions('item/completed', mode), true);
    assert.equal(shouldCaptureFenceQuestions('turn/completed', mode), true);
    assert.equal(shouldCaptureFenceQuestions('turn/interrupted', mode), true);
    assert.equal(shouldCaptureFenceQuestions('item/delta', mode), false);
  }
  assert.equal(shouldCaptureFenceQuestions('item/completed', 'ask'), false);
  assert.equal(shouldCaptureFenceQuestions('turn/completed', 'ask'), false);
  assert.equal(shouldCaptureFenceQuestions('turn/interrupted', 'ask'), false);
});

test('an item-completed capture is not lost when the turn is then interrupted', () => {
  const transcript: TranscriptItem[] = [
    {
      id: 'a1',
      kind: 'message',
      role: 'assistant',
      text: 'Before.\n```sidecode-question\n{"questions":[{"prompt":"Which?","options":["A"]}]}\n```',
      status: 'completed'
    }
  ];
  const capturedAtItem = shouldCaptureFenceQuestions('item/completed', 'agent')
    ? findFenceQuestionItem(transcript, 'a1')
    : undefined;
  assert.equal(capturedAtItem?.id, 'a1');
  const extracted = extractSidecodeQuestions(capturedAtItem?.text ?? '');
  assert.equal(extracted.questions?.length, 1);
  assert.equal(extracted.questions?.[0]?.id, 'q1');
  assert.equal(extracted.text, 'Before.');
  const capturedAtInterrupt = shouldCaptureFenceQuestions('turn/interrupted', 'agent')
    ? findFenceQuestionItem(transcript)
    : undefined;
  assert.equal(capturedAtInterrupt?.id, 'a1');
});
