import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChangeJournal,
  DEFAULT_MAX_INLINE_BYTES,
  type JournalFs,
  type JournalStorage
} from './journal.ts';

/**
 * An in-memory stand-in for `vscode.Memento`, so the index half of the store
 * can be inspected without the host.
 */
function storage(): JournalStorage & { raw: () => unknown } {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback: T): T => (data.has(key) ? (data.get(key) as T) : fallback),
    update: async (key: string, value: unknown): Promise<void> => {
      if (value === undefined) {
        data.delete(key);
      } else {
        data.set(key, value);
      }
    },
    raw: () => data.get('melink.changeJournal')
  };
}

/**
 * A fake filesystem. `files` is the workspace; `blobs` is the journal storage
 * root. Every read/write goes through these maps, mirroring `workspace.fs`.
 */
class FakeFs implements JournalFs {
  files = new Map<string, Uint8Array>();
  blobs = new Map<string, Uint8Array>();
  writes = 0;
  reads = 0;
  private readonly roots: string[];

  constructor(roots: string[] = ['/ws']) {
    this.roots = roots;
  }

  workspaceRoots(): readonly string[] {
    return this.roots;
  }

  async readFile(absPath: string): Promise<Uint8Array | undefined> {
    this.reads += 1;
    return this.files.get(normalize(absPath));
  }

  async writeBlob(key: string, bytes: Uint8Array): Promise<void> {
    this.writes += 1;
    this.blobs.set(key, bytes);
  }

  async readBlob(key: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(key);
  }

  async deleteBlob(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/');
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToText(bytes: Uint8Array | undefined): string | undefined {
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

function journal(fs: FakeFs, storageSeam = storage(), options: Record<string, unknown> = {}): ChangeJournal {
  return new ChangeJournal({ storage: storageSeam, fs, now: () => 1_000, ...options });
}

test('a turn records one entry with per-file before/after hashes and statuses', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('one'));
  const store = journal(fs);

  await store.beginTurn({ turnId: 't1', threadId: 'thr', backendId: 'codex', candidatePaths: ['/ws/a.ts'] });
  fs.files.set('/ws/a.ts', text('two'));
  await store.endTurn('t1');

  const turns = store.listTurns('thr');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turnId, 't1');
  assert.equal(turns[0].backendId, 'codex');
  assert.equal(turns[0].files.length, 1);
  const entry = turns[0].files[0];
  assert.equal(entry.relPath, 'a.ts');
  assert.equal(entry.status, 'modified');
  assert.notEqual(entry.beforeHash, entry.afterHash);
  assert.equal(entry.inlineable, true);
  assert.equal(bytesToText(await store.getBefore('t1', 'a.ts')), 'one');
  assert.equal(bytesToText(await store.getAfter('t1', 'a.ts')), 'two');
});

test('turn metadata lives in workspaceState while content lives in the blob store', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('secret-body-content'));
  const seam = storage();
  const store = journal(fs, seam);

  await store.beginTurn({ turnId: 't1', threadId: 'thr', backendId: 'codex', candidatePaths: ['/ws/a.ts'] });
  fs.files.set('/ws/a.ts', text('changed-body-content'));
  await store.endTurn('t1');

  // The persisted index is serialisable identifiers and hashes only: a grep of
  // the stored value shows no file body.
  const persisted = JSON.stringify(seam.raw());
  assert.doesNotMatch(persisted, /secret-body-content|changed-body-content/);
  assert.match(persisted, /"turnId":"t1"/);
  // The bytes are in the blob store instead.
  assert.equal(fs.blobs.size, 2);
  assert.equal(bytesToText(await store.getAfter('t1', 'a.ts')), 'changed-body-content');
});

test('a no-op turn records an empty files array and writes no blobs', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('same'));
  const store = journal(fs);

  await store.beginTurn({ turnId: 't1', threadId: 'thr', backendId: 'codex', candidatePaths: ['/ws/a.ts'] });
  await store.endTurn('t1');

  const turn = store.getTurn('t1');
  assert.ok(turn);
  assert.deepEqual(turn.files, []);
  assert.equal(turn.bytes, 0);
  assert.equal(fs.blobs.size, 0);
});

test('created, deleted and renamed files each record the correct status', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/gone.ts', text('bye'));
  fs.files.set('/ws/old.ts', text('move-me'));
  const store = journal(fs);

  await store.beginTurn({
    turnId: 't1',
    threadId: 'thr',
    backendId: 'codex',
    candidatePaths: ['/ws/gone.ts', '/ws/old.ts']
  });
  fs.files.delete('/ws/gone.ts');
  fs.files.set('/ws/new.ts', text('hello'));
  fs.files.set('/ws/moved.ts', text('move-me'));
  fs.files.delete('/ws/old.ts');
  await store.endTurn('t1', ['/ws/new.ts', '/ws/moved.ts']);

  const byPath = new Map(store.getTurn('t1')!.files.map((file) => [file.relPath, file]));
  assert.equal(byPath.get('new.ts')?.status, 'created');
  assert.equal(byPath.get('gone.ts')?.status, 'deleted');
  // A rename is matched by hash, not misreported as a delete plus a create.
  const renamed = byPath.get('moved.ts');
  assert.equal(renamed?.status, 'renamed');
  assert.equal(renamed?.renamedFrom, 'old.ts');
  assert.equal(byPath.has('old.ts'), false);
  assert.equal(renamed?.beforeHash, renamed?.afterHash);
});

test('a binary file is recorded but not inlined, and never crashes', async () => {
  const fs = new FakeFs();
  const binary = new Uint8Array([1, 2, 0, 4, 5]);
  fs.files.set('/ws/blob.bin', binary);
  const store = journal(fs);

  await store.beginTurn({ turnId: 't1', threadId: 'thr', backendId: 'codex', candidatePaths: ['/ws/blob.bin'] });
  fs.files.set('/ws/blob.bin', new Uint8Array([1, 2, 0, 9, 5]));
  await store.endTurn('t1');

  const entry = store.getTurn('t1')!.files[0];
  assert.equal(entry.binary, true);
  assert.equal(entry.inlineable, false);
  assert.equal(entry.hasBefore, true);
  assert.equal(entry.hasAfter, true);
  assert.equal(fs.blobs.size, 0);
  assert.equal(await store.getBefore('t1', 'blob.bin'), undefined);
});

test('a file over the size cap is recorded not inline-able without bloating the store', async () => {
  const fs = new FakeFs();
  const big = new Uint8Array(DEFAULT_MAX_INLINE_BYTES + 1).fill(65);
  fs.files.set('/ws/big.txt', big);
  const store = journal(fs);

  await store.beginTurn({ turnId: 't1', threadId: 'thr', backendId: 'codex', candidatePaths: ['/ws/big.txt'] });
  fs.files.set('/ws/big.txt', new Uint8Array(DEFAULT_MAX_INLINE_BYTES + 2).fill(66));
  await store.endTurn('t1');

  const entry = store.getTurn('t1')!.files[0];
  assert.equal(entry.binary, false);
  assert.equal(entry.inlineable, false);
  assert.equal(entry.sizeBytes, big.length + 1);
  assert.equal(fs.blobs.size, 0);
  assert.equal(await store.getAfter('t1', 'big.txt'), undefined);
});

test('a path outside every workspace root is skipped entirely', async () => {
  const fs = new FakeFs(['/ws']);
  fs.files.set('/outside/x.ts', text('nope'));
  const store = journal(fs);

  await store.beginTurn({
    turnId: 't1',
    threadId: 'thr',
    backendId: 'codex',
    candidatePaths: ['/outside/x.ts', '/ws/../elsewhere.ts']
  });
  await store.endTurn('t1', ['/outside/new.ts']);

  const turn = store.getTurn('t1');
  assert.ok(turn);
  assert.deepEqual(turn.files, []);
});

test('reads use the injected fs seam, never a direct node fs', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('x'));
  const store = journal(fs);

  await store.beginTurn({ turnId: 't1', threadId: 'thr', backendId: 'codex', candidatePaths: ['/ws/a.ts'] });
  await store.endTurn('t1');

  assert.ok(fs.reads >= 2);
});

test('unknown turns and files read as undefined instead of throwing', async () => {
  const fs = new FakeFs();
  const store = journal(fs);

  assert.equal(store.getTurn('missing'), undefined);
  assert.equal(await store.getBefore('missing', 'a.ts'), undefined);
  assert.equal(await store.getAfter('missing', 'a.ts'), undefined);
  assert.deepEqual(store.listTurns('nobody'), []);

  await store.beginTurn({ turnId: 't1', threadId: 'thr', backendId: 'codex', candidatePaths: [] });
  await store.endTurn('t1');
  assert.equal(await store.getBefore('t1', 'not-recorded.ts'), undefined);
});

test('pruning keeps the most recent N turns and deletes their blob files', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('v0'));
  const store = journal(fs, storage(), { maxTurns: 3 });

  for (let i = 0; i < 5; i += 1) {
    fs.files.set('/ws/a.ts', text(`v${i}`));
    await store.beginTurn({ turnId: `t${i}`, threadId: 'thr', backendId: 'codex', candidatePaths: ['/ws/a.ts'] });
    fs.files.set('/ws/a.ts', text(`v${i + 1}`));
    await store.endTurn(`t${i}`);
  }

  const turns = store.listTurns('thr');
  assert.equal(turns.length, 3);
  assert.deepEqual(
    turns.map((turn) => turn.turnId),
    ['t4', 't3', 't2']
  );
  assert.equal(store.getTurn('t0'), undefined);
  assert.equal(store.getTurn('t1'), undefined);
  // Each surviving turn kept two blobs and each evicted turn's blobs are gone.
  assert.equal(fs.blobs.size, 6);
  for (const key of fs.blobs.keys()) {
    assert.match(key, /turns\/t[234]\//);
  }
});

test('the on-disk blob budget stays bounded across repeated runs', async () => {
  const fs = new FakeFs();
  const store = journal(fs, storage(), { maxBlobBytes: 200, maxTurns: 100 });

  for (let i = 0; i < 20; i += 1) {
    fs.files.set('/ws/a.ts', new Uint8Array(100).fill(65 + i));
    await store.beginTurn({ turnId: `t${i}`, threadId: 'thr', backendId: 'codex', candidatePaths: ['/ws/a.ts'] });
    fs.files.set('/ws/a.ts', new Uint8Array(100).fill(90));
    await store.endTurn(`t${i}`);
  }

  let total = 0;
  for (const bytes of fs.blobs.values()) {
    total += bytes.length;
  }
  assert.ok(total <= 200, `expected <= 200 bytes, saw ${total}`);
  assert.ok(fs.blobs.size > 0);
});

test('pruning never evicts the turn currently under review', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('v0'));
  const store = journal(fs, storage(), { maxTurns: 2 });

  await store.beginTurn({ turnId: 'review', threadId: 'thr', backendId: 'codex', candidatePaths: ['/ws/a.ts'] });
  fs.files.set('/ws/a.ts', text('reviewed'));
  await store.endTurn('review');
  store.beginReview('review');

  // Push well past the cap; the protected turn must survive with its bytes.
  for (let i = 0; i < 5; i += 1) {
    fs.files.set('/ws/a.ts', text(`v${i}`));
    await store.beginTurn({ turnId: `t${i}`, threadId: 'thr', backendId: 'codex', candidatePaths: ['/ws/a.ts'] });
    fs.files.set('/ws/a.ts', text(`v${i + 1}`));
    await store.endTurn(`t${i}`);
  }

  assert.ok(store.getTurn('review'));
  assert.equal(bytesToText(await store.getAfter('review', 'a.ts')), 'reviewed');

  store.endReview();
  // Once review ends the turn is ordinary and can be pruned like any other.
  await store.beginTurn({ turnId: 'last', threadId: 'thr', backendId: 'codex', candidatePaths: [] });
  await store.endTurn('last');
  assert.equal(store.getTurn('review'), undefined);
});

test('a turn re-opened with the same id replaces its record instead of duplicating', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('one'));
  const store = journal(fs);

  await store.beginTurn({ turnId: 't1', threadId: 'thr', backendId: 'codex', candidatePaths: ['/ws/a.ts'] });
  fs.files.set('/ws/a.ts', text('two'));
  await store.endTurn('t1');
  await store.beginTurn({ turnId: 't1', threadId: 'thr', backendId: 'codex', candidatePaths: ['/ws/a.ts'] });
  fs.files.set('/ws/a.ts', text('three'));
  await store.endTurn('t1');

  assert.equal(store.listTurns('thr').length, 1);
  assert.equal(bytesToText(await store.getAfter('t1', 'a.ts')), 'three');
});

test('a restore point captures content, seals expected hashes, and reads back by path', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('current'));
  const store = journal(fs);

  const point = await store.captureRestorePoint({
    id: 'p1',
    threadId: 'thr',
    backendId: 'codex',
    files: [{ absPath: '/ws/a.ts', relPath: 'a.ts', bytes: text('current') }],
    expectedHashes: { 'a.ts': 'expected-hash' }
  });

  assert.equal(point.files.length, 1);
  assert.equal(point.files[0].sizeBytes, 'current'.length);
  assert.equal(bytesToText(await store.getRestorePointContent('p1', 'a.ts')), 'current');
  assert.equal(store.getRestorePoint('p1')?.files[0].expectedHash, 'expected-hash');

  await store.sealRestorePoint('p1', { 'a.ts': 'later-hash' });
  assert.equal(store.getRestorePoint('p1')?.files[0].expectedHash, 'later-hash');
});

test('a restore point records an absent file as an absence that can be undone', async () => {
  const fs = new FakeFs();
  const store = journal(fs);

  await store.captureRestorePoint({
    id: 'p1',
    threadId: 'thr',
    backendId: 'codex',
    files: [{ absPath: '/ws/new.ts', relPath: 'new.ts' }],
    expectedHashes: {}
  });

  const point = store.getRestorePoint('p1');
  assert.ok(point);
  assert.equal(point.files[0].hash, undefined);
  assert.equal(point.files[0].blobKey, undefined);
  assert.equal(await store.getRestorePointContent('p1', 'new.ts'), undefined);
});

test('a failed restore-point blob write leaves no point recorded', async () => {
  const fs = new FakeFs();
  const store = journal(fs);
  const original = fs.writeBlob.bind(fs);
  fs.writeBlob = async () => {
    throw new Error('snapshot store unavailable');
  };

  await assert.rejects(
    store.captureRestorePoint({
      id: 'p1',
      threadId: 'thr',
      backendId: 'codex',
      files: [{ absPath: '/ws/a.ts', relPath: 'a.ts', bytes: text('x') }],
      expectedHashes: {}
    })
  );
  fs.writeBlob = original;
  assert.equal(store.getRestorePoint('p1'), undefined);
});
