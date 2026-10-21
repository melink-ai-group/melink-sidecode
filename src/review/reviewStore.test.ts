import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_STORE_KEY, REVIEW_STORE_LIMIT, ReviewStore, reviewStoreKey, type ReviewStoreMemento } from './reviewStore.ts';
import type { DiffReviewResult } from './diffReview.ts';

/**
 * The review store is exercised through a fake memento, never a VS Code host.
 * These tests pin workspace-keyed round-tripping, explicit clearing, and the
 * newest-50 bound that keeps a long-lived workspace from growing forever.
 */

function memento(updateDelayMs = 0): ReviewStoreMemento & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get<T>(key: string): T | undefined {
      return data.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (updateDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, updateDelayMs));
      }
      data.set(key, value);
    }
  };
}

function result(message: string): DiffReviewResult {
  return {
    status: 'reviewed',
    findings: [{ path: 'src/a.ts', line: 1, severity: 'warning', message }]
  };
}

test('a stored review survives a reload and is keyed backend:thread:turn', async () => {
  const storage = memento();
  await new ReviewStore(storage).set('codex', 'thread_1', 'turn_1', result('first'));

  const reloaded = new ReviewStore(storage);
  assert.equal(reviewStoreKey('codex', 'thread_1', 'turn_1'), 'codex:thread_1:turn_1');
  assert.equal(reloaded.get('codex', 'thread_1', 'turn_1')?.findings[0]?.message, 'first');
  assert.equal(reloaded.get('codex', 'thread_1', 'turn_2'), undefined);
  assert.equal(reloaded.get('ollama', 'thread_1', 'turn_1'), undefined);
  assert.ok(storage.data.has(REVIEW_STORE_KEY));
});

test('a stored result is copied, so a caller cannot mutate persisted state', async () => {
  const storage = memento();
  const store = new ReviewStore(storage);
  const stored = result('first');
  await store.set('codex', 'thread_1', 'turn_1', stored);
  stored.findings[0].message = 'mutated';

  const loaded = store.get('codex', 'thread_1', 'turn_1');
  assert.equal(loaded?.findings[0]?.message, 'first');
  assert.notEqual(loaded, stored);
  assert.notEqual(loaded?.findings, stored.findings);
});

test('clear removes one turn and clearAll empties the workspace index', async () => {
  const storage = memento();
  const store = new ReviewStore(storage);
  await store.set('codex', 'thread_1', 'turn_1', result('one'));
  await store.set('codex', 'thread_1', 'turn_2', result('two'));

  await store.clear('codex', 'thread_1', 'turn_1');
  assert.equal(store.get('codex', 'thread_1', 'turn_1'), undefined);
  assert.equal(store.get('codex', 'thread_1', 'turn_2')?.findings[0]?.message, 'two');

  await store.clearAll();
  assert.deepEqual(store.get('codex', 'thread_1', 'turn_2'), undefined);
  assert.deepEqual(storage.data.get(REVIEW_STORE_KEY), {});
});

test('two concurrent set calls both survive the read-modify-write race', async () => {
  const storage = memento(10);
  let now = 1_000;
  const store = new ReviewStore(storage, () => {
    now += 1;
    return now;
  });

  await Promise.all([
    store.set('codex', 'thread_1', 'turn_1', result('first')),
    store.set('codex', 'thread_1', 'turn_2', result('second'))
  ]);

  assert.equal(store.get('codex', 'thread_1', 'turn_1')?.findings[0]?.message, 'first');
  assert.equal(store.get('codex', 'thread_1', 'turn_2')?.findings[0]?.message, 'second');
  const index = storage.data.get(REVIEW_STORE_KEY) as Record<string, unknown>;
  assert.equal(Object.keys(index).length, 2);
});

test('the index keeps only the newest fifty turns', async () => {
  const storage = memento();
  let now = 1_000;
  const store = new ReviewStore(storage, () => now);
  for (let index = 0; index < REVIEW_STORE_LIMIT + 5; index += 1) {
    now += 1;
    await store.set('codex', 'thread_1', `turn_${index}`, result(`message ${index}`));
  }

  assert.equal(store.get('codex', 'thread_1', 'turn_0'), undefined);
  assert.equal(store.get('codex', 'thread_1', 'turn_4'), undefined);
  assert.equal(store.get('codex', 'thread_1', 'turn_5')?.findings[0]?.message, 'message 5');
  const index = storage.data.get(REVIEW_STORE_KEY) as Record<string, unknown>;
  assert.equal(Object.keys(index).length, REVIEW_STORE_LIMIT);
});
