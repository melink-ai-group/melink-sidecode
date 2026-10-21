import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedQuickTask } from './draft.ts';

const allPassesOff = { testing: false, reviewing: false, doubleCheck: false, quickTask: true };

test('a stored quickTask=true opens clean when every pass is off', () => {
  assert.equal(normalizedQuickTask(allPassesOff), false);
});

test('quickTask stays true only when it is on and a pass can use it', () => {
  assert.equal(normalizedQuickTask({ ...allPassesOff, testing: true }), true);
  assert.equal(normalizedQuickTask({ ...allPassesOff, quickTask: false, reviewing: true }), false);
});
