import type { ChangeStatus } from '../backends/types';
import type { ChangeWorkspaceFs } from './changeStore';
import { hashBytes } from './hash.ts';
import type {
  CaptureRestorePointInput,
  CheckpointPlanRecord,
  JournalFileEntry,
  JournalRestorePoint,
  JournalTurn,
  MessageCheckpoint
} from './journal';

/**
 * Per-message checkpoints, with a restore that reverts files only.
 *
 * A checkpoint is the send-time snapshot the journal stored for a user message:
 * workspace bytes and every thread's plan state, taken before the agent ran.
 * This store applies the file half back to the workspace. The host rewinds the
 * transcript and the plans; this module never imports the thread store.
 *
 * - **The snapshot is the restore target.** Each path returns to the bytes
 *   recorded when the message was sent. A file created after that, with no
 *   before side, is deleted. A file another thread edited after that returns
 *   to the same bytes.
 * - **A restore is itself undoable.** Before any workspace write, the current
 *   content of every file about to change is captured as a restore point. If
 *   that capture cannot be written, no file is modified and the restore aborts.
 * - **Conflicts are never silently overwritten.** A file whose current content
 *   differs from what the agent last recorded (an edit made outside the agent)
 *   is reported as a conflict and left alone unless the caller explicitly opts
 *   in with `overwrite-checkpoint`.
 * - **Partial is reported as partial.** Every file gets an outcome, and any
 *   `failed`/`conflict`/`skipped` result prevents the operation being reported
 *   as a full success.
 * - **Host-free.** No `vscode` import and no direct `fs`: all workspace I/O goes
 *   through an injected seam, so `npm test` drives it with fakes.
 */

/** One affected file and how the checkpoint restore treats it. */
export interface CheckpointFile {
  relPath: string;
  absPath: string;
  /** Bytes to write, `delete` to remove the file, `skipped` when unrestorable. */
  target: { kind: 'write'; bytes: Uint8Array } | { kind: 'delete' } | { kind: 'skipped'; reason: string };
  /**
   * What the workspace is expected to hold right now, from the agent's latest
   * recorded touch. `absent` means the file should not exist. `undefined` means
   * it was not recorded, so a conflict cannot be proven either way.
   */
  expected: { kind: 'hash'; value: string } | { kind: 'absent' } | undefined;
  status: ChangeStatus;
}

/** The checkpoint summary a confirmation can be shown from. */
export interface CheckpointView {
  messageId: string;
  /** The turn this message opened, or the message id when the turn has not started. */
  turnId: string;
  threadId: string;
  backendId: string;
  /** Epoch milliseconds the message was sent. */
  createdAt: number;
  /** Number of files the send-time snapshot recorded. */
  fileCount: number;
  /** Workspace-relative paths in the snapshot, sorted. */
  paths: string[];
}

/** Another chat whose later file or plan work a restore would undo. */
export interface CheckpointImpactChat {
  backendId: string;
  threadId: string;
  /** Paths that chat changed after the snapshot and that a restore would touch. */
  paths: string[];
  /** True when that chat's plan or todos differ from the snapshot. */
  planChanged: boolean;
}

/**
 * What a restore would change, computed before anything is written. The host
 * turns this into the confirmation, adding message previews and chat titles.
 */
export interface CheckpointImpact {
  createdAt: number;
  /** Paths whose workspace bytes are not already the snapshot. */
  paths: string[];
  /** True when this chat's plan or todos differ from the snapshot. */
  thisPlanChanged: boolean;
  /** Other chats, and only chats that would actually lose file or plan work. */
  others: CheckpointImpactChat[];
}

/** The explicit choice a conflicting restore requires before it writes. */
export type CheckpointConflictResolution = 'keep-current' | 'overwrite-checkpoint';

/** One file's outcome, so a partial restore is never hidden. */
export interface RestoreFileResult {
  relPath: string;
  outcome: 'reverted' | 'skipped' | 'failed' | 'conflict';
  /** Plain-language reason for a skipped, failed, or conflicted file. */
  reason?: string;
}

/** The whole outcome of a restore, never presented as fully successful when partial. */
export interface RestoreCheckpointResult {
  /** The id the restore was addressed by (message id or restore point id). */
  targetId: string;
  /** The pre-restore snapshot, so this restore can be undone. */
  undoPointId?: string;
  /** True only when every affected file was reverted or was already at target. */
  ok: boolean;
  /** True when any file failed, conflicted, or was left unrestorable. */
  partial: boolean;
  /** True when a conflict left at least one file unchanged and no overwrite was chosen. */
  hasConflicts: boolean;
  /** True when the restore was aborted before any file was modified. */
  aborted: boolean;
  fileCount: number;
  results: RestoreFileResult[];
  /** Plain-language summary for a notice. */
  message: string;
}

/** The recorded-artifact seam, satisfied by `ChangeJournal`. */
export interface CheckpointArtifacts {
  listTurns(threadId: string): JournalTurn[];
  listAllTurns(): JournalTurn[];
  getBefore(turnId: string, relPath: string): Promise<Uint8Array | undefined>;
  captureRestorePoint(input: CaptureRestorePointInput): Promise<JournalRestorePoint>;
  sealRestorePoint(id: string, expectedHashes: Readonly<Record<string, string | undefined>>): Promise<void>;
  getRestorePoint(id: string): JournalRestorePoint | undefined;
  getRestorePointContent(pointId: string, relPath: string): Promise<Uint8Array | undefined>;
  listRestorePoints(threadId: string): JournalRestorePoint[];
  getMessageCheckpoint(threadId: string, messageId: string): MessageCheckpoint | undefined;
  listMessageCheckpoints(threadId: string): MessageCheckpoint[];
  readCheckpointFile(threadId: string, messageId: string, relPath: string): Promise<Uint8Array | undefined>;
}

/** A decision store that can drop a turn's decisions when its content is superseded. */
export interface CheckpointDecisionSink {
  clearTurn(backendId: string, threadId: string, turnId: string): Promise<void>;
}

export interface CheckpointStoreOptions {
  artifacts: CheckpointArtifacts;
  fs: ChangeWorkspaceFs;
  decisions: CheckpointDecisionSink;
  /** Id source for restore points, injected so tests are deterministic. */
  newId?: () => string;
  /** Epoch milliseconds source, injected so tests are deterministic. */
  now?: () => number;
}

/** What a restore is addressed by. Exactly one of the two ids is provided. */
export interface RestoreCheckpointInput {
  backendId: string;
  threadId: string;
  /** The user message whose checkpoint is restored. */
  messageId?: string;
  /** A captured restore point, used to undo a previous restore. */
  restorePointId?: string;
  conflictResolution?: CheckpointConflictResolution;
}

/** The resolved plan for one restore, before any workspace write. */
interface RestorePlan {
  targetId: string;
  threadId: string;
  backendId: string;
  /** Affected turns, chronological, used to invalidate their review decisions. */
  turns: JournalTurn[];
  files: CheckpointFile[];
}

export class CheckpointStore {
  private readonly artifacts: CheckpointArtifacts;
  private readonly fs: ChangeWorkspaceFs;
  private readonly decisions: CheckpointDecisionSink;
  private readonly newId: () => string;
  private readonly now: () => number;

  constructor(options: CheckpointStoreOptions) {
    this.artifacts = options.artifacts;
    this.fs = options.fs;
    this.decisions = options.decisions;
    this.newId = options.newId ?? (() => `rp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    this.now = options.now ?? (() => Date.now());
  }

  /* ------------------------------- views ----------------------------------- */

  /**
   * Every user message in a thread that has a send-time snapshot, newest first.
   * A message is listed even when its turn touched no files, so a later message
   * or another chat can still be rewound to that moment.
   */
  async listCheckpoints(threadId: string): Promise<CheckpointView[]> {
    const turns = this.artifacts.listTurns(threadId);
    return this.artifacts.listMessageCheckpoints(threadId).map((checkpoint) => {
      const opened = turns.find((turn) => turn.messageId === checkpoint.messageId);
      const paths = checkpoint.files.map((file) => file.relPath).sort();
      return {
        messageId: checkpoint.messageId,
        turnId: opened?.turnId ?? checkpoint.messageId,
        threadId: checkpoint.threadId,
        backendId: checkpoint.backendId,
        createdAt: checkpoint.createdAt,
        fileCount: paths.length,
        paths
      };
    });
  }

  /**
   * Files and other chats a restore would touch, without writing. `plans` is
   * the current plan state of every thread, compared with the snapshot.
   */
  async preview(input: {
    threadId: string;
    messageId: string;
    plans: readonly CheckpointPlanRecord[];
  }): Promise<CheckpointImpact | undefined> {
    const checkpoint = this.artifacts.getMessageCheckpoint(input.threadId, input.messageId);
    const plan = checkpoint ? await this.planForMessage(input.threadId, input.messageId) : undefined;
    if (!checkpoint || !plan) {
      return undefined;
    }
    const paths: string[] = [];
    for (const file of plan.files) {
      if (file.target.kind === 'skipped') {
        paths.push(file.relPath);
        continue;
      }
      const current = await this.fs.readFile(file.absPath);
      const currentHash = current ? hashBytes(current) : undefined;
      const targetHash = file.target.kind === 'write' ? hashBytes(file.target.bytes) : undefined;
      if (currentHash !== targetHash) {
        paths.push(file.relPath);
      }
    }
    paths.sort();
    const pathSet = new Set(paths);
    const others = new Map<string, CheckpointImpactChat>();
    for (const turn of plan.turns) {
      if (turn.threadId === checkpoint.threadId && turn.backendId === checkpoint.backendId) {
        continue;
      }
      const touched = turn.files.map((file) => file.relPath).filter((relPath) => pathSet.has(relPath));
      if (touched.length === 0) {
        continue;
      }
      const key = `${turn.backendId}\0${turn.threadId}`;
      const existing = others.get(key) ?? {
        backendId: turn.backendId,
        threadId: turn.threadId,
        paths: [],
        planChanged: false
      };
      for (const relPath of touched) {
        if (!existing.paths.includes(relPath)) {
          existing.paths.push(relPath);
        }
      }
      others.set(key, existing);
    }
    const snapshotPlans = checkpoint.plans;
    const consider = new Map<string, { backendId: string; threadId: string }>();
    for (const record of [...snapshotPlans, ...input.plans]) {
      consider.set(`${record.backendId}\0${record.threadId}`, { backendId: record.backendId, threadId: record.threadId });
    }
    for (const record of consider.values()) {
      const changed = !samePlan(
        planState(snapshotPlans, record.backendId, record.threadId),
        planState(input.plans, record.backendId, record.threadId)
      );
      if (!changed) {
        continue;
      }
      if (record.threadId === checkpoint.threadId && record.backendId === checkpoint.backendId) {
        continue;
      }
      const key = `${record.backendId}\0${record.threadId}`;
      const existing = others.get(key) ?? {
        backendId: record.backendId,
        threadId: record.threadId,
        paths: [],
        planChanged: false
      };
      existing.planChanged = true;
      others.set(key, existing);
    }
    for (const chat of others.values()) {
      chat.paths.sort();
    }
    return {
      createdAt: checkpoint.createdAt,
      paths,
      thisPlanChanged: !samePlan(
        planState(snapshotPlans, checkpoint.backendId, checkpoint.threadId),
        planState(input.plans, checkpoint.backendId, checkpoint.threadId)
      ),
      others: [...others.values()]
    };
  }

  /** The full file plan for a message checkpoint, for an on-demand confirmation. */
  async checkpointFiles(threadId: string, messageId: string): Promise<CheckpointFile[]> {
    return (await this.planForMessage(threadId, messageId))?.files ?? [];
  }

  /* ------------------------------ restore ---------------------------------- */

  /**
   * Restore a checkpoint. Files are reverted only; the transcript is untouched.
   * Conflicts are reported and left alone unless `overwrite-checkpoint` is set.
   */
  async restore(input: RestoreCheckpointInput): Promise<RestoreCheckpointResult> {
    const plan = input.restorePointId
      ? await this.planForRestorePoint(input.threadId, input.restorePointId)
      : input.messageId
        ? await this.planForMessage(input.threadId, input.messageId)
        : undefined;
    if (!plan) {
      return {
        targetId: input.restorePointId ?? input.messageId ?? '',
        ok: false,
        partial: true,
        hasConflicts: false,
        aborted: true,
        fileCount: 0,
        results: [],
        message: 'That checkpoint is no longer available, so nothing was restored.'
      };
    }

    // Decide per file: revert, skip (already at target), conflict, or unrestorable.
    const decisions: {
      file: CheckpointFile;
      action: 'revert' | 'skip-at-target' | 'conflict' | 'skip-unrestorable';
    }[] = [];
    for (const file of plan.files) {
      if (file.target.kind === 'skipped') {
        decisions.push({ file, action: 'skip-unrestorable' });
        continue;
      }
      const current = await this.fs.readFile(file.absPath);
      const currentHash = current ? hashBytes(current) : undefined;
      const targetHash = file.target.kind === 'write' ? hashBytes(file.target.bytes) : undefined;
      if (currentHash === targetHash) {
        decisions.push({ file, action: 'skip-at-target' });
        continue;
      }
      if (this.matchesExpected(file.expected, currentHash)) {
        decisions.push({ file, action: 'revert' });
        continue;
      }
      decisions.push({ file, action: 'conflict' });
    }

    const overwrite = input.conflictResolution === 'overwrite-checkpoint';
    const conflicts = decisions.filter((entry) => entry.action === 'conflict');
    const toModify = decisions.filter(
      (entry) => entry.action === 'revert' || (entry.action === 'conflict' && overwrite)
    );

    // Capture the pre-restore content of everything this restore will modify, so
    // the restore is undoable. `skip-at-target` files are not modified and need
    // no capture. If the capture cannot be written, abort without writing.
    const captureFiles = [];
    const expectedNow: Record<string, string | undefined> = {};
    for (const entry of toModify) {
      const file = entry.file;
      const current = await this.fs.readFile(file.absPath);
      captureFiles.push({
        absPath: file.absPath,
        relPath: file.relPath,
        ...(current ? { bytes: current } : {})
      });
      expectedNow[file.relPath] = current ? hashBytes(current) : undefined;
    }

    const undoPointId = this.newId();
    try {
      await this.artifacts.captureRestorePoint({
        id: undoPointId,
        threadId: input.threadId,
        backendId: input.backendId,
        files: captureFiles,
        expectedHashes: expectedNow,
        createdAt: this.now()
      });
    } catch (error) {
      // No way back: abort without touching a workspace file. Conflicts are
      // still reported so the user sees why files were left alone.
      return {
        targetId: plan.targetId,
        ok: false,
        partial: true,
        hasConflicts: conflicts.length > 0,
        aborted: true,
        fileCount: plan.files.length,
        results: conflicts.map((entry) => ({
          relPath: entry.file.relPath,
          outcome: 'conflict' as const,
          reason: 'The file changed outside the agent since the checkpoint.'
        })),
        message: `The restore was not applied because a pre-restore snapshot could not be saved${
          error instanceof Error && error.message ? ` (${error.message})` : ''
        }. No file was changed.`
      };
    }

    // Apply: revert every non-conflicting file, and conflicts too when the user
    // explicitly opted in. Every outcome is caught per file.
    const results: RestoreFileResult[] = [];
    for (const entry of decisions) {
      const file = entry.file;
      if (entry.action === 'skip-at-target') {
        results.push({ relPath: file.relPath, outcome: 'reverted' });
        continue;
      }
      if (entry.action === 'skip-unrestorable') {
        const reason = file.target.kind === 'skipped' ? file.target.reason : undefined;
        results.push({ relPath: file.relPath, outcome: 'skipped', ...(reason ? { reason } : {}) });
        continue;
      }
      if (entry.action === 'conflict' && !overwrite) {
        results.push({
          relPath: file.relPath,
          outcome: 'conflict',
          reason: 'The file changed outside the agent since the checkpoint.'
        });
        continue;
      }
      try {
        if (file.target.kind === 'delete') {
          await this.fs.deleteFile(file.absPath);
        } else if (file.target.kind === 'write') {
          await this.fs.writeFile(file.absPath, file.target.bytes);
        }
        results.push({ relPath: file.relPath, outcome: 'reverted' });
      } catch (error) {
        results.push({
          relPath: file.relPath,
          outcome: 'failed',
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // Seal the undo point with the content the restore produced, so a second
    // restore of it can tell the restore's own result from a later edit. A seal
    // that cannot be written leaves the restore applied (it already happened);
    // the point just has no conflict baseline.
    const expectedAfter: Record<string, string | undefined> = {};
    for (const entry of toModify) {
      const current = await this.fs.readFile(entry.file.absPath);
      expectedAfter[entry.file.relPath] = current ? hashBytes(current) : undefined;
    }
    try {
      await this.artifacts.sealRestorePoint(undoPointId, expectedAfter);
    } catch {
      // The restore is already applied; a failed seal only weakens the undo's
      // conflict guard, never the restore itself.
    }

    // Invalidate every affected turn's decisions, so no accepted/rejected
    // decision points at content the restore has superseded.
    for (const turn of plan.turns) {
      try {
        await this.decisions.clearTurn(turn.backendId, turn.threadId, turn.turnId);
      } catch {
        // A decision store that is unavailable must not fail the restore.
      }
    }

    const failed = results.filter((result) => result.outcome === 'failed');
    const conflictResults = results.filter((result) => result.outcome === 'conflict');
    const skipped = results.filter((result) => result.outcome === 'skipped');
    const changed = results.filter((result) => result.outcome === 'reverted').length;
    const partial = failed.length > 0 || conflictResults.length > 0 || skipped.length > 0;
    return {
      targetId: plan.targetId,
      undoPointId,
      // `ok` is true only when every affected file was reverted or already at
      // its checkpoint content. A skipped file was not restored, so it is not a
      // full success even without a failure or conflict.
      ok: !partial,
      partial,
      hasConflicts: conflictResults.length > 0,
      aborted: false,
      fileCount: plan.files.length,
      results,
      message: describeRestore(plan.files.length, changed, failed.length, conflictResults.length, skipped.length)
    };
  }

  /* ----------------------------- resolution -------------------------------- */

  private async planForMessage(threadId: string, messageId: string): Promise<RestorePlan | undefined> {
    const checkpoint = this.artifacts.getMessageCheckpoint(threadId, messageId);
    if (!checkpoint) {
      return undefined;
    }
    const resolved = await this.filesForCheckpoint(checkpoint);
    return {
      targetId: messageId,
      threadId,
      backendId: checkpoint.backendId,
      turns: resolved.turns,
      files: resolved.files
    };
  }

  private async planForRestorePoint(threadId: string, pointId: string): Promise<RestorePlan | undefined> {
    const point = this.artifacts.getRestorePoint(pointId);
    if (!point || point.threadId !== threadId) {
      return undefined;
    }
    const files: CheckpointFile[] = [];
    for (const file of point.files) {
      const bytes = file.blobKey ? await this.artifacts.getRestorePointContent(pointId, file.relPath) : undefined;
      const target: CheckpointFile['target'] =
        file.hash === undefined
          ? { kind: 'delete' }
          : bytes !== undefined
            ? { kind: 'write', bytes }
            : {
                kind: 'skipped',
                reason: 'The pre-restore content was not stored, so it cannot be restored.'
              };
      const expected: CheckpointFile['expected'] =
        file.expectedHash !== undefined
          ? { kind: 'hash', value: file.expectedHash }
          : file.hash === undefined
            ? { kind: 'absent' }
            : undefined;
      files.push({ relPath: file.relPath, absPath: file.absPath, target, expected, status: 'modified' });
    }
    return { targetId: pointId, threadId, backendId: point.backendId, turns: [], files };
  }

  /**
   * Build the file set for a send-time snapshot. Paths in the snapshot are
   * written back, or deleted when the snapshot recorded them absent. A file
   * created after the snapshot, with no before side, is deleted even when the
   * snapshot did not name it. The conflict baseline is the newest recorded
   * after-side at or after the snapshot.
   */
  private async filesForCheckpoint(
    checkpoint: MessageCheckpoint
  ): Promise<{ files: CheckpointFile[]; turns: JournalTurn[] }> {
    const all = this.artifacts.listAllTurns();
    const later = all.filter(
      (turn) =>
        turn.startedAt >= checkpoint.createdAt ||
        (turn.endedAt !== undefined && turn.endedAt >= checkpoint.createdAt)
    );
    const byPath = new Map<string, CheckpointFile>();
    for (const file of checkpoint.files) {
      const bytes = file.blobKey
        ? await this.artifacts.readCheckpointFile(checkpoint.threadId, checkpoint.messageId, file.relPath)
        : undefined;
      const target: CheckpointFile['target'] =
        file.hash === undefined
          ? { kind: 'delete' }
          : bytes !== undefined
            ? { kind: 'write', bytes }
            : { kind: 'skipped', reason: 'The pre-message content was not stored, so it cannot be restored.' };
      byPath.set(file.relPath, {
        relPath: file.relPath,
        absPath: file.absPath,
        target,
        expected: expectedAfter(later, file.relPath) ?? (file.hash ? { kind: 'hash', value: file.hash } : { kind: 'absent' }),
        status: 'modified'
      });
    }

    const createdAfter = all.filter((turn) => turn.startedAt >= checkpoint.createdAt);
    for (const turn of createdAfter) {
      for (const entry of turn.files) {
        if (byPath.has(entry.relPath)) {
          continue;
        }
        let target: CheckpointFile['target'];
        if (entry.hasBefore && entry.beforeHash) {
          const bytes = await this.artifacts.getBefore(turn.turnId, entry.relPath);
          target =
            bytes !== undefined
              ? { kind: 'write', bytes }
              : { kind: 'skipped', reason: 'The pre-checkpoint content was not stored, so it cannot be restored.' };
        } else if (!entry.hasBefore && entry.status === 'created') {
          target = { kind: 'delete' };
        } else {
          target = {
            kind: 'skipped',
            reason: 'No pre-checkpoint content was recorded for this file, so it cannot be restored.'
          };
        }
        byPath.set(entry.relPath, {
          relPath: entry.relPath,
          absPath: entry.absPath,
          target,
          expected: expectedAfter(later, entry.relPath) ?? expectedFor(entry),
          status: entry.status
        });
      }
    }

    const files = [...byPath.values()];
    const paths = new Set(files.map((file) => file.relPath));
    const turns = later.filter(
      (turn) =>
        (turn.threadId === checkpoint.threadId && turn.backendId === checkpoint.backendId) ||
        turn.files.some((file) => paths.has(file.relPath))
    );
    return { files, turns };
  }

  /** True when the current hash is consistent with what the agent last recorded. */
  private matchesExpected(expected: CheckpointFile['expected'], currentHash: string | undefined): boolean {
    if (expected === undefined) {
      // Nothing was recorded, so a conflict cannot be proven; allow the revert.
      return true;
    }
    if (expected.kind === 'absent') {
      return currentHash === undefined;
    }
    return currentHash === expected.value;
  }
}

/** The newest after-side recorded at or after the snapshot, for one path. */
function expectedAfter(turns: readonly JournalTurn[], relPath: string): CheckpointFile['expected'] | undefined {
  let expected: CheckpointFile['expected'] | undefined;
  for (const turn of turns) {
    const entry = turn.files.find((file) => file.relPath === relPath);
    if (entry) {
      expected = expectedFor(entry);
    }
  }
  return expected;
}

function planState(
  records: readonly CheckpointPlanRecord[],
  backendId: string,
  threadId: string
): CheckpointPlanRecord['state'] {
  return records.find((record) => record.backendId === backendId && record.threadId === threadId)?.state;
}

function samePlan(left: CheckpointPlanRecord['state'], right: CheckpointPlanRecord['state']): boolean {
  const normalize = (state: CheckpointPlanRecord['state']) => {
    if (!state) {
      return null;
    }
    return {
      path: state.path,
      title: state.title,
      summary: state.summary ?? '',
      body: state.body ?? '',
      built: Boolean(state.built),
      completedDismissed: Boolean(state.completedDismissed),
      steps: state.steps.map((step) => ({ text: step.text, status: step.status }))
    };
  };
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

/** What the workspace should hold now, from the latest affected turn's after side. */
function expectedFor(entry: JournalFileEntry): CheckpointFile['expected'] {
  if (!entry.hasAfter) {
    return { kind: 'absent' };
  }
  if (entry.afterHash) {
    return { kind: 'hash', value: entry.afterHash };
  }
  return undefined;
}

function describeRestore(
  total: number,
  changed: number,
  failed: number,
  conflicts: number,
  skipped: number
): string {
  if (total === 0) {
    return 'This checkpoint has no files to restore.';
  }
  const verbs: string[] = [`${changed} of ${total} files restored`];
  if (failed > 0) {
    verbs.push(`${failed} failed`);
  }
  if (conflicts > 0) {
    verbs.push(`${conflicts} left unchanged because they changed outside the agent`);
  }
  if (skipped > 0) {
    verbs.push(`${skipped} skipped`);
  }
  const partial = failed > 0 || conflicts > 0 || skipped > 0;
  return `Restore ${partial ? 'was partial: ' : 'complete: '}${verbs.join(', ')}.`;
}
