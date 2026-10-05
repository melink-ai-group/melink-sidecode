import test from 'node:test';
import assert from 'node:assert/strict';
import { ChangeJournal, type JournalFs, type JournalStorage } from './journal.ts';
import { ChangeTracker, type TurnChangeSet } from './tracker.ts';

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

test('a reported edit is recorded with source reported and the right relPath', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('one'));
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1' });
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

test('a watched modify with no pre-turn snapshot is not a change', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/readme.md', text('hello'));
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1' });
  change.watch('/ws/readme.md', 'modified');
  const set = await change.endTurn();

  assert.ok(set, 'the turn was observed');
  assert.deepEqual(set.entries, []);
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

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1' });
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

  const session = change.sessionFor('thr');
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

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1' });
  fs.files.set('/ws/a.ts', text('two'));
  change.reportChanges([{ absPath: '/ws/a.ts', status: 'modified' }]);
  await change.endTurn();

  const latest = change.latestFor('thr');
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
  const verified = change.latestFor('thr');
  assert.ok(verified, 'an observed no-op is a real, empty set');
  assert.deepEqual(verified.entries, []);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 'silent' });
  await change.endTurn();
  // The latest turn observed nothing, so a reload must not surface a set at all:
  // silence is never repainted as a verified empty change set.
  assert.equal(change.latestFor('thr'), undefined);
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

test('a closed turn id cannot be re-ended and a mismatched id is a no-op', async () => {
  const fs = new FakeFs();
  const change = tracker(fs);

  await change.beginTurn({ backendId: 'codex', threadId: 'thr', turnId: 't1' });
  assert.equal(await change.endTurn('other'), undefined);
  assert.equal(change.isTracking, true, 'a mismatched id leaves the turn open');
});
