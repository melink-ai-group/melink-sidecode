import test from 'node:test';
import assert from 'node:assert/strict';
import { ChangeJournal, type JournalFs, type JournalStorage } from './journal.ts';
import { ChangeStore, dedupeChangeFiles, type ChangeFileView } from './changeStore.ts';

/**
 * A fake that is both the journal's fs seam and the store's workspace fs seam,
 * plus a write counter so "accept never writes" is provable.
 */
class FakeFs implements JournalFs {
  files = new Map<string, Uint8Array>();
  blobs = new Map<string, Uint8Array>();
  writes = 0;
  failWrites = false;
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

/** Record a modified file `/ws/a.ts` from `before` to `after` as turn `t1`. */
async function turnModified(fs: FakeFs, before: string, after: string): Promise<ChangeJournal> {
  fs.files.set('/ws/a.ts', text(before));
  const journal = new ChangeJournal({ storage: storage(), fs, now: () => 1_000 });
  await journal.beginTurn({ turnId: 't1', threadId: 'thr', backendId: 'codex', candidates: ['/ws/a.ts'] });
  fs.files.set('/ws/a.ts', text(after));
  await journal.endTurn('t1');
  return journal;
}

test('duplicate paths collapse to one row', () => {
  const row = (path: string, additions: number, deletions: number, decision: ChangeFileView['decision']): ChangeFileView => ({
    absPath: `/ws/${path}`,
    path,
    status: 'modified',
    source: 'reported',
    binary: false,
    diffable: true,
    additions,
    deletions,
    decision,
    hunks: []
  });
  const files = dedupeChangeFiles([
    row('backend/app/services/board_paths.py', 3, 0, 'pending'),
    row('backend/app/services/board_paths.py', 8, 6, 'accepted'),
    row('frontend/src/components/board/Milestones.tsx', 1, 1, 'accepted'),
    row('frontend/src/components/board/Milestones.tsx', 1, 1, 'accepted')
  ]);
  assert.deepEqual(
    files.map((file) => [file.path, file.additions, file.decision]),
    [
      ['backend/app/services/board_paths.py', 8, 'accepted'],
      ['frontend/src/components/board/Milestones.tsx', 1, 'accepted']
    ]
  );
});

test('every file and hunk defaults to pending with no decision made', async () => {
  const fs = new FakeFs();
  const journal = await turnModified(fs, 'a\nb\nc\n', 'a\nB\nC\n');
  const store = new ChangeStore({ storage: storage(), fs, artifacts: journal, now: () => 1_000 });

  const view = await store.view('codex', 'thr', 't1');
  assert.ok(view);
  assert.equal(view.files.length, 1);
  assert.equal(view.files[0].decision, 'pending');
  assert.ok(view.files[0].hunks.length > 0);
  assert.ok(view.files[0].hunks.every((hunk) => hunk.decision === 'pending'));
  assert.equal(view.fullyDecided, false);
});

test('accept records the decision and writes nothing to the workspace', async () => {
  const fs = new FakeFs();
  const journal = await turnModified(fs, 'a\nb\n', 'a\nB\n');
  const store = new ChangeStore({ storage: storage(), fs, artifacts: journal, now: () => 1_000 });

  const before = fs.writes;
  const result = await store.decide({
    backendId: 'codex',
    threadId: 'thr',
    turnId: 't1',
    relPath: 'a.ts',
    decision: 'accepted'
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision, 'accepted');
  assert.equal(fs.writes, before, 'accept must not write a workspace file');
  assert.equal(decode(fs.files.get('/ws/a.ts')), 'a\nB\n');

  const view = await store.view('codex', 'thr', 't1');
  assert.equal(view?.files[0].decision, 'accepted');
});

test('reject restores the exact pre-turn bytes', async () => {
  const fs = new FakeFs();
  const journal = await turnModified(fs, 'one\ntwo\n', 'one\nTWO\n');
  const store = new ChangeStore({ storage: storage(), fs, artifacts: journal, now: () => 1_000 });

  const result = await store.decide({
    backendId: 'codex',
    threadId: 'thr',
    turnId: 't1',
    relPath: 'a.ts',
    decision: 'rejected'
  });
  assert.equal(result.ok, true);
  assert.equal(decode(fs.files.get('/ws/a.ts')), 'one\ntwo\n');
});

test('rejecting a created file deletes it', async () => {
  const fs = new FakeFs();
  const journal = new ChangeJournal({ storage: storage(), fs, now: () => 1_000 });
  await journal.beginTurn({ turnId: 't1', threadId: 'thr', backendId: 'codex' });
  fs.files.set('/ws/new.ts', text('brand new'));
  await journal.observe('t1', '/ws/new.ts', 'watched', 'created');
  await journal.endTurn('t1');
  const store = new ChangeStore({ storage: storage(), fs, artifacts: journal, now: () => 1_000 });

  const result = await store.decide({
    backendId: 'codex',
    threadId: 'thr',
    turnId: 't1',
    relPath: 'new.ts',
    decision: 'rejected'
  });
  assert.equal(result.ok, true);
  assert.equal(fs.files.has('/ws/new.ts'), false);
});

test('rejecting a deleted file recreates it with the pre-turn bytes', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/gone.ts', text('restore me'));
  const journal = new ChangeJournal({ storage: storage(), fs, now: () => 1_000 });
  await journal.beginTurn({ turnId: 't1', threadId: 'thr', backendId: 'codex', candidates: ['/ws/gone.ts'] });
  fs.files.delete('/ws/gone.ts');
  await journal.endTurn('t1');
  const store = new ChangeStore({ storage: storage(), fs, artifacts: journal, now: () => 1_000 });

  const result = await store.decide({
    backendId: 'codex',
    threadId: 'thr',
    turnId: 't1',
    relPath: 'gone.ts',
    decision: 'rejected'
  });
  assert.equal(result.ok, true);
  assert.equal(decode(fs.files.get('/ws/gone.ts')), 'restore me');
});

test('a file changed after the turn reports a conflict and is not overwritten', async () => {
  const fs = new FakeFs();
  const journal = await turnModified(fs, 'one\ntwo\n', 'one\nTWO\n');
  const store = new ChangeStore({ storage: storage(), fs, artifacts: journal, now: () => 1_000 });

  // The user edits the file again after the turn.
  fs.files.set('/ws/a.ts', text('one\nTWO\nand more\n'));

  const result = await store.decide({
    backendId: 'codex',
    threadId: 'thr',
    turnId: 't1',
    relPath: 'a.ts',
    decision: 'rejected'
  });
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.equal(result.decision, 'pending');
  // The conflict path must leave the on-disk content exactly as it was.
  assert.equal(decode(fs.files.get('/ws/a.ts')), 'one\nTWO\nand more\n');
});

test('an explicit overwrite-pre-turn completes a conflicting reject', async () => {
  const fs = new FakeFs();
  const journal = await turnModified(fs, 'one\ntwo\n', 'one\nTWO\n');
  const store = new ChangeStore({ storage: storage(), fs, artifacts: journal, now: () => 1_000 });
  fs.files.set('/ws/a.ts', text('user edit\n'));

  const result = await store.decide({
    backendId: 'codex',
    threadId: 'thr',
    turnId: 't1',
    relPath: 'a.ts',
    decision: 'rejected',
    conflictResolution: 'overwrite-pre-turn'
  });
  assert.equal(result.ok, true);
  assert.equal(decode(fs.files.get('/ws/a.ts')), 'one\ntwo\n');
});

test('keep-current completes a conflicting reject without writing', async () => {
  const fs = new FakeFs();
  const journal = await turnModified(fs, 'one\ntwo\n', 'one\nTWO\n');
  const store = new ChangeStore({ storage: storage(), fs, artifacts: journal, now: () => 1_000 });
  fs.files.set('/ws/a.ts', text('user edit\n'));

  const before = fs.writes;
  const result = await store.decide({
    backendId: 'codex',
    threadId: 'thr',
    turnId: 't1',
    relPath: 'a.ts',
    decision: 'rejected',
    conflictResolution: 'keep-current'
  });
  assert.equal(result.ok, true);
  assert.equal(result.conflict, true);
  assert.equal(fs.writes, before);
  assert.equal(decode(fs.files.get('/ws/a.ts')), 'user edit\n');
});

test('a failed write is reported and the reject is not recorded', async () => {
  const fs = new FakeFs();
  const journal = await turnModified(fs, 'one\ntwo\n', 'one\nTWO\n');
  const store = new ChangeStore({ storage: storage(), fs, artifacts: journal, now: () => 1_000 });

  fs.failWrites = true;
  const result = await store.decide({
    backendId: 'codex',
    threadId: 'thr',
    turnId: 't1',
    relPath: 'a.ts',
    decision: 'rejected'
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /read-only/);
  assert.equal(result.decision, 'pending');

  // The decision must not survive as rejected: a fresh read still shows pending.
  fs.failWrites = false;
  const view = await store.view('codex', 'thr', 't1');
  assert.equal(view?.files[0].decision, 'pending');
});

test('hunk-level decisions are recorded and reflected per hunk', async () => {
  const fs = new FakeFs();
  const before = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') + '\n';
  const after = before.replace('l1\n', 'changed1\n').replace('l25\n', 'changed2\n');
  const journal = await turnModified(fs, before, after);
  const store = new ChangeStore({ storage: storage(), fs, artifacts: journal, now: () => 1_000 });

  const initial = await store.view('codex', 'thr', 't1');
  assert.ok(initial);
  assert.equal(initial.files[0].hunks.length, 2);
  const firstId = initial.files[0].hunks[0].id;

  const result = await store.decide({
    backendId: 'codex',
    threadId: 'thr',
    turnId: 't1',
    relPath: 'a.ts',
    hunkId: firstId,
    decision: 'rejected'
  });
  assert.equal(result.ok, true);

  const view = await store.view('codex', 'thr', 't1');
  assert.ok(view);
  const decisions = view.files[0].hunks.map((hunk) => hunk.decision);
  assert.deepEqual(decisions, ['rejected', 'pending']);
  // A hunk reject rewrites only that hunk, leaving the other change applied.
  assert.match(decode(fs.files.get('/ws/a.ts')), /changed2\n/);
  assert.match(decode(fs.files.get('/ws/a.ts')), /l1\n/);
  assert.doesNotMatch(decode(fs.files.get('/ws/a.ts')), /changed1\n/);
});

test('a second hunk reject does not read its own earlier reject as a conflict', async () => {
  const fs = new FakeFs();
  const before = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n') + '\n';
  const after = before.replace('l1\n', 'changed1\n').replace('l30\n', 'changed2\n');
  const journal = await turnModified(fs, before, after);
  const store = new ChangeStore({ storage: storage(), fs, artifacts: journal, now: () => 1_000 });

  const initial = await store.view('codex', 'thr', 't1');
  assert.ok(initial);
  assert.equal(initial.files[0].hunks.length, 2);
  const [firstHunk, secondHunk] = initial.files[0].hunks;

  const first = await store.decide({
    backendId: 'codex',
    threadId: 'thr',
    turnId: 't1',
    relPath: 'a.ts',
    hunkId: firstHunk.id,
    decision: 'rejected'
  });
  assert.equal(first.ok, true);

  const second = await store.decide({
    backendId: 'codex',
    threadId: 'thr',
    turnId: 't1',
    relPath: 'a.ts',
    hunkId: secondHunk.id,
    decision: 'rejected'
  });
  assert.equal(second.ok, true, 'the earlier hunk reject is not an external edit');
  assert.equal(second.conflict, undefined);
  assert.equal(decode(fs.files.get('/ws/a.ts')), before);
});

test('hunk-level reject on a created file can clear it entirely', async () => {
  const fs = new FakeFs();
  const journal = new ChangeJournal({ storage: storage(), fs, now: () => 1_000 });
  await journal.beginTurn({ turnId: 't1', threadId: 'thr', backendId: 'codex' });
  fs.files.set('/ws/new.ts', text('line one\nline two\n'));
  await journal.observe('t1', '/ws/new.ts', 'watched', 'created');
  await journal.endTurn('t1');
  const store = new ChangeStore({ storage: storage(), fs, artifacts: journal, now: () => 1_000 });

  const view = await store.view('codex', 'thr', 't1');
  assert.ok(view);
  assert.equal(view.files[0].hunks.length, 1);
  const result = await store.decide({
    backendId: 'codex',
    threadId: 'thr',
    turnId: 't1',
    relPath: 'new.ts',
    hunkId: view.files[0].hunks[0].id,
    decision: 'rejected'
  });
  assert.equal(result.ok, true);
  assert.equal(fs.files.has('/ws/new.ts'), false);
});

test('decisions survive a reload and stale decisions are dropped', async () => {
  const fs = new FakeFs();
  const seam = storage();
  fs.files.set('/ws/a.ts', text('one\n'));
  const journal = new ChangeJournal({ storage: seam, fs, now: () => 1_000 });
  await journal.beginTurn({ turnId: 't1', threadId: 'thr', backendId: 'codex', candidates: ['/ws/a.ts'] });
  fs.files.set('/ws/a.ts', text('one\nTWO\n'));
  await journal.endTurn('t1');

  const store = new ChangeStore({ storage: seam, fs, artifacts: journal, now: () => 1_000 });
  await store.decide({
    backendId: 'codex',
    threadId: 'thr',
    turnId: 't1',
    relPath: 'a.ts',
    decision: 'accepted'
  });

  // A second store over the same storage is a reload: the decision repaints.
  const reloaded = new ChangeStore({ storage: seam, fs, artifacts: journal, now: () => 1_000 });
  const view = await reloaded.view('codex', 'thr', 't1');
  assert.equal(view?.files[0].decision, 'accepted');

  // Re-record the turn with different content: the old decision references
  // content that no longer matches and must be dropped, not shown actionable.
  await journal.beginTurn({ turnId: 't1', threadId: 'thr', backendId: 'codex', candidates: ['/ws/a.ts'] });
  fs.files.set('/ws/a.ts', text('one\nTHREE\n'));
  await journal.endTurn('t1');
  const afterRescan = await reloaded.view('codex', 'thr', 't1');
  assert.equal(afterRescan?.files[0].decision, 'pending');
});

test('decideAll applies to every file and returns each outcome', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('a1\n'));
  fs.files.set('/ws/b.ts', text('b1\n'));
  const journal = new ChangeJournal({ storage: storage(), fs, now: () => 1_000 });
  await journal.beginTurn({
    turnId: 't1',
    threadId: 'thr',
    backendId: 'codex',
    candidates: ['/ws/a.ts', '/ws/b.ts']
  });
  fs.files.set('/ws/a.ts', text('a2\n'));
  fs.files.set('/ws/b.ts', text('b2\n'));
  await journal.endTurn('t1');
  const store = new ChangeStore({ storage: storage(), fs, artifacts: journal, now: () => 1_000 });

  const results = await store.decideAll({
    backendId: 'codex',
    threadId: 'thr',
    turnId: 't1',
    decision: 'rejected'
  });
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.ok));
  assert.equal(decode(fs.files.get('/ws/a.ts')), 'a1\n');
  assert.equal(decode(fs.files.get('/ws/b.ts')), 'b1\n');

  const view = await store.view('codex', 'thr', 't1');
  assert.equal(view?.fullyDecided, true);
});

test('decideAll reports the files whose writes failed', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('a1\n'));
  fs.files.set('/ws/b.ts', text('b1\n'));
  const journal = new ChangeJournal({ storage: storage(), fs, now: () => 1_000 });
  await journal.beginTurn({
    turnId: 't1',
    threadId: 'thr',
    backendId: 'codex',
    candidates: ['/ws/a.ts', '/ws/b.ts']
  });
  fs.files.set('/ws/a.ts', text('a2\n'));
  fs.files.set('/ws/b.ts', text('b2\n'));
  await journal.endTurn('t1');
  const store = new ChangeStore({ storage: storage(), fs, artifacts: journal, now: () => 1_000 });

  fs.failWrites = true;
  const results = await store.decideAll({
    backendId: 'codex',
    threadId: 'thr',
    turnId: 't1',
    decision: 'rejected'
  });
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => !result.ok && result.error));
});

test('a binary file is omitted from the review and undo-all leaves it untouched', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('before\n'));
  const journal = new ChangeJournal({ storage: storage(), fs, now: () => 1_000 });
  await journal.beginTurn({ turnId: 't1', threadId: 'thr', backendId: 'codex', candidates: ['/ws/a.ts'] });
  fs.files.set('/ws/a.ts', text('after\n'));
  fs.files.set('/ws/blob.bin', new Uint8Array([1, 0, 3]));
  await journal.observe('t1', '/ws/blob.bin', 'reported', 'created');
  await journal.endTurn('t1');
  const store = new ChangeStore({ storage: storage(), fs, artifacts: journal, now: () => 1_000 });

  const view = await store.view('codex', 'thr', 't1');
  assert.ok(view);
  assert.deepEqual(view.files.map((file) => file.path), ['a.ts']);
  assert.equal(journal.getTurn('t1')?.files.some((file) => file.relPath === 'blob.bin' && file.binary), true);

  const results = await store.decideAll({
    backendId: 'codex',
    threadId: 'thr',
    turnId: 't1',
    decision: 'rejected'
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].relPath, 'a.ts');
  assert.deepEqual(fs.files.get('/ws/blob.bin'), new Uint8Array([1, 0, 3]));
});

test('a nested gitignore keeps a file out of the review', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/pkg/.gitignore', text('secret.txt\n'));
  const journal = new ChangeJournal({ storage: storage(), fs, now: () => 1_000 });
  await journal.beginTurn({ turnId: 't1', threadId: 'thr', backendId: 'codex' });
  fs.files.set('/ws/pkg/secret.txt', text('hidden'));
  fs.files.set('/ws/pkg/keep.ts', text('kept'));
  await journal.observe('t1', '/ws/pkg/secret.txt', 'watched', 'created');
  await journal.observe('t1', '/ws/pkg/keep.ts', 'watched', 'created');
  await journal.endTurn('t1');
  const store = new ChangeStore({ storage: storage(), fs, artifacts: journal, now: () => 1_000 });

  const view = await store.view('codex', 'thr', 't1');
  assert.ok(view);
  assert.deepEqual(view.files.map((file) => file.path), ['pkg/keep.ts']);
});

test('undoing one turn restores that turn baseline and leaves earlier steps alone', async () => {
  const fs = new FakeFs();
  fs.files.set('/ws/a.ts', text('one\n'));
  const journal = new ChangeJournal({ storage: storage(), fs, now: () => 1_000 });
  await journal.beginTurn({ turnId: 't1', threadId: 'thr', backendId: 'codex', candidates: ['/ws/a.ts'] });
  fs.files.set('/ws/a.ts', text('two\n'));
  await journal.endTurn('t1');

  await journal.beginTurn({ turnId: 't2', threadId: 'thr', backendId: 'codex', candidates: ['/ws/a.ts'] });
  fs.files.set('/ws/a.ts', text('three\n'));
  fs.files.set('/ws/b.ts', text('bee\n'));
  await journal.observe('t2', '/ws/b.ts', 'reported', 'created');
  await journal.endTurn('t2', ['/ws/b.ts']);
  const store = new ChangeStore({ storage: storage(), fs, artifacts: journal, now: () => 1_000 });

  const first = await store.view('codex', 'thr', 't1');
  assert.ok(first);
  assert.deepEqual(first.files.map((file) => file.path), ['a.ts']);

  const second = await store.view('codex', 'thr', 't2');
  assert.ok(second);
  assert.deepEqual(
    second.files.map((file) => file.path).sort(),
    ['a.ts', 'b.ts']
  );
  const edited = second.files.find((file) => file.path === 'a.ts');
  assert.equal(edited?.status, 'modified');
  assert.ok(edited?.hunks.some((hunk) => hunk.lines.some((line) => line.kind === 'del' && line.text === 'two')));
  assert.ok(edited?.hunks.some((hunk) => hunk.lines.some((line) => line.kind === 'add' && line.text === 'three')));

  const rejected = await store.decide({
    backendId: 'codex',
    threadId: 'thr',
    turnId: 't2',
    relPath: 'a.ts',
    decision: 'rejected'
  });
  assert.equal(rejected.ok, true);
  assert.equal(decode(fs.files.get('/ws/a.ts')), 'two\n');
  assert.equal(decode(fs.files.get('/ws/b.ts')), 'bee\n');

  const earlier = await store.view('codex', 'thr', 't1');
  assert.ok(earlier?.files.some((file) => file.path === 'a.ts'));
});

test('unknown turns and unchanged OpenCode reports without a baseline have no review rows', async () => {
  const fs = new FakeFs();
  const saved = storage();
  fs.files.set('/ws/a.ts', text('unchanged\n'));
  const journal = new ChangeJournal({ storage: saved, fs });
  await journal.beginTurn({ turnId: 't1', threadId: 'thr', backendId: 'opencode' });
  await journal.observe('t1', '/ws/a.ts', 'reported', 'modified');
  await journal.endTurn('t1');
  assert.equal(journal.getTurn('t1')?.files[0].hasBefore, false);

  for (const artifacts of [journal, new ChangeJournal({ storage: saved, fs })]) {
    const store = new ChangeStore({ storage: storage(), fs, artifacts });
    const view = await store.view('opencode', 'thr', 't1');
    assert.deepEqual(view?.files, []);
    assert.equal(view?.additions, 0);
    assert.equal(view?.deletions, 0);
    assert.equal(await store.view('opencode', 'thr', 'missing'), undefined);
  }
  assert.equal(fs.writes, 0);
});


test('automatic continuations review and reject the complete user request after reload', async () => {
  const fs = new FakeFs();
  const disk = storage();
  const journal = new ChangeJournal({ storage: disk, fs });
  fs.files.set('/ws/a.ts', text('original\n'));
  await journal.beginTurn({ turnId: 'initial', backendId: 'codex', threadId: 'thr',
    messageId: 'user', requestMessageId: 'user', candidates: ['/ws/a.ts'] });
  fs.files.set('/ws/a.ts', text('first edit\n'));
  await journal.observe('initial', '/ws/a.ts', 'reported', 'modified');
  await journal.endTurn('initial');
  await journal.beginTurn({ turnId: 'correction', backendId: 'codex', threadId: 'thr',
    messageId: 'automatic', requestMessageId: 'user', candidates: ['/ws/a.ts', '/ws/b.ts'] });
  fs.files.set('/ws/a.ts', text('corrected\n'));
  fs.files.set('/ws/b.ts', text('new file\n'));
  await journal.observe('correction', '/ws/a.ts', 'reported', 'modified');
  await journal.observe('correction', '/ws/b.ts', 'reported', 'created');
  await journal.endTurn('correction');
  const restored = new ChangeJournal({ storage: disk, fs });
  const store = new ChangeStore({ storage: disk, fs, artifacts: restored });
  const view = await store.view('codex', 'thr', 'correction');
  assert.equal(view?.messageId, 'user');
  assert.deepEqual(view?.files.map((file) => file.path), ['a.ts', 'b.ts']);
  assert.equal(restored.getTurn('correction')?.messageId, 'automatic', 'checkpoint anchor remains independent');
  const results = await store.decideAll({ backendId: 'codex', threadId: 'thr', turnId: 'correction', decision: 'rejected' });
  assert.ok(results.every((result) => result.ok));
  assert.equal(decode(fs.files.get('/ws/a.ts')), 'original\n');
  assert.equal(fs.files.has('/ws/b.ts'), false);
  await restored.beginTurn({ turnId: 'next', backendId: 'codex', threadId: 'thr', requestMessageId: 'next-user', candidates: ['/ws/a.ts'] });
  fs.files.set('/ws/a.ts', text('next request\n'));
  await restored.observe('next', '/ws/a.ts', 'reported', 'modified');
  await restored.endTurn('next');
  const next = await store.view('codex', 'thr', 'next');
  assert.deepEqual(next?.files.map((file) => file.path), ['a.ts'], 'another user request does not inherit earlier files');
});
