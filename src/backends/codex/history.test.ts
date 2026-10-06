import test from 'node:test';
import assert from 'node:assert/strict';
import { chronological, cursorsAfterPage, historyCursors, nextOlderQuery } from './history.ts';

test('an item cursor is paged before a turn cursor', () => {
  const query = nextOlderQuery(historyCursors('item-1', 'turn-1'));
  assert.deepEqual(query, { kind: 'items', cursor: 'item-1', limit: 40 });
});

test('turns are paged once the item cursor is gone', () => {
  const query = nextOlderQuery(historyCursors(null, 'turn-1'));
  assert.equal(query?.kind, 'turns');
  assert.equal(query?.cursor, 'turn-1');
});

test('a cursor that does not move is exhausted', () => {
  const next = cursorsAfterPage(historyCursors('item-1', 'turn-1'), 'items', 'item-1', 'item-1');
  assert.equal(next.items, null);
  assert.equal(next.turns, 'turn-1');
  assert.equal(nextOlderQuery(next)?.kind, 'turns');
});

test('a descending page is restored to oldest-first order', () => {
  assert.deepEqual(chronological(['newest', 'older', 'oldest']), ['oldest', 'older', 'newest']);
});
