import test from 'node:test';
import assert from 'node:assert/strict';
import type { JournalFileEntry, JournalTurn } from './journal.ts';
import { sessionChangeSet } from './sessionFiles.ts';

function file(overrides: Partial<JournalFileEntry> & Pick<JournalFileEntry, 'relPath' | 'status'>): JournalFileEntry {
  return {
    absPath: `/ws/${overrides.relPath}`,
    source: 'reported',
    sizeBytes: 1,
    binary: false,
    inlineable: true,
    hasBefore: overrides.status !== 'created',
    hasAfter: overrides.status !== 'deleted',
    beforeHash: overrides.status === 'created' ? undefined : `before:${overrides.relPath}`,
    afterHash: overrides.status === 'deleted' ? undefined : `after:${overrides.relPath}`,
    beforeKey: overrides.status === 'created' ? undefined : `key-before:${overrides.relPath}`,
    afterKey: overrides.status === 'deleted' ? undefined : `key-after:${overrides.relPath}`,
    ...overrides
  };
}

function turn(turnId: string, files: JournalFileEntry[], observed = true): JournalTurn {
  return {
    turnId,
    threadId: 'thr',
    backendId: 'codex',
    startedAt: Number(turnId.replace(/\D/g, '')) || 1,
    endedAt: 2,
    files,
    bytes: 1,
    observed
  };
}

test('a later step keeps files from earlier steps', () => {
  const session = sessionChangeSet([
    turn('t2', [file({ relPath: 'b.ts', status: 'created' })]),
    turn('t1', [file({ relPath: 'a.ts', status: 'modified' })])
  ]);
  assert.ok(session);
  assert.equal(session.turnId, 't2');
  assert.deepEqual(
    session.files.map((entry) => entry.entry.relPath),
    ['a.ts', 'b.ts']
  );
});

test('a file edited on two steps keeps the first baseline and the latest result', () => {
  const session = sessionChangeSet([
    turn('t2', [
      file({
        relPath: 'a.ts',
        status: 'modified',
        beforeHash: 'two',
        afterHash: 'three',
        beforeKey: 't2-before',
        afterKey: 't2-after'
      })
    ]),
    turn('t1', [
      file({
        relPath: 'a.ts',
        status: 'modified',
        beforeHash: 'one',
        afterHash: 'two',
        beforeKey: 't1-before',
        afterKey: 't1-after'
      })
    ])
  ]);
  assert.equal(session?.files.length, 1);
  const row = session?.files[0];
  assert.equal(row?.entry.beforeHash, 'one');
  assert.equal(row?.entry.afterHash, 'three');
  assert.equal(row?.entry.beforeKey, 't1-before');
  assert.equal(row?.entry.afterKey, 't2-after');
  assert.equal(row?.beforeTurnId, 't1');
  assert.equal(row?.entry.status, 'modified');
});

test('a file created and then edited stays created, with the latest bytes', () => {
  const session = sessionChangeSet([
    turn('t2', [
      file({
        relPath: 'a.ts',
        status: 'modified',
        hasBefore: true,
        beforeHash: 'draft',
        afterHash: 'final',
        beforeKey: 't2-before',
        afterKey: 't2-after'
      })
    ]),
    turn('t1', [file({ relPath: 'a.ts', status: 'created', afterHash: 'draft', afterKey: 't1-after' })])
  ]);
  const row = session?.files[0];
  assert.equal(row?.entry.status, 'created');
  assert.equal(row?.entry.hasBefore, false);
  assert.equal(row?.entry.afterKey, 't2-after');
  assert.equal(row?.beforeTurnId, undefined);
});

test('a file created and then deleted leaves the session', () => {
  const session = sessionChangeSet([
    turn('t2', [file({ relPath: 'a.ts', status: 'deleted', hasBefore: true, beforeHash: 'draft', beforeKey: 't2-before' })]),
    turn('t1', [file({ relPath: 'a.ts', status: 'created', afterHash: 'draft', afterKey: 't1-after' })])
  ]);
  assert.deepEqual(session?.files, []);
  assert.equal(session?.turnId, 't2');
});

test('an edit that a later step reverts is omitted', () => {
  const session = sessionChangeSet([
    turn('t2', [
      file({
        relPath: 'a.ts',
        status: 'modified',
        beforeHash: 'two',
        afterHash: 'one',
        beforeKey: 't2-before',
        afterKey: 't2-after'
      })
    ]),
    turn('t1', [
      file({
        relPath: 'a.ts',
        status: 'modified',
        beforeHash: 'one',
        afterHash: 'two',
        beforeKey: 't1-before',
        afterKey: 't1-after'
      })
    ])
  ]);
  assert.deepEqual(session?.files, []);
});

test('a rename keeps the baseline from the path the session started with', () => {
  const session = sessionChangeSet([
    turn('t2', [
      file({
        relPath: 'b.ts',
        absPath: '/ws/b.ts',
        status: 'renamed',
        renamedFrom: 'a.ts',
        beforeHash: 'two',
        afterHash: 'two',
        beforeKey: 't2-before',
        afterKey: 't2-after'
      })
    ]),
    turn('t1', [
      file({
        relPath: 'a.ts',
        status: 'modified',
        beforeHash: 'one',
        afterHash: 'two',
        beforeKey: 't1-before',
        afterKey: 't1-after'
      })
    ])
  ]);
  const row = session?.files[0];
  assert.equal(row?.entry.relPath, 'b.ts');
  assert.equal(row?.entry.status, 'renamed');
  assert.equal(row?.entry.renamedFrom, 'a.ts');
  assert.equal(row?.entry.beforeKey, 't1-before');
  assert.equal(row?.beforeTurnId, 't1');
  assert.equal(row?.beforeRelPath, 'a.ts');
});

test('ignored directories are not part of the session', () => {
  const session = sessionChangeSet([
    turn('t1', [
      file({ relPath: 'src/app.ts', status: 'modified' }),
      file({ relPath: 'node_modules/pkg/index.js', status: 'created' })
    ])
  ]);
  assert.deepEqual(
    session?.files.map((entry) => entry.entry.relPath),
    ['src/app.ts']
  );
});

test('a later turn that observed nothing does not hide earlier files or invent an empty set', () => {
  const withFiles = sessionChangeSet([
    turn('t2', [], false),
    turn('t1', [file({ relPath: 'a.ts', status: 'modified' })])
  ]);
  assert.equal(withFiles?.turnId, 't1');
  assert.equal(withFiles?.files.length, 1);

  const silent = sessionChangeSet([turn('t2', [], false)]);
  assert.equal(silent, undefined);
});
