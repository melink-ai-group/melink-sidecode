import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_STORE_KEY,
  CHECK_STORE_LIMIT,
  CheckStore,
  INTERRUPTED_CHECK_REASON,
  checkStoreKey,
  type CheckStoreMemento
} from './checkStore.ts';
import { summarizeChecks, type CheckRunView } from './checks.ts';

class FakeMemento implements CheckStoreMemento {
  readonly data = new Map<string, unknown>();
  writes = 0;

  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Promise<void> {
    this.writes += 1;
    this.data.set(key, value);
    return Promise.resolve();
  }
}

function view(status: CheckRunView['status'], summary = `Checks: ${status}`): CheckRunView {
  return { status, summary, results: [], startedAt: 1, finishedAt: 2 };
}

test('a stored run round-trips and get returns a copy', async () => {
  const memento = new FakeMemento();
  const store = new CheckStore(memento, () => 10);
  const original = summarizeChecks(
    [
      { name: 'typecheck', command: 'npm run typecheck', status: 'passed', durationMs: 5, output: 'ok' }
    ],
    1,
    2
  );
  await store.set('codex', 'thread', 'turn1', original);

  const stored = store.get('codex', 'thread', 'turn1');
  assert.deepEqual(stored, original);
  assert.notEqual(stored, original);
  stored!.results[0]!.status = 'failed';
  assert.equal(store.get('codex', 'thread', 'turn1')?.results[0]?.status, 'passed');
});

test('a run left running is read as skipped with an explicit interruption reason', () => {
  const memento = new FakeMemento();
  const running: CheckRunView = {
    status: 'running',
    summary: 'Checks running…',
    results: [],
    startedAt: 100
  };
  memento.data.set(CHECK_STORE_KEY, {
    [checkStoreKey('codex', 'thread', 'turn')]: {
      backendId: 'codex',
      threadId: 'thread',
      turnId: 'turn',
      view: running,
      updatedAt: 1
    }
  });

  const store = new CheckStore(memento, () => 500);
  const stored = store.get('codex', 'thread', 'turn');
  assert.equal(stored?.status, 'skipped');
  assert.equal(stored?.finishedAt, 500);
  assert.match(stored?.summary ?? '', /interrupted/i);
  assert.ok(
    stored?.results.some(
      (result) => result.status === 'skipped' && result.reason === INTERRUPTED_CHECK_REASON
    )
  );
});

test('a running run that already had results keeps them and adds the interruption row', () => {
  const memento = new FakeMemento();
  memento.data.set(CHECK_STORE_KEY, {
    [checkStoreKey('codex', 'thread', 'turn')]: {
      backendId: 'codex',
      threadId: 'thread',
      turnId: 'turn',
      view: {
        status: 'running',
        summary: 'Checks running…',
        results: [
          { name: 'typecheck', command: 'npm run typecheck', status: 'passed', durationMs: 3 }
        ],
        startedAt: 10
      },
      updatedAt: 1
    }
  });

  const stored = new CheckStore(memento, () => 20).get('codex', 'thread', 'turn');
  assert.equal(stored?.status, 'skipped');
  assert.equal(stored?.results[0]?.status, 'passed');
  assert.equal(stored?.results.at(-1)?.reason, INTERRUPTED_CHECK_REASON);
});

test('the store keeps the newest 50 runs even when sets overlap', async () => {
  const memento = new FakeMemento();
  let clock = 0;
  const store = new CheckStore(memento, () => {
    clock += 1;
    return clock;
  });

  await Promise.all(
    Array.from({ length: CHECK_STORE_LIMIT + 10 }, (_, index) =>
      store.set('codex', 'thread', `turn${index}`, view('passed', `run ${index}`))
    )
  );

  const index = memento.data.get(CHECK_STORE_KEY) as Record<string, unknown>;
  assert.equal(Object.keys(index).length, CHECK_STORE_LIMIT);
  assert.equal(store.get('codex', 'thread', 'turn0'), undefined);
  assert.ok(store.get('codex', 'thread', `turn${CHECK_STORE_LIMIT + 9}`));
});

test('clear removes one run and clearThread removes the thread', async () => {
  const memento = new FakeMemento();
  const store = new CheckStore(memento, () => 1);
  await store.set('codex', 'a', 't1', view('passed'));
  await store.set('codex', 'a', 't2', view('failed'));
  await store.set('codex', 'b', 't3', view('passed'));

  await store.clear('codex', 'a', 't1');
  assert.equal(store.get('codex', 'a', 't1'), undefined);
  assert.ok(store.get('codex', 'a', 't2'));

  await store.clearThread('a');
  assert.equal(store.get('codex', 'a', 't2'), undefined);
  assert.ok(store.get('codex', 'b', 't3'));
});

test('malformed stored entries are dropped without discarding valid neighbours', () => {
  const memento = new FakeMemento();
  memento.data.set(CHECK_STORE_KEY, {
    bad: { backendId: 1, threadId: 't', turnId: 'x' },
    broken: {
      backendId: 'codex',
      threadId: 'thread',
      turnId: 'broken',
      view: { status: 'nonsense', summary: '', results: [], startedAt: 0 },
      updatedAt: 1
    },
    good: {
      backendId: 'codex',
      threadId: 'thread',
      turnId: 'good',
      view: {
        status: 'passed',
        summary: 'Checks: 1 passed',
        results: [
          { name: 'test', command: 'npm test', status: 'passed', durationMs: 2, extra: 'ignored' },
          { name: 'bad', command: 'x', status: 'unknown', durationMs: 1 }
        ],
        startedAt: 5,
        finishedAt: 6
      },
      updatedAt: 2
    }
  });

  const store = new CheckStore(memento, () => 10);
  assert.equal(store.get('codex', 'thread', 'broken'), undefined);
  const good = store.get('codex', 'thread', 'good');
  assert.equal(good?.status, 'passed');
  assert.deepEqual(good?.results.map((result) => result.name), ['test']);
});

test('the store is host-free and has no logging side channel', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const text = await readFile(join(process.cwd(), 'src', 'review', 'checkStore.ts'), 'utf8');
  assert.equal(/\bfrom\s+['"]vscode["']/.test(text), false);
  assert.equal(/\bfrom\s+['"](node:)?(fs|child_process|net|http|https)["']/.test(text), false);
  assert.equal(/\bconsole\./.test(text), false);
});
