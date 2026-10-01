import { isAbsolute, resolve } from 'node:path';
import type { ReportedChange } from '../types';
import type { FileChange } from '../../../schemas/FileChange';
import type { ApplyPatchApprovalParams } from '../../../schemas/ApplyPatchApprovalParams';
import type { FileUpdateChange } from '../../../schemas/v2/FileUpdateChange';
import type { FileChangePatchUpdatedNotification } from '../../../schemas/v2/FileChangePatchUpdatedNotification';
import type { PatchChangeKind } from '../../../schemas/v2/PatchChangeKind';

/**
 * Pure mapping from Codex's structured file-change payloads onto the neutral
 * `ReportedChange` shape the host journal consumes.
 *
 * The payloads already arrive today — the legacy `applyPatchApproval` server
 * request and the current `item/fileChange/patchUpdated` notification / the
 * `fileChange` thread item — but the content was previously discarded. This
 * module stops discarding it without touching the approval decision path: it
 * only turns a payload into absolute paths and status hints.
 *
 * It is kept pure and free of the transport so the mapping is unit-testable and
 * so any protocol drift shows up here as a type error.
 */

/** Every file change named by one apply-patch approval request. */
export function changesFromApplyPatch(params: ApplyPatchApprovalParams, origin: string): ReportedChange[] {
  const changes: ReportedChange[] = [];
  for (const [path, change] of Object.entries(params.fileChanges ?? {})) {
    if (!change) {
      continue;
    }
    for (const mapped of fromLegacyChange(path, change, origin)) {
      changes.push(mapped);
    }
  }
  return changes;
}

/** Every file change named by one current `item/fileChange/patchUpdated`. */
export function changesFromPatchUpdated(
  notification: FileChangePatchUpdatedNotification,
  origin: string
): ReportedChange[] {
  return notification.changes.flatMap((change) => fromUpdateChange(change, origin));
}

/** Every file change named by a current `fileChange` thread item. */
export function changesFromThreadItem(
  changes: readonly FileUpdateChange[],
  origin: string
): ReportedChange[] {
  return changes.flatMap((change) => fromUpdateChange(change, origin));
}

function fromLegacyChange(path: string, change: FileChange, origin: string): ReportedChange[] {
  const absPath = absolute(path, origin);
  switch (change.type) {
    case 'add':
      return [{ absPath, status: 'created' }];
    case 'delete':
      return [{ absPath, status: 'deleted' }];
    case 'update':
      if (change.move_path) {
        // The old path goes away and the new one appears; the journal's hash
        // match reports the pair as one rename rather than a delete plus create.
        return [
          { absPath, status: 'deleted' },
          { absPath: absolute(change.move_path, origin), status: 'modified' }
        ];
      }
      return [{ absPath, status: 'modified' }];
    default:
      return [];
  }
}

function fromUpdateChange(change: FileUpdateChange, origin: string): ReportedChange[] {
  const absPath = absolute(change.path, origin);
  const kind: PatchChangeKind = change.kind;
  switch (kind.type) {
    case 'add':
      return [{ absPath, status: 'created' }];
    case 'delete':
      return [{ absPath, status: 'deleted' }];
    case 'update':
      if (kind.move_path) {
        return [
          { absPath, status: 'deleted' },
          { absPath: absolute(kind.move_path, origin), status: 'modified' }
        ];
      }
      // An update with no added or removed lines named the file without changing
      // it (a read). It is not a workspace edit.
      if (!patchHasEdits(change.diff)) {
        return [];
      }
      return [{ absPath, status: 'modified' }];
    default:
      return [];
  }
}

/** True when a unified diff contains at least one added or removed line. */
function patchHasEdits(diff: string): boolean {
  for (const raw of diff.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('@@') || raw.startsWith('diff ')) {
      continue;
    }
    if (raw.startsWith('+') || raw.startsWith('-')) {
      return true;
    }
  }
  return false;
}

/** Resolve a payload path (absolute or cwd-relative) to an absolute path. */
function absolute(path: string, origin: string): string {
  return isAbsolute(path) ? path : resolve(origin, path);
}
