import test from 'node:test';
import assert from 'node:assert/strict';
import {
  changesFromApplyPatch,
  changesFromPatchUpdated,
  changesFromThreadItem
} from './reportedChanges.ts';
import type { ApplyPatchApprovalParams } from '../../../schemas/ApplyPatchApprovalParams';
import type { FileChangePatchUpdatedNotification } from '../../../schemas/v2/FileChangePatchUpdatedNotification';
import type { FileUpdateChange } from '../../../schemas/v2/FileUpdateChange';

/**
 * The Codex content mapping. Absolute paths are used throughout so the payload
 * shape is what is asserted, not the host's path separator.
 */

const ORIGIN = process.platform === 'win32' ? 'C:\\ws' : '/ws';
const abs = (name: string): string => (process.platform === 'win32' ? `C:\\ws\\${name}` : `/ws/${name}`);

function applyPatch(fileChanges: ApplyPatchApprovalParams['fileChanges']): ApplyPatchApprovalParams {
  return { conversationId: 'conv_1', callId: 'call_1', fileChanges, reason: null, grantRoot: null };
}

test('an apply-patch add maps to a created reported change', () => {
  const changes = changesFromApplyPatch(
    applyPatch({ [abs('new.ts')]: { type: 'add', content: 'hi' } }),
    ORIGIN
  );
  assert.equal(changes.length, 1);
  assert.equal(changes[0].absPath, abs('new.ts'));
  assert.equal(changes[0].status, 'created');
});

test('an apply-patch delete maps to a deleted reported change', () => {
  const changes = changesFromApplyPatch(
    applyPatch({ [abs('gone.ts')]: { type: 'delete', content: 'bye' } }),
    ORIGIN
  );
  assert.deepEqual(changes, [{ absPath: abs('gone.ts'), status: 'deleted' }]);
});

test('an apply-patch update maps to a modified reported change', () => {
  const changes = changesFromApplyPatch(
    applyPatch({ [abs('edit.ts')]: { type: 'update', unified_diff: '@@', move_path: null } }),
    ORIGIN
  );
  assert.deepEqual(changes, [{ absPath: abs('edit.ts'), status: 'modified' }]);
});

test('an apply-patch move reports both the old delete and the new path', () => {
  const changes = changesFromApplyPatch(
    applyPatch({ [abs('old.ts')]: { type: 'update', unified_diff: '', move_path: abs('renamed.ts') } }),
    ORIGIN
  );
  assert.deepEqual(changes, [
    { absPath: abs('old.ts'), status: 'deleted' },
    { absPath: abs('renamed.ts'), status: 'modified' }
  ]);
});

test('a relative apply-patch path is resolved against the origin', () => {
  const changes = changesFromApplyPatch(
    applyPatch({ 'src/rel.ts': { type: 'add', content: '' } }),
    ORIGIN
  );
  const expected = process.platform === 'win32' ? 'C:\\ws\\src\\rel.ts' : '/ws/src/rel.ts';
  assert.equal(changes[0].absPath, expected);
});

test('a missing fileChanges map yields no changes rather than throwing', () => {
  assert.deepEqual(changesFromApplyPatch(applyPatch({}), ORIGIN), []);
});

test('a patchUpdated notification maps each change kind', () => {
  const notification: FileChangePatchUpdatedNotification = {
    threadId: 'thr',
    turnId: 'turn',
    itemId: 'item',
    changes: [
      { path: abs('a.ts'), kind: { type: 'add' }, diff: '' },
      { path: abs('b.ts'), kind: { type: 'delete' }, diff: '' },
      { path: abs('c.ts'), kind: { type: 'update', move_path: null }, diff: '' }
    ]
  };
  assert.deepEqual(changesFromPatchUpdated(notification, ORIGIN), [
    { absPath: abs('a.ts'), status: 'created' },
    { absPath: abs('b.ts'), status: 'deleted' },
    { absPath: abs('c.ts'), status: 'modified' }
  ]);
});

test('a threaded item change list maps through the same path', () => {
  const changes: FileUpdateChange[] = [{ path: abs('x.ts'), kind: { type: 'update', move_path: null }, diff: '' }];
  assert.deepEqual(changesFromThreadItem(changes, ORIGIN), [{ absPath: abs('x.ts'), status: 'modified' }]);
});

test('an unknown change kind is skipped, not guessed', () => {
  const notification = {
    threadId: 'thr',
    turnId: 'turn',
    itemId: 'item',
    changes: [{ path: abs('z.ts'), kind: { type: 'future-kind' }, diff: '' }]
  } as unknown as FileChangePatchUpdatedNotification;
  assert.deepEqual(changesFromPatchUpdated(notification, ORIGIN), []);
});
