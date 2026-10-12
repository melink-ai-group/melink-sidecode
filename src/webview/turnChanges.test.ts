import assert from 'node:assert/strict';
import test from 'node:test';
import { placeTurnChanges } from './turnChanges.ts';

const user = (id: string) => ({ id, kind: 'message', role: 'user' as const });
const reply = (id: string) => ({ id, kind: 'message', role: 'assistant' as const });

test('a turn card follows the last item of the message that opened it', () => {
  const placed = placeTurnChanges(
    [user('u1'), reply('a1'), user('u2'), reply('a2')],
    [
      { turnId: 't1', messageId: 'u1' },
      { turnId: 't2', messageId: 'u2' }
    ],
    []
  );
  assert.deepEqual(placed.afterItem.get('a1')?.map((turn) => turn.turnId), ['t1']);
  assert.deepEqual(placed.afterItem.get('a2')?.map((turn) => turn.turnId), ['t2']);
  assert.deepEqual(placed.unplaced, []);
});

test('a checkpoint links a turn that has no message id of its own', () => {
  const placed = placeTurnChanges(
    [user('u1'), reply('a1')],
    [{ turnId: 't1' }],
    [{ messageId: 'u1', turnId: 't1' }]
  );
  assert.deepEqual(placed.afterItem.get('a1')?.map((turn) => turn.turnId), ['t1']);
});

test('a turn whose message is not on screen yet stays above the composer', () => {
  const placed = placeTurnChanges([reply('a1')], [{ turnId: 't1', messageId: 'u1' }], []);
  assert.equal(placed.afterItem.size, 0);
  assert.deepEqual(placed.unplaced.map((turn) => turn.turnId), ['t1']);
});
