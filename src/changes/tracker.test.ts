import test from 'node:test';
import assert from 'node:assert/strict';
import { ChangeJournal, type JournalFs, type JournalStorage } from './journal.ts';
import { ChangeTracker, type TurnChangeSet } from './tracker.ts';
import { ChangeStore } from './changeStore.ts';
import { ChangeWatchSession } from './watchSession.ts';

function storage(): JournalStorage {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback: T): T => (data.has(key) ? (data.get(key) as T) : fallback),
    update: async (key: string, value: unknown): Promise<void> => {
      if (value === undefined) {
        data.delete(key);
      } else {
        data.set(key, value);
      }
    }
  };
}

class FakeFs implements JournalFs {
  files = new Map<string, Uint8Array>();
  blobs = new Map<string, Uint8Array>();
  private readonly roots: string[];

  constructor(roots: string[] = ['/ws']) {
    this.roots = roots;
  }

  workspaceRoots(): readonly string[] {
    return this.roots;
  }

  async readFile(absPath: string): Promise<Uint8Array | undefined> {
    return this.files.get(absPath.replace(/\\/g, '/'));
  }

  async writeBlob(key: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(key, bytes);
  }

  async readBlob(key: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(key);
  }

  async deleteBlob(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function tracker(fs: FakeFs): ChangeTracker {
  const journal = new ChangeJournal({ storage: storage(), fs, now: () => 1_000 });
  return new ChangeTracker(journal, () => 1_000);
}

test('OpenCode changes and decisions replay all seven files after journal rehydration', async () => {
  const fs = new FakeFs();
  // Clone storage to model a real persisted index, rather than shared objects.
  const backing = storage();
  const disk: JournalStorage = {
    get: <T>(key: string, fallback: T): T => structuredClone(backing.get(key, fallback)),
    update: async (key, value) => backing.update(key, structuredClone(value))
  };
  const paths = Array.from({ length: 7 }, (_, index) => `/ws/src/file${index}.ts`);
  for (const path of paths) fs.files.set(path, text('before\n'));
  const journal = new ChangeJournal({ storage: disk, fs });
  const change = new ChangeTracker(journal);
  await change.beginTurn({ backendId: 'opencode', threadId: 'one', turnId: 't1', messageId: 'u1', candidates: paths });
  const watcher = new ChangeWatchSession({
    workspaceRoots: () => ['/ws'],
    onObserve: (path, status) => change.watch(path, status)
  });
  watcher.observe('/ws/src', 'created'); // A directory event is not a file row.
  for (const path of paths) {
    fs.files.set(path, text('after\n'));
    watcher.observe(path, 'modified');
  }
  // The last writes are still debounced when the provider finishes.
  watcher.flush();
  const live = await change.endTurn('t1');
  watcher.stop();
  assert.equal(live?.entries.length, 7);
  const reloaded = new ChangeJournal({ storage: disk, fs });
  const replay = await new ChangeTracker(reloaded).observedSets('one');
  assert.deepEqual(replay, [live]);
  const review = await new ChangeStore({ storage: disk, fs: {
    readFile: (path) => fs.readFile(path),
    writeFile: async () => { throw new Error('replay must not write'); },
    deleteFile: async () => { throw new Error('replay must not delete'); }
  }, artifacts: reloaded }).view('opencode', 'one', 't1');
  assert.equal(review?.files.length, 7);
  assert.ok(review?.files.every((file) => file.decision === 'pending' && file.additions === 1 && file.deletions === 1));
  assert.deepEqual(await new ChangeTracker(reloaded).observedSets('other'), []);
});

test('duplicate turn start does not replace the original snapshot or message anchor', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('before'));
  const change = tracker(fs);
  await change.beginTurn({ backendId: 'opencode', threadId: 'one', turnId: 't1', messageId: 'u1', candidates: ['/ws/a.ts'] });
  fs.files.set('/ws/a.ts', text('after'));
  await change.beginTurn({ backendId: 'opencode', threadId: 'one', turnId: 't1', candidates: ['/ws/a.ts'] });
  const set = await change.endTurn('t1');
  assert.equal(set?.entries.length, 1);
  assert.equal(set?.messageId, 'u1');
});

test('a reported edit is recorded with source reported and the right relPath', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('one'));
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1', candidates: ['/ws/a.ts'] });
  fs.files.set('/ws/a.ts', text('two'));
  change.reportChanges([{ absPath: '/ws/a.ts', status: 'modified' }]);
  const set = await change.endTurn();

  assert.ok(set);
  assert.equal(set.entries.length, 1);
  assert.equal(set.entries[0].path, 'a.ts');
  assert.equal(set.entries[0].status, 'modified');
  assert.equal(set.entries[0].source, 'reported');
});

test('a watched modify of a snapshotted file is recorded when the bytes change', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/fmt.ts', text('before'));
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1', candidates: ['/ws/fmt.ts'] });
  fs.files.set('/ws/fmt.ts', text('after'));
  change.watch('/ws/fmt.ts', 'modified');
  const set = await change.endTurn();

  assert.ok(set);
  assert.equal(set.entries[0].path, 'fmt.ts');
  assert.equal(set.entries[0].source, 'watched');
  assert.equal(set.entries[0].status, 'modified');
});

test('a watched modify with no pre-turn snapshot is hidden', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/readme.md', text('hello'));
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1' });
  fs.files.set('/ws/readme.md', text('hello\nmore'));
  change.watch('/ws/readme.md', 'modified');
  const set = await change.endTurn();

  assert.ok(set, 'the turn was observed');
  assert.deepEqual(set.entries, []);
  assert.deepEqual((await change.sessionFor('thr'))?.entries, []);
});

test('build output is not attributed to the turn', async () => {
  const fs = new FakeFs();
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1' });
  fs.files.set('/ws/frontend/dist/assets/index.js', text('bundle'));
  fs.files.set('/ws/frontend/src/Card.tsx', text('export function Card() {}'));
  change.watch('/ws/frontend/dist/assets/index.js', 'created');
  change.watch('/ws/frontend/src/Card.tsx', 'created');
  const set = await change.endTurn();

  assert.ok(set);
  assert.deepEqual(
    set.entries.map((entry) => entry.path),
    ['frontend/src/Card.tsx']
  );
});

test('files under ignored directories are not attributed to the turn', async () => {
  const fs = new FakeFs();
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'ollama', threadId: 'thr', turnId: 't1' });
  fs.files.set('/ws/.opencode/bun.lock', text('lock'));
  fs.files.set('/ws/.opencode/node_modules/pkg/index.js', text('pkg'));
  fs.files.set('/ws/node_modules/left-pad/index.js', text('pad'));
  fs.files.set('/ws/src/app.ts', text('export {};'));
  change.watch('/ws/.opencode/bun.lock', 'created');
  change.watch('/ws/.opencode/node_modules/pkg/index.js', 'created');
  change.watch('/ws/node_modules/left-pad/index.js', 'created');
  change.watch('/ws/src/app.ts', 'created');
  const set = await change.endTurn();

  assert.ok(set);
  assert.deepEqual(
    set.entries.map((entry) => entry.path),
    ['src/app.ts']
  );
});

test('a root gitignore excludes matching creates', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/.gitignore', text('dist/\n'));
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1' });
  fs.files.set('/ws/dist/app.js', text('bundle'));
  fs.files.set('/ws/src/app.ts', text('source'));
  change.watch('/ws/dist/app.js', 'created');
  change.watch('/ws/src/app.ts', 'created');
  const set = await change.endTurn();

  assert.ok(set);
  assert.deepEqual(
    set.entries.map((entry) => entry.path),
    ['src/app.ts']
  );
});

test('a nested gitignore excludes its own paths and can keep a negated file', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/.gitignore', text('*.log\n'));
  fs.files.set('/ws/pkg/.gitignore', text('secret.txt\n'));
  fs.files.set('/ws/src/.gitignore', text('!keep.log\n'));
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1' });
  fs.files.set('/ws/pkg/secret.txt', text('hidden'));
  fs.files.set('/ws/pkg/keep.ts', text('kept'));
  fs.files.set('/ws/src/keep.log', text('kept log'));
  fs.files.set('/ws/src/other.log', text('hidden log'));
  change.watch('/ws/pkg/secret.txt', 'created');
  change.watch('/ws/pkg/keep.ts', 'created');
  change.watch('/ws/src/keep.log', 'created');
  change.watch('/ws/src/other.log', 'created');
  const set = await change.endTurn();

  assert.ok(set);
  assert.deepEqual(set.entries.map((entry) => entry.path).sort(), ['pkg/keep.ts', 'src/keep.log']);
});

test('a binary file is recorded but omitted from the change list', async () => {
  const fs = new FakeFs();
  const journal = new ChangeJournal({ storage: storage(), fs, now: () => 1_000 });
  const change = new ChangeTracker(journal, () => 1_000);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1' });
  fs.files.set('/ws/blob.bin', new Uint8Array([1, 0, 2]));
  fs.files.set('/ws/src/app.ts', text('source'));
  change.watch('/ws/blob.bin', 'created');
  change.watch('/ws/src/app.ts', 'created');
  const set = await change.endTurn();

  assert.ok(set);
  assert.deepEqual(
    set.entries.map((entry) => entry.path),
    ['src/app.ts']
  );
  assert.equal(journal.getTurn('t1')?.files.some((file) => file.relPath === 'blob.bin' && file.binary), true);
});

test('a file recorded earlier drops off the list once a gitignore excludes it', async () => {
  const fs = new FakeFs();
  const journal = new ChangeJournal({ storage: storage(), fs, now: () => 1_000 });
  const change = new ChangeTracker(journal, () => 1_000);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1' });
  fs.files.set('/ws/notes.txt', text('note'));
  change.watch('/ws/notes.txt', 'created');
  await change.endTurn();
  fs.files.set('/ws/.gitignore', text('notes.txt\n'));

  const session = await change.sessionFor('thr');
  assert.deepEqual(session?.entries ?? [], []);
  assert.equal(journal.getTurn('t1')?.files.some((file) => file.relPath === 'notes.txt'), true);
});

test('a shell-only change first seen after the write is still recorded', async () => {
  // The watcher fires only after the formatter has run: there is no pre-turn
  // snapshot, so the observation itself must be what records the change.
  const fs = new FakeFs();
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1' });
  fs.files.set('/ws/new.ts', text('generated'));
  change.watch('/ws/new.ts', 'created');
  const set = await change.endTurn();

  assert.ok(set);
  assert.equal(set.entries.length, 1);
  assert.equal(set.entries[0].path, 'new.ts');
  assert.equal(set.entries[0].source, 'watched');
  assert.equal(set.entries[0].status, 'created');
});

test('a reported source wins over a watched one for the same path', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('one'));
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1', candidates: ['/ws/a.ts'] });
  change.watch('/ws/a.ts', 'modified');
  fs.files.set('/ws/a.ts', text('two'));
  change.reportChanges([{ absPath: '/ws/a.ts', status: 'modified' }]);
  const set = await change.endTurn();

  assert.ok(set);
  assert.equal(set.entries[0].source, 'reported');
});

test('a turn where nothing is observed records no files and reports undefined', async () => {
  const fs = new FakeFs();
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1' });
  const set = await change.endTurn();

  // `undefined`, not `[]`: silence is not a verified no-op, so no notification
  // is ever fired claiming the agent changed nothing.
  assert.equal(set, undefined);
});

test('a turn that observed but changed nothing yields an empty verified set', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('same'));
  const change = tracker(fs);

  // The path was snapshotted before the turn (a candidate) and watched during
  // it, but its content did not change: this is a real, verified no-op.
  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1', candidates: ['/ws/a.ts'] });
  change.watch('/ws/a.ts', 'modified');
  const set = await change.endTurn();

  assert.ok(set);
  assert.deepEqual(set.entries, []);
});

test('a path outside every workspace root is ignored entirely', async () => {
  const fs = new FakeFs(['/ws']);
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1' });
  fs.files.set('/outside/x.ts', text('nope'));
  change.watch('/outside/x.ts', 'created');
  const set = await change.endTurn();

  // The only observation was out of scope, so nothing was verified.
  assert.equal(set, undefined);
});

test('a report for a path outside the workspace is ignored', async () => {
  const fs = new FakeFs(['/ws']);
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1' });
  fs.files.set('/elsewhere/y.ts', text('nope'));
  change.reportChanges([{ absPath: '/elsewhere/y.ts', status: 'created' }]);
  assert.equal(await change.endTurn(), undefined);
});

test('a report arriving with no active turn is dropped, not attached to a stale turn', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('x'));
  const change = tracker(fs);

  // No beginTurn: the report has nowhere honest to go.
  change.reportChanges([{ absPath: '/ws/a.ts', status: 'modified' }]);
  assert.equal(await change.endTurn(), undefined);
  assert.equal(change.isTracking, false);
});

test('onTurnChanges fires only for an observed turn', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('one'));
  const change = tracker(fs);
  const seen: TurnChangeSet[] = [];
  change.onTurnChanges((set) => seen.push(set));

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 'noop' });
  await change.endTurn();
  assert.equal(seen.length, 0, 'a no-observation turn fires nothing');

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1' });
  fs.files.set('/ws/a.ts', text('two'));
  change.reportChanges([{ absPath: '/ws/a.ts', status: 'modified' }]);
  await change.endTurn();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].turnId, 't1');
});

test('sessionFor keeps every step, not only the latest turn', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('one'));
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1', candidates: ['/ws/a.ts'] });
  fs.files.set('/ws/a.ts', text('two'));
  change.reportChanges([{ absPath: '/ws/a.ts', status: 'modified' }]);
  await change.endTurn();

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't2', candidates: ['/ws/a.ts'] });
  fs.files.set('/ws/b.ts', text('bee'));
  change.reportChanges([{ absPath: '/ws/b.ts', status: 'created' }]);
  await change.endTurn();

  const session = await change.sessionFor('thr');
  assert.ok(session);
  assert.equal(session.turnId, 't2');
  assert.deepEqual(
    session.entries.map((entry) => entry.path).sort(),
    ['a.ts', 'b.ts']
  );
});

test('latestFor returns the recorded set for a reload and skips unobserved turns', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('one'));
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1', candidates: ['/ws/a.ts'] });
  fs.files.set('/ws/a.ts', text('two'));
  change.reportChanges([{ absPath: '/ws/a.ts', status: 'modified' }]);
  await change.endTurn();

  const latest = await change.latestFor('thr');
  assert.ok(latest);
  assert.equal(latest.turnId, 't1');
  assert.equal(latest.entries[0].path, 'a.ts');
});

test('latestFor keeps a verified no-op distinct from no observation', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('same'));
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 'noop', candidates: ['/ws/a.ts'] });
  change.watch('/ws/a.ts', 'modified');
  await change.endTurn();
  const verified = await change.latestFor('thr');
  assert.ok(verified, 'an observed no-op is a real, empty set');
  assert.deepEqual(verified.entries, []);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 'silent' });
  await change.endTurn();
  // The latest turn observed nothing, so a reload must not surface a set at all:
  // silence is never repainted as a verified empty change set.
  assert.equal(await change.latestFor('thr'), undefined);
});

test('a report for a different thread is dropped, not attached to the active turn', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('x'));
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr_active', turnId: 't1' });
  change.reportChanges([{ absPath: '/ws/a.ts', status: 'modified' }], 'thr_background');
  assert.equal(await change.endTurn(), undefined);
});

test('a watcher path outside the workspace is never recorded', async () => {
  const fs = new FakeFs(['/ws']);
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1' });
  fs.files.set('/outside/x.ts', text('nope'));
  change.watch('/outside/x.ts', 'modified');
  assert.equal(await change.endTurn(), undefined);
});

test('two chats can track turns at the same time', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('a'));
  fs.files.set('/ws/b.ts', text('b'));
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'one', turnId: 't1', candidates: ['/ws/a.ts', '/ws/b.ts'] });
  await change.beginTurn({ backendId: 'codex', threadId: 'two', turnId: 't2', candidates: ['/ws/b.ts'] });
  assert.equal(change.isOpen('t1'), true);
  assert.equal(change.isOpen('t2'), true);

  fs.files.set('/ws/b.ts', text('changed'));
  change.reportChanges([{ absPath: '/ws/a.ts', status: 'modified' }], 'one');
  change.watch('/ws/b.ts', 'modified');

  const first = await change.endTurn('t1');
  assert.equal(change.isTracking, true, 'the other chat stays open');
  assert.equal(change.isOpen('t2'), true);
  assert.ok(first);
  assert.deepEqual(first.entries.map((entry) => entry.path), ['b.ts']);

  const second = await change.endTurn('t2');
  assert.equal(change.isTracking, false);
  assert.ok(second);
  assert.deepEqual(second.entries.map((entry) => entry.path), ['b.ts']);
});

test('a new turn on the same chat replaces only that chat', async () => {
  const fs = new FakeFs();
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'one', turnId: 't1' });
  await change.beginTurn({ backendId: 'ollama', threadId: 'two', turnId: 't2' });
  await change.beginTurn({ backendId: 'codex', threadId: 'one', turnId: 't3' });

  assert.equal(change.isOpen('t1'), false);
  assert.equal(change.isOpen('t2'), true);
  assert.equal(change.isOpen('t3'), true);
  assert.equal(await change.endTurn('t1'), undefined);
});

test('a closed turn id cannot be re-ended and a mismatched id is a no-op', async () => {
  const fs = new FakeFs();
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1' });
  assert.equal(await change.endTurn('other'), undefined);
  assert.equal(change.isTracking, true, 'a mismatched id leaves the turn open');
});
