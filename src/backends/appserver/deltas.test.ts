import test from 'node:test';
import assert from 'node:assert/strict';
import { HANDLED_DELTA_METHODS, itemDeltaFor } from './deltas.ts';

test('the current assistant-message delta method is handled', () => {
  // `item/agentMessage/delta` is the stream the installed CLI sends; missing it
  // would complete a turn with an empty transcript.
  assert.equal(HANDLED_DELTA_METHODS.includes('item/agentMessage/delta'), true);
  assert.deepEqual(itemDeltaFor('item/agentMessage/delta', { threadId: 't1', itemId: 'i1', delta: 'Hello' }), {
    threadId: 't1',
    itemId: 'i1',
    delta: 'Hello'
  });
});

test('the reasoning and command delta methods keep working', () => {
  for (const method of [
    'item/reasoning/textDelta',
    'item/reasoning/summaryTextDelta',
    'item/commandExecution/outputDelta'
  ]) {
    assert.equal(HANDLED_DELTA_METHODS.includes(method), true, method);
    assert.deepEqual(itemDeltaFor(method, { threadId: 't', itemId: 'i', delta: 'x' }), {
      threadId: 't',
      itemId: 'i',
      delta: 'x'
    });
  }
});

test('an unknown method yields no delta rather than a corrupt event', () => {
  assert.equal(itemDeltaFor('item/unknown/delta', { threadId: 't', itemId: 'i', delta: 'x' }), undefined);
});

test('a malformed payload yields no delta', () => {
  assert.equal(itemDeltaFor('item/agentMessage/delta', { threadId: 't', itemId: 'i' }), undefined);
  assert.equal(itemDeltaFor('item/agentMessage/delta', { threadId: 't', itemId: 'i', delta: '' }), undefined);
  assert.equal(itemDeltaFor('item/agentMessage/delta', { itemId: 'i', delta: 'x' }), undefined);
  assert.equal(itemDeltaFor('item/agentMessage/delta', undefined), undefined);
});
