import test from 'node:test';
import assert from 'node:assert/strict';
import { ChangeJournal, type JournalFs, type JournalStorage } from './journal.ts';
import { ChangeStore } from './changeStore.ts';
import { CheckpointStore } from './checkpoint.ts';

/**
 * A fake shared by the journal fs seam and the workspace fs seam, so a checkpoint
 * restore is driven end to end without a host. `failWrites` models a read-only
 * workspace and `failBlobs` a journal store that cannot persist a snapshot.
 */
class FakeFs implements JournalFs {
  files = new Map<string, Uint8Array>();
  blobs = new Map<string, Uint8Array>();
  writes = 0;
  failWrites = false;
  failBlobs = false;
  private readonly roots: string[];

  constructor(roots: string[] = ['/ws']) {
    this.roots = roots;
  }

  workspaceRoots(): readonly string[] {
    return this.roots;
  }

  async readFile(absPath: string): Promise<Uint8Array | undefined> {
    return this.files.get(normalize(absPath));
  }

  async writeFile(absPath: string, bytes: Uint8Array): Promise<void> {
    if (this.failWrites) {
      throw new Error('disk is read-only');
    }
    this.writes += 1;
    this.files.set(normalize(absPath), bytes);
  }

  async deleteFile(absPath: string): Promise<void> {
    if (this.failWrites) {
      throw new Error('disk is read-only');
    }
    this.writes += 1;
    this.files.delete(normalize(absPath));
  }

  async writeBlob(key: string, bytes: Uint8Array): Promise<void> {
    if (this.failBlobs) {
      throw new Error('snapshot store unavailable');
    }
    this.blobs.set(key, bytes);
  }

  async readBlob(key: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(key);
  }

  async deleteBlob(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}

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

function normalize(path: string): string {
  return path.replace(/\\/g, '/');
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(bytes: Uint8Array | undefined): string {
  return bytes ? new TextDecoder().decode(bytes) : '';
}

interface Harness {
  fs: FakeFs;
  journal: ChangeJournal;
  decisions: ChangeStore;
  checkpoints: CheckpointStore;
}

/** Build a harness with a deterministic id source so undo point ids are stable. */
function harness(fs = new FakeFs()): Harness {
  let counter = 0;
  const seam = storage();
  const journal = new ChangeJournal({ storage: seam, fs, now: () => 1_000 });
  const decisions = new ChangeStore({ storage: seam, fs, artifacts: journal, now: () => 1_000 });
  const checkpoints = new CheckpointStore({
    artifacts: journal,
    fs,
    decisions,
    newId: () => `undo-${(counter += 1)}`,
    now: () => 1_000
  });
  return { fs, journal, decisions, checkpoints };
}

/**
 * Record one turn: snapshot candidates as they are now, mutate the files, close
 * the turn, and return the message id used. Mirrors the host's lifecycle.
 */
async function turn(
  h: Harness,
  opts: {
    turnId: string;
    messageId: string;
    before: Record<string, string>;
    after: Record<string, string>;
    create?: string[];
    delete?: string[];
  }
): Promise<void> {
  const candidates = Object.keys(opts.before).map((rel) => `/ws/${rel}`);
  for (const [rel, content] of Object.entries(opts.before)) {
    h.fs.files.set(`/ws/${rel}`, text(content));
  }
  await h.journal.beginTurn({
    turnId: opts.turnId,
    threadId: 'thr',
    backendId: 'codex',
    messageId: opts.messageId,
    candidates
  });
  for (const [rel, content] of Object.entries(opts.after)) {
    h.fs.files.set(`/ws/${rel}`, text(content));
  }
  for (const rel of opts.create ?? []) {
    h.fs.files.set(`/ws/${rel}`, text('created by turn'));
  }
  for (const rel of opts.delete ?? []) {
    h.fs.files.delete(`/ws/${rel}`);
  }
  await h.journal.endTurn(opts.turnId, [...(opts.create ?? []).map((rel) => `/ws/${rel}`)]);
}

test('a checkpoint exists for a message whose turn touched files and none for an empty turn', async () => {
  const h = harness();
  await turn(h, {
    turnId: 't1',
    messageId: 'm1',
    before: { 'a.ts': 'a1\n' },
    after: { 'a.ts': 'a2\n' }
  });
  // A turn that touches nothing must not be offered as a checkpoint.
  await h.journal.beginTurn({ turnId: 't2', threadId: 'thr', backendId: 'codex', messageId: 'm2' });
  await h.journal.endTurn('t2');

  const checkpoints = await h.checkpoints.listCheckpoints('thr');
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].messageId, 'm1');
  assert.equal(checkpoints[0].fileCount, 1);
  assert.deepEqual(checkpoints[0].paths, ['a.ts']);
});

test('restoring a checkpoint returns every affected file to its checkpoint content, by hash', async () => {
  const h = harness();
  await turn(h, {
    turnId: 't1',
    messageId: 'm1',
    before: { 'a.ts': 'one\n', 'b.ts': 'bee\n' },
    after: { 'a.ts': 'two\n', 'b.ts': 'BEE\n' }
  });

  const result = await h.checkpoints.restore({ backendId: 'codex', threadId: 'thr', messageId: 'm1' });
  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.equal(decode(h.fs.files.get('/ws/a.ts')), 'one\n');
  assert.equal(decode(h.fs.files.get('/ws/b.ts')), 'bee\n');
});

test('a restore reverts files touched by later turns too, back to the checkpoint', async () => {
  const h = harness();
  await turn(h, {
    turnId: 't1',
    messageId: 'm1',
    before: { 'a.ts': 'v1\n' },
    after: { 'a.ts': 'v2\n' }
  });
  // A later turn at the same message's thread further edits the file.
  await h.journal.beginTurn({ turnId: 't2', threadId: 'thr', backendId: 'codex', messageId: 'm2', candidates: ['/ws/a.ts'] });
  h.fs.files.set('/ws/a.ts', text('v3\n'));
  await h.journal.endTurn('t2');

  const result = await h.checkpoints.restore({ backendId: 'codex', threadId: 'thr', messageId: 'm1' });
  assert.equal(result.ok, true);
  // The earliest affected turn's before side is the checkpoint content.
  assert.equal(decode(h.fs.files.get('/ws/a.ts')), 'v1\n');
});

test('restoring a checkpoint that created a file removes it', async () => {
  const h = harness();
  await h.journal.beginTurn({ turnId: 't1', threadId: 'thr', backendId: 'codex', messageId: 'm1' });
  h.fs.files.set('/ws/new.ts', text('brand new\n'));
  await h.journal.observe('t1', '/ws/new.ts', 'reported', 'created');
  await h.journal.endTurn('t1');

  const result = await h.checkpoints.restore({ backendId: 'codex', threadId: 'thr', messageId: 'm1' });
  assert.equal(result.ok, true);
  assert.equal(h.fs.files.has('/ws/new.ts'), false);
});

test('a restore is undoable: the pre-restore snapshot exists and a second restore returns to it', async () => {
  const h = harness();
  await turn(h, {
    turnId: 't1',
    messageId: 'm1',
    before: { 'a.ts': 'checkpoint\n' },
    after: { 'a.ts': 'edited\n' }
  });

  const first = await h.checkpoints.restore({ backendId: 'codex', threadId: 'thr', messageId: 'm1' });
  assert.equal(first.ok, true);
  assert.ok(first.undoPointId, 'the restore captures an undo point');
  assert.equal(decode(h.fs.files.get('/ws/a.ts')), 'checkpoint\n');

  const undo = await h.checkpoints.restore({
    backendId: 'codex',
    threadId: 'thr',
    restorePointId: first.undoPointId as string
  });
  assert.equal(undo.ok, true);
  assert.equal(decode(h.fs.files.get('/ws/a.ts')), 'edited\n');
});

test('if the pre-restore snapshot cannot be written, no file is modified and the failure is reported', async () => {
  const h = harness();
  await turn(h, {
    turnId: 't1',
    messageId: 'm1',
    before: { 'a.ts': 'checkpoint\n' },
    after: { 'a.ts': 'edited\n' }
  });

  h.fs.failBlobs = true;
  const result = await h.checkpoints.restore({ backendId: 'codex', threadId: 'thr', messageId: 'm1' });
  assert.equal(result.aborted, true);
  assert.equal(result.ok, false);
  assert.match(result.message, /No file was changed/);
  // The workspace content must be exactly as it was before the attempt.
  assert.equal(decode(h.fs.files.get('/ws/a.ts')), 'edited\n');
});

test('a file edited outside the agent is a conflict, left unchanged, unless overwrite is explicit', async () => {
  const h = harness();
  await turn(h, {
    turnId: 't1',
    messageId: 'm1',
    before: { 'a.ts': 'checkpoint\n' },
    after: { 'a.ts': 'edited\n' }
  });
  // The user edits the file again outside the agent.
  h.fs.files.set('/ws/a.ts', text('user edit\n'));

  const blocked = await h.checkpoints.restore({ backendId: 'codex', threadId: 'thr', messageId: 'm1' });
  assert.equal(blocked.hasConflicts, true);
  assert.equal(blocked.partial, true);
  assert.equal(blocked.ok, false);
  const conflict = blocked.results.find((entry) => entry.relPath === 'a.ts');
  assert.equal(conflict?.outcome, 'conflict');
  assert.equal(decode(h.fs.files.get('/ws/a.ts')), 'user edit\n');

  const overwritten = await h.checkpoints.restore({
    backendId: 'codex',
    threadId: 'thr',
    messageId: 'm1',
    conflictResolution: 'overwrite-checkpoint'
  });
  assert.equal(overwritten.ok, true);
  assert.equal(decode(h.fs.files.get('/ws/a.ts')), 'checkpoint\n');
});

test('a partial failure reports which paths failed and is not presented as fully successful', async () => {
  const h = harness();
  await turn(h, {
    turnId: 't1',
    messageId: 'm1',
    before: { 'a.ts': 'a-cp\n', 'b.ts': 'b-cp\n' },
    after: { 'a.ts': 'a-edit\n', 'b.ts': 'b-edit\n' }
  });

  h.fs.failWrites = true;
  const result = await h.checkpoints.restore({ backendId: 'codex', threadId: 'thr', messageId: 'm1' });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((entry) => entry.outcome === 'failed'));
  assert.match(result.message, /partial/);
  // The files must be untouched after a failed write.
  assert.equal(decode(h.fs.files.get('/ws/a.ts')), 'a-edit\n');
});

test('review decisions for affected turns are invalidated after a restore', async () => {
  const h = harness();
  await turn(h, {
    turnId: 't1',
    messageId: 'm1',
    before: { 'a.ts': 'cp\n' },
    after: { 'a.ts': 'edit\n' }
  });
  await h.decisions.decide({
    backendId: 'codex',
    threadId: 'thr',
    turnId: 't1',
    relPath: 'a.ts',
    decision: 'accepted'
  });
  assert.equal((await h.decisions.view('codex', 'thr', 't1'))?.files[0].decision, 'accepted');

  await h.checkpoints.restore({ backendId: 'codex', threadId: 'thr', messageId: 'm1' });

  // No stale accepted/rejected decision may remain attached to superseded content.
  assert.equal((await h.decisions.view('codex', 'thr', 't1'))?.files[0].decision, 'pending');
});

test('an unknown checkpoint is reported and nothing is written', async () => {
  const h = harness();
  h.fs.files.set('/ws/a.ts', text('untouched\n'));
  const result = await h.checkpoints.restore({ backendId: 'codex', threadId: 'thr', messageId: 'missing' });
  assert.equal(result.aborted, true);
  assert.equal(result.fileCount, 0);
  assert.equal(decode(h.fs.files.get('/ws/a.ts')), 'untouched\n');
});

test('a file already at its checkpoint content is a verified no-op, not a failure', async () => {
  const h = harness();
  await turn(h, {
    turnId: 't1',
    messageId: 'm1',
    before: { 'a.ts': 'cp\n' },
    after: { 'a.ts': 'edit\n' }
  });
  // Put the file back to the checkpoint content by hand.
  h.fs.files.set('/ws/a.ts', text('cp\n'));

  const result = await h.checkpoints.restore({ backendId: 'codex', threadId: 'thr', messageId: 'm1' });
  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.equal(result.results[0].outcome, 'reverted');
});
