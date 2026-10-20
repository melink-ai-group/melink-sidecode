import test from 'node:test';
import assert from 'node:assert/strict';
import type { Memento } from 'vscode';
import type { PendingQuestion } from './questionStore.ts';
import {
  MAX_PENDING_QUESTIONS,
  PENDING_QUESTIONS_KEY,
  QuestionStore,
  pendingQuestionKey
} from './questionStore.ts';

function fakeMemento(seed?: Record<string, unknown>): { storage: Memento; values: Map<string, unknown> } {
  const values = new Map<string, unknown>(Object.entries(seed ?? {}));
  const storage = {
    get(key: string, fallback?: unknown) {
      return values.has(key) ? values.get(key) : fallback;
    },
    async update(key: string, value: unknown) {
      values.set(key, value);
    },
    keys() {
      return [...values.keys()];
    },
    setKeysForSync() {
      // No sync keys in the fake.
    }
  } as unknown as Memento;
  return { storage, values };
}

function pending(backendId: string, threadId: string, source: 'fence' | 'native' = 'fence'): PendingQuestion {
  return {
    source,
    request: {
      id: `fence_${threadId}`,
      backendId,
      threadId,
      itemId: 'a1',
      strippedText: 'Before.',
      questions: [{ id: 'q1', prompt: 'Which layout?', options: ['Two columns'] }]
    }
  };
}

test('a pending question round-trips by backend and thread', async () => {
  const { storage } = fakeMemento();
  const store = new QuestionStore(storage);
  const card = pending('ollama', 'thread_1');
  await store.set('ollama', 'thread_1', card);
  assert.deepEqual(store.get('ollama', 'thread_1'), card);
  assert.equal(store.get('ollama', 'thread_2'), undefined);
  assert.equal(store.get('codex', 'thread_1'), undefined);
});

test('clearing one thread leaves the others', async () => {
  const { storage } = fakeMemento();
  const store = new QuestionStore(storage);
  await store.set('ollama', 'thread_1', pending('ollama', 'thread_1'));
  await store.set('codex', 'thread_2', pending('codex', 'thread_2', 'native'));
  await store.clear('ollama', 'thread_1');
  assert.equal(store.get('ollama', 'thread_1'), undefined);
  assert.equal(store.get('codex', 'thread_2')?.source, 'native');
});

test('the store is bounded to the most recent conversations', async () => {
  const { storage } = fakeMemento();
  const store = new QuestionStore(storage);
  for (let index = 1; index <= MAX_PENDING_QUESTIONS + 1; index += 1) {
    await store.set('ollama', `thread_${index}`, pending('ollama', `thread_${index}`));
  }
  assert.equal(store.get('ollama', 'thread_1'), undefined);
  assert.equal(store.get('ollama', `thread_${MAX_PENDING_QUESTIONS + 1}`)?.request.threadId, `thread_${MAX_PENDING_QUESTIONS + 1}`);
  const stored = storage.get<Record<string, unknown>>(PENDING_QUESTIONS_KEY, {});
  assert.equal(Object.keys(stored).length, MAX_PENDING_QUESTIONS);
});

test('replacing a thread makes it the newest entry', async () => {
  const { storage } = fakeMemento();
  const store = new QuestionStore(storage, 2);
  await store.set('ollama', 'thread_1', pending('ollama', 'thread_1'));
  await store.set('ollama', 'thread_2', pending('ollama', 'thread_2'));
  await store.set('ollama', 'thread_1', pending('ollama', 'thread_1', 'native'));
  await store.set('ollama', 'thread_3', pending('ollama', 'thread_3'));
  assert.equal(store.get('ollama', 'thread_2'), undefined);
  assert.equal(store.get('ollama', 'thread_1')?.source, 'native');
  assert.equal(store.get('ollama', 'thread_3')?.request.threadId, 'thread_3');
});

test('malformed stored values and mismatched keys are ignored', () => {
  const { storage } = fakeMemento({
    [PENDING_QUESTIONS_KEY]: {
      [pendingQuestionKey('ollama', 'thread_1')]: { source: 'fence', request: { id: 'x' } },
      [pendingQuestionKey('ollama', 'thread_2')]: pending('ollama', 'thread_3')
    }
  });
  const store = new QuestionStore(storage);
  assert.equal(store.get('ollama', 'thread_1'), undefined);
  assert.equal(store.get('ollama', 'thread_2'), undefined);
  assert.equal(store.get('ollama', 'thread_3'), undefined);
});
