import type { ChangeSource, ChangeStatus } from '../backends/types';
import { hashBytes } from './hash.ts';
import { excludedByIgnore, reviewSources } from './ignore.ts';
import { contentBeforePatches, contentBeforeReplacements } from './patchReverse.ts';

/**
 * The per-turn file snapshot journal.
 *
 * Records what the workspace looked like before and after a turn, so a later
 * review surface can diff a turn and a revert path has real bytes to write back.
 * This module is storage only: no diffing, no decisions, no UI, and it never
 * writes to a workspace file.
 *
 * ## Split storage
 *
 * Following the `threadStore.ts` precedent of keeping `workspaceState` to
 * identifiers, the two halves live in different places:
 *
 * - **Turn metadata** (the index of turns and their per-file hashes, statuses
 *   and blob keys) goes to the injected `JournalStorage`, which the extension
 *   host binds to `workspaceState` under `melink.changeJournal`. It is bounded:
 *   the index is capped at the most recent `maxTurns` entries and carries no
 *   file content.
 * - **Blob content** goes to the injected `JournalFs`, which the host binds to
 *   `context.storageUri` (workspace-scoped). Content never reaches
 *   `workspaceState` or `globalState`.
 *
 * ## Host-free by construction
 *
 * The module never imports `vscode`. Every read and write goes through the
 * structural `JournalFs` / `JournalStorage` seams, so `npm test` injects a fake
 * fs and never touches a VS Code runtime. The thin binding to the real
 * `vscode.workspace.fs` and `context.storageUri` lives in `vscodeJournal.ts`.
 *
 * ## Invariants
 *
 * - **Read-only with respect to workspace files.** The only writes are blob
 *   files under the journal storage root. No workspace file is ever modified.
 * - **A no-op turn is provably a no-op.** Every file has a content hash, and a
 *   turn whose files all hash identically records an empty `files` array and
 *   writes no blobs.
 * - **Missing is not an error.** Every accessor is idempotent and answers
 *   `undefined` for an unknown turn or file rather than throwing.
 * - **Bounded.** The index is capped by count and the blob store by bytes;
 *   pruning deletes the blobs of evicted turns and never evicts the turn
 *   currently under review.
 * - **No import-time side effects.**
 */

export type { ChangeStatus } from '../backends/types';

/** One file touched by a turn, with hashes rather than content. */
export interface JournalFileEntry {
  /** Absolute path of the file after the turn, or before for a delete. */
  absPath: string;
  /** Workspace-relative, POSIX-separated path of the file. */
  relPath: string;
  status: ChangeStatus;
  /**
   * How the change was learned: `reported` when a backend edit event named it,
   * `watched` when only the workspace watcher observed it. Always a recorded
   * fact, never inferred.
   */
  source: ChangeSource;
  /** Content hash before the turn, absent for a created file. */
  beforeHash?: string;
  /** Content hash after the turn, absent for a deleted file. */
  afterHash?: string;
  /** Size of the after content when present, otherwise the before content. */
  sizeBytes: number;
  /** True when a NUL byte was sniffed; content is never inlined. */
  binary: boolean;
  /** False when content was not stored (binary side or over the size cap). */
  inlineable: boolean;
  /** True when a before-side blob exists. */
  hasBefore: boolean;
  /** True when an after-side blob exists. */
  hasAfter: boolean;
  /** Blob key of the stored before content, when one exists. */
  beforeKey?: string;
  /** Blob key of the stored after content, when one exists. */
  afterKey?: string;
  /** For a rename, the pre-turn path. */
  renamedFrom?: string;
}

/** One recorded turn boundary. */
export interface JournalTurn {
  turnId: string;
  threadId: string;
  backendId: string;
  /**
   * The user message that opened this turn, when the host knew it. This is what
   * makes a turn's pre-turn snapshot the checkpoint for a specific message: a
   * restore is addressed by message id, then resolves to the earliest turn that
   * carries it. Absent for a turn whose opening message was not recorded, which
   * is therefore reachable by turn id only, not offered as a message checkpoint.
   */
  messageId?: string;
  /** Original user request shared by automatic continuations. */
  requestMessageId?: string;
  /** Epoch milliseconds the turn opened. */
  startedAt: number;
  /** Epoch milliseconds the turn closed, absent while it is still open. */
  endedAt?: number;
  files: JournalFileEntry[];
  /** Blob bytes stored for this turn, used by the size budget. */
  bytes: number;
  /**
   * True when the turn actually observed at least one workspace path (a
   * structured report or a watcher hit). False means nothing was observed, so
   * the recorded (empty) file set must NOT be read as a verified no-op.
   */
  observed: boolean;
}

/**
 * One thread's plan and todo list at the moment a message was sent. Absent
 * `state` means the thread had no plan. Structural on purpose: the journal
 * stores the snapshot and never imports the host thread store.
 */
export interface CheckpointPlanState {
  path: string;
  title: string;
  summary?: string;
  body?: string;
  steps: { text: string; status: string }[];
  built?: boolean;
  completedDismissed?: boolean;
  updatedAt: number;
}

/** Plan state for one thread, captured with a message checkpoint. */
export interface CheckpointPlanRecord {
  backendId: string;
  threadId: string;
  /** Absent when the thread had no plan at send time. */
  state?: CheckpointPlanState;
}

/** One file in a send-time message checkpoint. No hash means the file was absent. */
export interface MessageCheckpointFile {
  absPath: string;
  relPath: string;
  hash?: string;
  /** Blob key when the content was stored. Shared with an older blob when the hash matches. */
  blobKey?: string;
  sizeBytes: number;
}

/**
 * Workspace and plan snapshot taken when a user message is sent, before the
 * agent runs. Addressed by message id. Content lives in the blob store.
 */
export interface MessageCheckpoint {
  messageId: string;
  threadId: string;
  backendId: string;
  createdAt: number;
  files: MessageCheckpointFile[];
  plans: CheckpointPlanRecord[];
  /** Newly written blob bytes, used by the size budget. Reused blobs are not counted twice. */
  bytes: number;
}

/**
 * Chat and journal state captured with a file undo point, so undoing a restore
 * puts the transcript, plans, and review turns back too. The checkpoint module
 * does not fill this; the host does, after the file snapshot succeeds.
 */
export interface RestoreRewind {
  backendId: string;
  threadId: string;
  messageId: string;
  /** The restored thread's full transcript before it was truncated. */
  transcript: unknown[];
  /** Every thread's plan state before the restore. */
  plans: CheckpointPlanRecord[];
  /** Journal turns removed from the restored thread. */
  turns: JournalTurn[];
  /** Message checkpoints removed from the restored thread. */
  checkpoints: MessageCheckpoint[];
}

/** The persisted index shape. Metadata only; never file content. */
export interface JournalIndex {
  turns: JournalTurn[];
  /**
   * Pre-restore snapshots. A restore captures the current content of every file
   * it is about to touch here, so the restore is itself undoable. A point is a
   * checkpoint like a turn's pre-state, just created on demand rather than by a
   * turn boundary.
   */
  restorePoints: JournalRestorePoint[];
  /**
   * Send-time snapshots, one per user message. Oldest first, same as turns.
   * Absent on journals written before message checkpoints existed.
   */
  checkpoints?: MessageCheckpoint[];
}

/** One file captured in a restore point. */
export interface RestorePointFile {
  absPath: string;
  relPath: string;
  /** Content hash at capture time, absent when the file was absent then. */
  hash?: string;
  /** Blob key of the captured content, absent when the file was absent. */
  blobKey?: string;
  /** Byte size of the captured content, for the blob budget. */
  sizeBytes: number;
  /**
   * Hash the workspace must hold for a clean restore of this point. Unset until
   * the operation that created the point has been sealed; a sealed value that
   * differs from the file's current hash means the file changed after that
   * operation, so a restore would be a conflict rather than a clean undo.
   */
  expectedHash?: string;
}

/**
 * A durable snapshot of file content taken before a destructive restore, so the
 * restore can be reversed. Content lives in the blob store, keyed under
 * `restore-points/<id>/...`, never in the index.
 */
export interface JournalRestorePoint {
  id: string;
  threadId: string;
  backendId: string;
  createdAt: number;
  files: RestorePointFile[];
  /** Blob bytes stored for this point, used by the size budget. */
  bytes: number;
  /**
   * Transcript, plans, and journal entries to put back when this file snapshot
   * is restored. Absent for a file-only undo captured before the host attached
   * the chat rewind.
   */
  rewind?: RestoreRewind;
}

/** What `captureRestorePoint` needs to durably snapshot current content. */
export interface CaptureRestorePointInput {
  id: string;
  threadId: string;
  backendId: string;
  /**
   * Files to capture, with the bytes the caller just read. `bytes` absent means
   * the file was absent at capture time, which is itself a restorable state (the
   * undo deletes it again).
   */
  files: readonly { absPath: string; relPath: string; bytes?: Uint8Array }[];
  /**
   * The content hash the workspace held at capture time, per relative path.
   * Sealed onto the point so a later undo can detect a file that changed after
   * the restore and refuse to clobber it. `undefined` means the file was absent.
   */
  expectedHashes: Readonly<Record<string, string | undefined>>;
  /** Epoch milliseconds; injected so a test is deterministic. */
  createdAt?: number;
}

/** What `captureMessageCheckpoint` needs to snapshot the workspace at send time. */
export interface CaptureMessageCheckpointInput {
  messageId: string;
  threadId: string;
  backendId: string;
  /** Absolute paths to snapshot: tracked files plus open editors. Absent files are recorded as absent. */
  paths: readonly string[];
  /** Every thread's plan state at send time. */
  plans: readonly CheckpointPlanRecord[];
  /** Epoch milliseconds; injected so a test is deterministic. */
  createdAt?: number;
}

/** What `beginTurn` needs to open a boundary. */
export interface BeginTurnInput {
  turnId: string;
  threadId: string;
  backendId: string;
  /** The user message that opened the turn, when the host knows it. */
  messageId?: string;
  /** Original user request shared by automatic continuations. */
  requestMessageId?: string;
  /**
   * Absolute paths the turn may touch, snapshotted before it runs. Paths the
   * turn is only observed touching later are snapshotted on first observation
   * via `noteChange`, so a shell-driven write is still diffed rather than
   * misreported as a create.
   */
  candidates?: readonly string[];
  /** Earlier name for `candidates`, kept so existing callers need no change. */
  candidatePaths?: readonly string[];
  /** Epoch milliseconds; injected so a test is deterministic. */
  startedAt?: number;
}

/**
 * The workspace read seam. The host binds these to `vscode.workspace.fs`, so
 * remote and virtual workspaces work and no direct `fs` is ever used.
 */
export interface JournalFs {
  /** Every workspace root, absolute, in workspace order. */
  workspaceRoots(): readonly string[];
  /** Reads an absolute path's bytes, or `undefined` when absent/unreadable. */
  readFile(absPath: string): Promise<Uint8Array | undefined>;
  /** Writes a blob under the journal storage root, creating parents. */
  writeBlob(key: string, bytes: Uint8Array): Promise<void>;
  /** Reads a blob under the journal storage root, or `undefined` when absent. */
  readBlob(key: string): Promise<Uint8Array | undefined>;
  /** Deletes a blob; a missing file is not an error. */
  deleteBlob(key: string): Promise<void>;
}

/** A `vscode.Memento`-shaped seam, so the core never imports the host. */
export interface JournalStorage {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Promise<void> | Thenable<void>;
}

export interface ChangeJournalOptions {
  storage: JournalStorage;
  fs: JournalFs;
  /** Most recent turns kept in the index. */
  maxTurns?: number;
  /** Most recent pre-restore snapshots kept. */
  maxRestorePoints?: number;
  /** Byte budget for the blob store. */
  maxBlobBytes?: number;
  /** Largest before/after content stored as a blob. */
  maxInlineBytes?: number;
  /** Epoch milliseconds source, injected so tests are deterministic. */
  now?: () => number;
}

/** The `workspaceState` key the host and this module agree on. */
export const JOURNAL_KEY = 'melink.changeJournal';
/** Default index cap: the most recent 50 turns. */
export const DEFAULT_MAX_TURNS = 50;
/** Default restore-point cap: the most recent 20 pre-restore snapshots. */
export const DEFAULT_MAX_RESTORE_POINTS = 20;
/** Default blob budget: 64 MiB. */
export const DEFAULT_MAX_BLOB_BYTES = 64 * 1024 * 1024;
/** Default inline cap: 2 MiB. Larger files are recorded but not stored. */
export const DEFAULT_MAX_INLINE_BYTES = 2 * 1024 * 1024;
/** Bytes scanned for the NUL-byte binary sniff. */
const BINARY_SNIFF_BYTES = 8_000;

interface FileSnapshot {
  hash: string;
  size: number;
  binary: boolean;
  bytes: Uint8Array;
}

interface TextReplacement {
  before: string;
  after: string;
}

interface Observation {
  source: ChangeSource;
  status?: ChangeStatus;
  /** Unified diffs reported for this path, in the order they were applied. */
  diffs: string[];
  /** Exact old/new strings a tool reported, in the order they were applied. */
  replacements: TextReplacement[];
  /** Full pre-edit text, trusted only when `afterText` matches the file on disk. */
  beforeText?: string;
  afterText?: string;
}

/** Extra facts a structured report can attach so a missing snapshot can be recovered. */
export interface ObservationDetail {
  replacement?: TextReplacement;
  beforeText?: string;
  afterText?: string;
}

interface PendingTurn {
  turnId: string;
  threadId: string;
  backendId: string;
  startedAt: number;
  /** Candidate paths in workspace order, mapped to their pre-turn snapshot. */
  before: Map<string, FileSnapshot | null>;
  /** Canonical path key to the absolute path used for display and reads. */
  display: Map<string, string>;
  /**
   * Paths a backend report or the watcher named during the turn, with how it was
   * learned and any status hint. Kept separate from `before` on purpose: a
   * watcher usually fires only *after* a shell command has written, so its
   * observation must not overwrite the real pre-turn snapshot with a post-write
   * one. An observed path outside `before` is a change whose kind comes from the
   * hint, since there is no pre-turn side to diff against.
   */
  observations: Map<string, Observation>;
  /** True once any workspace path has been observed for this turn. */
  observed: boolean;
}

/** A file being assembled into an entry, before blob keys are assigned. */
interface Draft {
  entry: JournalFileEntry;
  before?: FileSnapshot;
  after?: FileSnapshot;
}

export class ChangeJournal {
  private readonly storage: JournalStorage;
  /** `.gitignore` text, keyed by absolute path. `null` means the file is absent. */
  private readonly gitignoreCache = new Map<string, string | null>();
  private readonly fs: JournalFs;
  private readonly maxTurns: number;
  private readonly maxRestorePoints: number;
  private readonly maxBlobBytes: number;
  private readonly maxInlineBytes: number;
  private readonly now: () => number;
  private index?: JournalIndex;
  private readonly pending = new Map<string, PendingTurn>();
  private reviewing?: string;
  /** Serialises mutations so two concurrent turn boundaries cannot race. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: ChangeJournalOptions) {
    this.storage = options.storage;
    this.fs = options.fs;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxRestorePoints = options.maxRestorePoints ?? DEFAULT_MAX_RESTORE_POINTS;
    this.maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
    this.maxInlineBytes = options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
    this.now = options.now ?? (() => Date.now());
  }

  /* ------------------------------- writes ---------------------------------- */

  /**
   * Open a turn boundary and snapshot any pre-known candidate file as it is now.
   * A candidate outside every workspace root is skipped. Re-opening an existing
   * turn id replaces it, so the call is idempotent.
   */
  async beginTurn(input: BeginTurnInput): Promise<void> {
    return this.run(async () => {
      const roots = this.fs.workspaceRoots();
      // `candidates` is the documented name; `candidatePaths` is the earlier
      // shape, still accepted so existing callers need no change.
      const candidates = input.candidates ?? input.candidatePaths ?? [];
      const before = new Map<string, FileSnapshot | null>();
      const display = new Map<string, string>();
      for (const candidate of candidates) {
        const key = canonicalAbsPath(candidate);
        if (display.has(key) || !workspaceRelative(candidate, roots) || (await this.ignored(candidate))) {
          continue;
        }
        display.set(key, candidate);
        before.set(key, await this.snapshot(candidate));
      }
      const startedAt = input.startedAt ?? this.now();
      this.pending.set(input.turnId, {
        turnId: input.turnId,
        threadId: input.threadId,
        backendId: input.backendId,
        startedAt,
        before,
        display,
        observations: new Map(),
        // A pre-seeded candidate is not an observation: it only gives the diff a
        // real before side. `observed` is set only when a report or the watcher
        // actually fires, so a turn that merely had candidates stays honest.
        observed: false
      });

      const index = this.loadIndex();
      index.turns = index.turns.filter((turn) => turn.turnId !== input.turnId);
      index.turns.push({
        turnId: input.turnId,
        threadId: input.threadId,
        backendId: input.backendId,
        ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
        ...(input.requestMessageId ? { requestMessageId: input.requestMessageId } : {}),
        startedAt,
        files: [],
        bytes: 0,
        observed: false
      });
      await this.persist(index);
      await this.prune();
    });
  }

  /**
   * Note that a turn touched an absolute path, snapshotting the pre-turn state
   * the first time the path is seen so the end-of-turn diff has a real before
   * side. Called for a structured backend report and for every path the watcher
   * observes. A path outside every workspace root is ignored, and a `reported`
   * source is never downgraded to `watched`. A closed or unknown turn is a no-op.
   *
   * `status` is an optional hint from the reporter (a create or delete) used
   * when the snapshot diff cannot prove the kind on its own; `source` defaults
   * to `watched` for a bare watcher observation.
   *
   * `diff` is the unified diff of a reported edit. It is kept so a file that
   * was not a pre-turn candidate can still be reviewed against the bytes the
   * edit replaced, instead of against an empty file.
   */
  async observe(
    turnId: string,
    absPath: string,
    source: ChangeSource = 'watched',
    status?: ChangeStatus,
    diff?: string,
    detail?: ObservationDetail
  ): Promise<void> {
    return this.run(async () => {
      const pending = this.pending.get(turnId);
      if (!pending) {
        return;
      }
      const path = canonicalAbsPath(absPath);
      if (!pending.display.has(path)) {
        pending.display.set(path, absPath);
      }
      const shown = pending.display.get(path) ?? absPath;
      if (!workspaceRelative(shown, this.fs.workspaceRoots()) || (await this.ignored(shown))) {
        return;
      }
      // Never snapshot here: a watcher fires after the write, so snapshotting
      // now would record the post-change content as the "before". A path with no
      // pre-turn candidate is recovered from the reported diff or replacement.
      const existing = pending.observations.get(path);
      const diffs = existing?.diffs.slice() ?? [];
      if (diff && diff.trim().length > 0 && diffs[diffs.length - 1] !== diff) {
        diffs.push(diff);
      }
      const replacements = existing?.replacements.slice() ?? [];
      const replacement = detail?.replacement;
      if (
        replacement &&
        replacement.after.length > 0 &&
        replacement.before !== replacement.after &&
        !replacements.some((item) => item.before === replacement.before && item.after === replacement.after)
      ) {
        replacements.push({ before: replacement.before, after: replacement.after });
      }
      const nextSource = source === 'reported' || existing === undefined ? source : existing.source;
      // A reported status may refine the hint. A later watcher event must not
      // overwrite a status that was already named.
      const nextStatus =
        status !== undefined && (existing === undefined || source === 'reported' || existing.status === undefined)
          ? status
          : existing?.status;
      const changed =
        !existing ||
        existing.source !== nextSource ||
        existing.status !== nextStatus ||
        existing.diffs.length !== diffs.length ||
        existing.replacements.length !== replacements.length ||
        (detail?.beforeText !== undefined && detail.beforeText !== existing.beforeText) ||
        (detail?.afterText !== undefined && detail.afterText !== existing.afterText);
      if (changed) {
        pending.observations.set(path, {
          source: nextSource,
          ...(nextStatus !== undefined ? { status: nextStatus } : {}),
          diffs,
          replacements,
          ...(detail?.beforeText !== undefined
            ? { beforeText: detail.beforeText }
            : existing?.beforeText !== undefined
              ? { beforeText: existing.beforeText }
              : {}),
          ...(detail?.afterText !== undefined
            ? { afterText: detail.afterText }
            : existing?.afterText !== undefined
              ? { afterText: existing.afterText }
              : {})
        });
      }
      pending.observed = true;
    });
  }

  /**
   * Close a turn boundary: snapshot the candidate set again, diff it against
   * the pre-turn snapshot by content hash, store the changed sides as blobs,
   * and update the recorded turn. `afterPaths` is the union of the original
   * candidates and any paths the turn created. A missing or already-closed turn
   * is a no-op.
   */
  async endTurn(turnId: string, afterPaths: readonly string[] = []): Promise<void> {
    return this.run(async () => {
      const pending = this.pending.get(turnId);
      if (!pending) {
        return;
      }
      this.pending.delete(turnId);

      const roots = this.fs.workspaceRoots();
      const afterKeys = new Set<string>(pending.before.keys());
      // Observed paths have no pre-turn snapshot, but they still need a
      // post-turn snapshot so a created/observed file's content is stored.
      for (const path of pending.observations.keys()) {
        afterKeys.add(path);
      }
      for (const raw of afterPaths) {
        const path = canonicalAbsPath(raw);
        if (!pending.display.has(path)) {
          pending.display.set(path, raw);
        }
        const shown = pending.display.get(path) ?? raw;
        if (workspaceRelative(shown, roots) && !(await this.ignored(shown))) {
          afterKeys.add(path);
        }
      }
      const after = new Map<string, FileSnapshot | null>();
      for (const path of afterKeys) {
        after.set(path, await this.snapshot(pending.display.get(path) ?? path));
      }

      const { drafts, bytes } = await this.buildDrafts(pending, after);

      const index = this.loadIndex();
      const turn = index.turns.find((entry) => entry.turnId === turnId);
      if (!turn) {
        return;
      }
      turn.files = drafts.map((draft) => draft.entry);
      turn.bytes = bytes;
      // A real diff is itself an observation, even when the change came from a
      // pre-turn candidate that no watcher or report named. An empty, unobserved
      // turn stays `observed: false`, so silence is never a verified no-op.
      turn.observed = pending.observed || drafts.length > 0;
      turn.endedAt = this.now();
      await this.persist(index);
      await this.prune();
    });
  }

  /**
   * Mark a turn as under review. Pruning never evicts it until `endReview`, so
   * a revert flow always has the bytes it is inspecting. Idempotent.
   */
  beginReview(turnId: string): void {
    this.reviewing = turnId;
  }

  /** Clear the protected turn. Safe to call when nothing is under review. */
  endReview(): void {
    this.reviewing = undefined;
  }

  /* --------------------------- restore points ------------------------------ */

  /**
   * Durably capture the current content of the given files, so an operation
   * about to modify them can be undone. Content is written to the blob store
   * *before* the index is updated; if any write fails, the point is not recorded
   * and the error propagates, so the caller can abort without having modified a
   * workspace file. Re-capturing the same id replaces the point.
   */
  async captureRestorePoint(input: CaptureRestorePointInput): Promise<JournalRestorePoint> {
    return this.run(async () => {
      const written: string[] = [];
      const files: RestorePointFile[] = [];
      try {
        for (let i = 0; i < input.files.length; i += 1) {
          const file = input.files[i];
          const blobs: string[] = [];
          let blobKey: string | undefined;
          if (file.bytes) {
            blobKey = `restore-points/${blobSafe(input.id)}/${i}.content`;
            await this.fs.writeBlob(blobKey, file.bytes);
            written.push(blobKey);
            blobs.push(blobKey);
          }
          files.push({
            absPath: file.absPath,
            relPath: file.relPath,
            ...(file.bytes ? { hash: hashBytes(file.bytes) } : {}),
            ...(blobKey ? { blobKey } : {}),
            sizeBytes: file.bytes?.length ?? 0,
            ...(input.expectedHashes[file.relPath] !== undefined
              ? { expectedHash: input.expectedHashes[file.relPath] }
              : {})
          });
        }
      } catch (error) {
        for (const key of written) {
          await this.fs.deleteBlob(key);
        }
        throw error;
      }

      const bytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
      const point: JournalRestorePoint = {
        id: input.id,
        threadId: input.threadId,
        backendId: input.backendId,
        createdAt: input.createdAt ?? this.now(),
        files,
        bytes
      };
      const index = this.loadIndex();
      const previous = index.restorePoints.find((entry) => entry.id === input.id);
      if (previous) {
        // Drop the old point before deleting blobs, so a blob still referenced
        // by a message checkpoint or another point is left in place.
        index.restorePoints = index.restorePoints.filter((entry) => entry.id !== input.id);
        await this.deleteRestorePointBlobs(previous);
      }
      index.restorePoints = index.restorePoints.filter((entry) => entry.id !== input.id);
      index.restorePoints.push(point);
      await this.persist(index);
      await this.prune();
      return copyRestorePoint(point);
    });
  }

  /**
   * Record the content hashes the workspace holds once the operation that
   * created a point has finished. A later undo uses these to tell a file that
   * merely reflects the operation from one the user has since edited, so an undo
   * never silently clobbers a later edit.
   */
  async sealRestorePoint(id: string, expectedHashes: Readonly<Record<string, string | undefined>>): Promise<void> {
    return this.run(async () => {
      const index = this.loadIndex();
      const point = index.restorePoints.find((entry) => entry.id === id);
      if (!point) {
        return;
      }
      for (const file of point.files) {
        const hash = expectedHashes[file.relPath];
        if (hash === undefined) {
          delete file.expectedHash;
        } else {
          file.expectedHash = hash;
        }
      }
      await this.persist(index);
    });
  }

  /** A captured restore point by id, or `undefined`. */
  getRestorePoint(id: string): JournalRestorePoint | undefined {
    const point = this.loadIndex().restorePoints.find((entry) => entry.id === id);
    return point ? copyRestorePoint(point) : undefined;
  }

  /** A thread's restore points, newest first. */
  listRestorePoints(threadId: string): JournalRestorePoint[] {
    return this.loadIndex()
      .restorePoints.filter((point) => point.threadId === threadId)
      .reverse()
      .map(copyRestorePoint);
  }

  /**
   * Attach the chat rewind to a file undo point the restore just captured.
   * Called by the host after the file snapshot succeeds and before the
   * transcript is truncated. A missing point is a no-op.
   */
  async attachRewind(id: string, rewind: RestoreRewind): Promise<void> {
    return this.run(async () => {
      const index = this.loadIndex();
      const point = index.restorePoints.find((entry) => entry.id === id);
      if (!point) {
        return;
      }
      point.rewind = {
        ...rewind,
        transcript: rewind.transcript.slice(),
        plans: rewind.plans.map(copyPlanRecord),
        turns: rewind.turns.map(copyTurn),
        checkpoints: rewind.checkpoints.map(copyCheckpoint)
      };
      await this.persist(index);
    });
  }

  /** The captured content for one file of a restore point, or `undefined`. */
  async getRestorePointContent(pointId: string, relPath: string): Promise<Uint8Array | undefined> {
    const point = this.loadIndex().restorePoints.find((entry) => entry.id === pointId);
    const file = point?.files.find((entry) => entry.relPath === toPosix(relPath));
    if (!file || !file.blobKey) {
      return undefined;
    }
    return this.fs.readBlob(file.blobKey);
  }

  /* -------------------------- message checkpoints -------------------------- */

  /**
   * Snapshot the named paths and every thread's plan as they are now, and
   * address the result by message id. Re-capturing the same message replaces
   * it. A path outside the workspace or ignored by review rules is skipped.
   * An absent file is recorded as absent so a later create can be deleted.
   */
  async captureMessageCheckpoint(input: CaptureMessageCheckpointInput): Promise<MessageCheckpoint> {
    return this.run(async () => {
      const roots = this.fs.workspaceRoots();
      const files: MessageCheckpointFile[] = [];
      const written: string[] = [];
      let bytes = 0;
      try {
        const seen = new Set<string>();
        for (const absPath of input.paths) {
          const located = workspaceRelative(absPath, roots);
          if (!located || seen.has(located.relPath) || (await this.ignored(absPath))) {
            continue;
          }
          seen.add(located.relPath);
          const snap = await this.snapshot(absPath);
          if (!snap || !storable(snap, snap.binary, this.maxInlineBytes)) {
            files.push({
              absPath,
              relPath: located.relPath,
              ...(snap ? { hash: snap.hash } : {}),
              sizeBytes: snap?.size ?? 0
            });
            continue;
          }
          const existing =
            files.find((entry) => entry.hash === snap.hash && entry.blobKey)?.blobKey ?? this.blobKeyForHash(snap.hash);
          let blobKey = existing;
          if (!blobKey) {
            blobKey = `checkpoints/${blobSafe(input.messageId)}/${files.length}.content`;
            await this.fs.writeBlob(blobKey, snap.bytes);
            written.push(blobKey);
            bytes += snap.size;
          }
          files.push({
            absPath,
            relPath: located.relPath,
            hash: snap.hash,
            blobKey,
            sizeBytes: snap.size
          });
        }
      } catch (error) {
        for (const key of written) {
          await this.fs.deleteBlob(key);
        }
        throw error;
      }

      const checkpoint: MessageCheckpoint = {
        messageId: input.messageId,
        threadId: input.threadId,
        backendId: input.backendId,
        createdAt: input.createdAt ?? this.now(),
        files,
        plans: input.plans.map(copyPlanRecord),
        bytes
      };
      const index = this.loadIndex();
      const checkpoints = index.checkpoints ?? [];
      const previous = checkpoints.find(
        (entry) => entry.threadId === input.threadId && entry.messageId === input.messageId
      );
      const remaining = checkpoints.filter(
        (entry) => !(entry.threadId === input.threadId && entry.messageId === input.messageId)
      );
      // Install the replacement before deleting the old blobs, so a blob the
      // new snapshot reused is still referenced and is not removed.
      index.checkpoints = [...remaining, checkpoint];
      if (previous) {
        await this.deleteCheckpointBlobs(previous);
      }
      await this.persist(index);
      await this.prune();
      return copyCheckpoint(checkpoint);
    });
  }

  /** One message's send-time snapshot, or `undefined`. */
  getMessageCheckpoint(threadId: string, messageId: string): MessageCheckpoint | undefined {
    const checkpoint = this.checkpoints().find(
      (entry) => entry.threadId === threadId && entry.messageId === messageId
    );
    return checkpoint ? copyCheckpoint(checkpoint) : undefined;
  }

  /** A thread's message checkpoints, newest first. */
  listMessageCheckpoints(threadId: string): MessageCheckpoint[] {
    return this.checkpoints()
      .filter((entry) => entry.threadId === threadId)
      .reverse()
      .map(copyCheckpoint);
  }

  /** Stored bytes for one file of a message checkpoint, or `undefined`. */
  async readCheckpointFile(threadId: string, messageId: string, relPath: string): Promise<Uint8Array | undefined> {
    const checkpoint = this.getMessageCheckpoint(threadId, messageId);
    const file = checkpoint?.files.find((entry) => entry.relPath === toPosix(relPath));
    if (!file?.blobKey) {
      return undefined;
    }
    return this.fs.readBlob(file.blobKey);
  }

  /**
   * Absolute paths the journal has already recorded, across every thread.
   * The host adds open editors and passes the union back into
   * `captureMessageCheckpoint`.
   */
  trackedAbsPaths(): string[] {
    const paths = new Set<string>();
    for (const turn of this.loadIndex().turns) {
      for (const file of turn.files) {
        paths.add(file.absPath);
      }
    }
    for (const checkpoint of this.checkpoints()) {
      for (const file of checkpoint.files) {
        paths.add(file.absPath);
      }
    }
    return [...paths];
  }

  /** Every recorded turn, oldest first. */
  listAllTurns(): JournalTurn[] {
    return this.loadIndex().turns.map(copyTurn);
  }

  /**
   * Remove this thread's message checkpoint and every later checkpoint, plus
   * turns that were still open or finished at or after that moment. Blobs stay
   * so the host can attach the removed entries to an undo point. Returns the
   * removed entries.
   */
  async detachFromMessage(
    threadId: string,
    messageId: string
  ): Promise<{ turns: JournalTurn[]; checkpoints: MessageCheckpoint[] }> {
    return this.run(async () => {
      const index = this.loadIndex();
      const checkpoint = (index.checkpoints ?? []).find(
        (entry) => entry.threadId === threadId && entry.messageId === messageId
      );
      if (!checkpoint) {
        return { turns: [], checkpoints: [] };
      }
      const createdAt = checkpoint.createdAt;
      const stored = index.checkpoints ?? [];
      const checkpoints = stored.filter((entry) => entry.threadId === threadId && entry.createdAt >= createdAt);
      const turns = index.turns.filter((turn) => {
        if (turn.threadId !== threadId) {
          return false;
        }
        const ended = turn.endedAt ?? Number.POSITIVE_INFINITY;
        return turn.startedAt >= createdAt || ended >= createdAt;
      });
      const checkpointIds = new Set(checkpoints.map((entry) => entry.messageId));
      const turnIds = new Set(turns.map((turn) => turn.turnId));
      index.checkpoints = stored.filter((entry) => !(entry.threadId === threadId && checkpointIds.has(entry.messageId)));
      index.turns = index.turns.filter((turn) => !turnIds.has(turn.turnId));
      await this.persist(index);
      return { turns: turns.map(copyTurn), checkpoints: checkpoints.map(copyCheckpoint) };
    });
  }

  /** Put turns and message checkpoints back after an undo. Existing ids are left as they are. */
  async reinsert(turns: readonly JournalTurn[], checkpoints: readonly MessageCheckpoint[]): Promise<void> {
    return this.run(async () => {
      const index = this.loadIndex();
      for (const turn of turns) {
        if (!index.turns.some((entry) => entry.turnId === turn.turnId)) {
          index.turns.push(copyTurn(turn));
        }
      }
      index.turns.sort((a, b) => a.startedAt - b.startedAt);
      const stored = index.checkpoints ?? [];
      for (const checkpoint of checkpoints) {
        if (
          !stored.some((entry) => entry.threadId === checkpoint.threadId && entry.messageId === checkpoint.messageId)
        ) {
          stored.push(copyCheckpoint(checkpoint));
        }
      }
      stored.sort((a, b) => a.createdAt - b.createdAt);
      index.checkpoints = stored;
      await this.persist(index);
    });
  }

  /* ------------------------------- reads ----------------------------------- */

  /** The recorded turn, or `undefined` for an unknown id. */
  getTurn(turnId: string): JournalTurn | undefined {
    const turn = this.loadIndex().turns.find((entry) => entry.turnId === turnId);
    return turn ? copyTurn(turn) : undefined;
  }

  /** A thread's turns, newest first. Empty when the thread has none. */
  listTurns(threadId: string): JournalTurn[] {
    // The index is kept in chronological insertion order (new turns are pushed,
    // pruning preserves order), so newest-first is a reverse rather than a
    // timestamp sort that could be ambiguous for two turns in one millisecond.
    return this.loadIndex()
      .turns.filter((turn) => turn.threadId === threadId)
      .reverse()
      .map(copyTurn);
  }

  /** The stored before content for a file, or `undefined` when absent. */
  async getBefore(turnId: string, relPath: string): Promise<Uint8Array | undefined> {
    const entry = this.findFile(turnId, relPath);
    if (!entry || !entry.beforeKey) {
      return undefined;
    }
    return this.fs.readBlob(entry.beforeKey);
  }

  /** The stored after content for a file, or `undefined` when absent. */
  async getAfter(turnId: string, relPath: string): Promise<Uint8Array | undefined> {
    const entry = this.findFile(turnId, relPath);
    if (!entry || !entry.afterKey) {
      return undefined;
    }
    return this.fs.readBlob(entry.afterKey);
  }

  /**
   * The blob stored under `key`, or `undefined` when it is gone. A session
   * review reads the baseline from an earlier turn and the result from a later
   * one, so it addresses the keys directly instead of one turn's path.
   */
  async readBlob(key: string): Promise<Uint8Array | undefined> {
    return this.fs.readBlob(key);
  }

  /** Workspace bytes for listing rules that read `.gitignore`. Missing is `undefined`. */
  readWorkspaceFile(absPath: string): Promise<Uint8Array | undefined> {
    return this.fs.readFile(absPath);
  }

  /* ----------------------------- internals --------------------------------- */

  private findFile(turnId: string, relPath: string): JournalFileEntry | undefined {
    const turn = this.loadIndex().turns.find((entry) => entry.turnId === turnId);
    if (!turn) {
      return undefined;
    }
    const target = toPosix(relPath).replace(/^\.\//, '');
    return turn.files.find((file) => file.relPath === target);
  }

  /**
   * Paths the review must not attribute to the agent: ignored directories, and
   * anything excluded by a `.gitignore` from the workspace root down to the
   * file. A missing gitignore ignores only the fixed directory names.
   */
  private async ignored(absPath: string): Promise<boolean> {
    const located = workspaceRelative(absPath, this.fs.workspaceRoots());
    if (!located) {
      return false;
    }
    const sources = await reviewSources(
      located.root,
      located.relPath,
      (path) => this.fs.readFile(path),
      this.gitignoreCache
    );
    return excludedByIgnore(located.relPath, sources);
  }

  private async snapshot(absPath: string): Promise<FileSnapshot | null> {
    const bytes = await this.fs.readFile(absPath);
    if (!bytes) {
      return null;
    }
    return {
      hash: hashBytes(bytes),
      size: bytes.length,
      binary: sniffBinary(bytes),
      bytes
    };
  }

  /**
   * Turn the before/after snapshots into file entries, storing a blob for each
   * inline-able side. Renames are recognised by a matching content hash between
   * a before-only and an after-only path, so a rename is never reported as a
   * delete plus a create.
   */
  private async buildDrafts(
    pending: PendingTurn,
    after: Map<string, FileSnapshot | null>
  ): Promise<{ drafts: Draft[]; bytes: number }> {
    const before = pending.before;
    const observations = pending.observations;
    const paths = new Set<string>([...before.keys(), ...after.keys(), ...observations.keys()]);
    const modified: string[] = [];
    const beforeOnly: string[] = [];
    const afterOnly = new Map<string, FileSnapshot>();
    /**
     * Paths a report or the watcher named that have no pre-turn snapshot. A
     * watcher fires after a shell write, so there is no before side to diff; the
     * observation itself is the evidence and its status hint names the kind.
     */
    const observedOnly: string[] = [];

    for (const path of paths) {
      const a = after.get(path) ?? null;
      if (!before.has(path)) {
        if (observations.has(path)) {
          observedOnly.push(path);
        } else if (a) {
          afterOnly.set(path, a);
        }
        continue;
      }
      const b = before.get(path) ?? null;
      if (b && a) {
        // Two real sides and equal hashes is a verified no-op, even when the
        // path was also observed: nothing is recorded.
        if (b.hash !== a.hash) {
          modified.push(path);
        }
      } else if (b) {
        beforeOnly.push(path);
      } else if (a) {
        afterOnly.set(path, a);
      }
    }

    const roots = this.fs.workspaceRoots();
    const shown = (key: string): string => pending.display.get(key) ?? key;
    const drafts: Draft[] = [];
    const usedAfter = new Set<string>();

    for (const path of modified) {
      const b = before.get(path) as FileSnapshot;
      const a = after.get(path) as FileSnapshot;
      const relPath = workspaceRelative(shown(path), roots)?.relPath ?? toPosix(shown(path));
      drafts.push({
        entry: this.entryFor({ absPath: shown(path), relPath, source: sourceOf(pending, path), beforeHash: b.hash, afterHash: a.hash, sizeBytes: a.size, binary: b.binary || a.binary }),
        before: b,
        after: a
      });
    }

    for (const from of beforeOnly) {
      const b = before.get(from) as FileSnapshot;
      const to = [...afterOnly.keys()].find((candidate) => !usedAfter.has(candidate) && afterOnly.get(candidate)?.hash === b.hash);
      if (to) {
        usedAfter.add(to);
        const a = afterOnly.get(to) as FileSnapshot;
        drafts.push({
          entry: {
            ...this.entryFor({
              absPath: shown(to),
              relPath: workspaceRelative(shown(to), roots)?.relPath ?? toPosix(shown(to)),
              source: sourceOf(pending, from, to),
              beforeHash: b.hash,
              afterHash: a.hash,
              sizeBytes: a.size,
              binary: b.binary || a.binary,
              renamedFrom: workspaceRelative(shown(from), roots)?.relPath ?? toPosix(shown(from))
            }),
            status: 'renamed'
          },
          before: b,
          after: a
        });
      } else {
        drafts.push({
          entry: {
            ...this.entryFor({
              absPath: shown(from),
              relPath: workspaceRelative(shown(from), roots)?.relPath ?? toPosix(shown(from)),
              source: sourceOf(pending, from),
              beforeHash: b.hash,
              sizeBytes: b.size,
              binary: b.binary
            }),
            status: 'deleted',
            hasAfter: false
          },
          before: b
        });
      }
    }

    for (const [path, a] of afterOnly) {
      if (usedAfter.has(path)) {
        continue;
      }
      drafts.push({
        entry: {
          ...this.entryFor({
            absPath: shown(path),
            relPath: workspaceRelative(shown(path), roots)?.relPath ?? toPosix(shown(path)),
            source: sourceOf(pending, path),
            afterHash: a.hash,
            sizeBytes: a.size,
            binary: a.binary
          }),
          status: 'created',
          hasBefore: false
        },
        after: a
      });
    }

    for (const path of observedOnly) {
      const observation = observations.get(path);
      const hint = observation?.status;
      // A watcher event with no pre-turn snapshot still names a file the turn
      // wrote. It is listed as that kind of change. The review does not invent
      // a line diff when the before bytes were never stored.
      const status: ChangeStatus = hint === 'deleted' ? 'deleted' : hint === 'created' ? 'created' : 'modified';
      const a = after.get(path) ?? undefined;
      // File watchers also report created directories. Without readable file
      // bytes there is no created file to review (or safely reject).
      if (status === 'created' && !a) {
        continue;
      }
      // A reported edit with no pre-turn snapshot used to diff the finished
      // file against empty content, so one changed line reviewed as the whole
      // file. Reverse the reported patch onto the post-edit bytes when it
      // applies, and keep that recovered text as the before side.
      if (status === 'modified' && a && !a.binary && observation) {
        const recovered = recoverObservedBefore(new TextDecoder().decode(a.bytes), observation);
        if (recovered !== undefined) {
          const beforeBytes = new TextEncoder().encode(recovered);
          const beforeSnap: FileSnapshot = {
            hash: hashBytes(beforeBytes),
            size: beforeBytes.length,
            binary: sniffBinary(beforeBytes),
            bytes: beforeBytes
          };
          if (beforeSnap.hash !== a.hash) {
            const relPath = workspaceRelative(shown(path), roots)?.relPath ?? toPosix(shown(path));
            drafts.push({
              entry: this.entryFor({
                absPath: shown(path),
                relPath,
                source: observation.source,
                beforeHash: beforeSnap.hash,
                afterHash: a.hash,
                sizeBytes: a.size,
                binary: beforeSnap.binary || a.binary
              }),
              before: beforeSnap,
              after: a
            });
            continue;
          }
        }
      }
      drafts.push({
        entry: {
          ...this.entryFor({
            absPath: shown(path),
            relPath: workspaceRelative(shown(path), roots)?.relPath ?? toPosix(shown(path)),
            source: observation?.source ?? 'watched',
            afterHash: status === 'deleted' ? undefined : a?.hash,
            sizeBytes: a?.size ?? 0,
            binary: Boolean(a?.binary)
          }),
          status,
          hasBefore: false,
          hasAfter: status !== 'deleted'
        },
        after: status === 'deleted' ? undefined : a
      });
    }

    const uniqueDrafts = new Map<string, Draft>();
    for (const draft of drafts) {
      const key = relPathKey(draft.entry.relPath);
      const existing = uniqueDrafts.get(key);
      if (!existing || draftRank(draft) > draftRank(existing)) {
        uniqueDrafts.set(key, draft);
      }
    }
    const unique = [...uniqueDrafts.values()];
    unique.sort((a, b) => (a.entry.relPath < b.entry.relPath ? -1 : a.entry.relPath > b.entry.relPath ? 1 : 0));

    let bytes = 0;
    for (let i = 0; i < unique.length; i += 1) {
      const draft = unique[i];
      const { entry } = draft;
      // A side is storable only when the content is text and within the cap.
      // The entry is inline-able only when every side it represents is storable,
      // so a file that is binary or oversize on either side is never reported
      // inline-able even though its hash and size are still recorded.
      const beforeStorable = draft.before !== undefined && storable(draft.before, entry.binary, this.maxInlineBytes);
      const afterStorable = draft.after !== undefined && storable(draft.after, entry.binary, this.maxInlineBytes);
      entry.inlineable =
        (draft.before === undefined || beforeStorable) && (draft.after === undefined || afterStorable);
      if (beforeStorable && draft.before) {
        const key = `turns/${blobSafe(pending.turnId)}/${i}.before`;
        await this.fs.writeBlob(key, draft.before.bytes);
        entry.beforeKey = key;
        bytes += draft.before.bytes.length;
      }
      if (afterStorable && draft.after) {
        const key = `turns/${blobSafe(pending.turnId)}/${i}.after`;
        await this.fs.writeBlob(key, draft.after.bytes);
        entry.afterKey = key;
        bytes += draft.after.bytes.length;
      }
    }
    return { drafts: unique, bytes };
  }

  /** Build a draft entry with the shared fields filled, status `modified`. */
  private entryFor(input: {
    absPath: string;
    relPath: string;
    source: ChangeSource;
    beforeHash?: string;
    afterHash?: string;
    sizeBytes: number;
    binary: boolean;
    renamedFrom?: string;
  }): JournalFileEntry {
    return {
      absPath: input.absPath,
      relPath: input.relPath,
      status: 'modified',
      source: input.source,
      beforeHash: input.beforeHash,
      afterHash: input.afterHash,
      sizeBytes: input.sizeBytes,
      binary: input.binary,
      inlineable: false,
      hasBefore: input.beforeHash !== undefined,
      hasAfter: input.afterHash !== undefined,
      renamedFrom: input.renamedFrom
    };
  }

  /**
   * Keep the index within its count cap and the blob store within its byte
   * budget, deleting the blobs of every evicted turn and restore point. The turn
   * under review is never evicted, even when that leaves the store temporarily
   * over budget.
   */
  private async prune(): Promise<void> {
    const index = this.loadIndex();
    let changed = false;
    const total = (): number =>
      index.turns.reduce((sum, turn) => sum + turn.bytes, 0) +
      index.restorePoints.reduce((sum, point) => sum + point.bytes, 0) +
      (index.checkpoints ?? []).reduce((sum, checkpoint) => sum + checkpoint.bytes, 0);

    while (index.turns.length > this.maxTurns || total() > this.maxBlobBytes) {
      const ordered = [...index.turns].sort((a, b) => a.startedAt - b.startedAt);
      const victim = ordered.find((turn) => turn.turnId !== this.reviewing);
      if (!victim) {
        break;
      }
      index.turns = index.turns.filter((turn) => turn.turnId !== victim.turnId);
      await this.deleteTurnBlobs(victim);
      changed = true;
      if (index.turns.length <= this.maxTurns && total() <= this.maxBlobBytes) {
        break;
      }
    }

    const checkpointList = (): MessageCheckpoint[] => index.checkpoints ?? [];
    while (checkpointList().length > this.maxTurns || total() > this.maxBlobBytes) {
      const ordered = [...checkpointList()].sort((a, b) => a.createdAt - b.createdAt);
      const victim = ordered[0];
      if (!victim) {
        break;
      }
      index.checkpoints = checkpointList().filter(
        (entry) => !(entry.threadId === victim.threadId && entry.messageId === victim.messageId)
      );
      await this.deleteCheckpointBlobs(victim);
      changed = true;
      if (checkpointList().length <= this.maxTurns && total() <= this.maxBlobBytes) {
        break;
      }
    }

    // Restore points share the same byte budget. They are pruned oldest-first.
    while (index.restorePoints.length > this.maxRestorePoints || total() > this.maxBlobBytes) {
      const ordered = [...index.restorePoints].sort((a, b) => a.createdAt - b.createdAt);
      const victim = ordered[0];
      if (!victim) {
        break;
      }
      index.restorePoints = index.restorePoints.filter((point) => point.id !== victim.id);
      await this.deleteRestorePointBlobs(victim);
      changed = true;
      if (index.restorePoints.length <= this.maxRestorePoints && total() <= this.maxBlobBytes) {
        break;
      }
    }

    if (changed) {
      await this.persist(index);
    }
  }

  private checkpoints(): MessageCheckpoint[] {
    return this.loadIndex().checkpoints ?? [];
  }

  /** A blob key already stored for this hash, so a later snapshot can share it. */
  private blobKeyForHash(hash: string): string | undefined {
    const index = this.loadIndex();
    for (const checkpoint of index.checkpoints ?? []) {
      for (const file of checkpoint.files) {
        if (file.hash === hash && file.blobKey) {
          return file.blobKey;
        }
      }
    }
    for (const turn of index.turns) {
      for (const file of turn.files) {
        if (file.beforeHash === hash && file.beforeKey) {
          return file.beforeKey;
        }
        if (file.afterHash === hash && file.afterKey) {
          return file.afterKey;
        }
      }
    }
    for (const point of index.restorePoints) {
      for (const file of point.files) {
        if (file.hash === hash && file.blobKey) {
          return file.blobKey;
        }
      }
    }
    return undefined;
  }

  /** True when some surviving index entry still points at this blob. */
  private blobReferenced(key: string): boolean {
    const index = this.loadIndex();
    for (const turn of index.turns) {
      for (const file of turn.files) {
        if (file.beforeKey === key || file.afterKey === key) {
          return true;
        }
      }
    }
    for (const checkpoint of index.checkpoints ?? []) {
      for (const file of checkpoint.files) {
        if (file.blobKey === key) {
          return true;
        }
      }
    }
    for (const point of index.restorePoints) {
      for (const file of point.files) {
        if (file.blobKey === key) {
          return true;
        }
      }
      for (const turn of point.rewind?.turns ?? []) {
        for (const file of turn.files) {
          if (file.beforeKey === key || file.afterKey === key) {
            return true;
          }
        }
      }
      for (const checkpoint of point.rewind?.checkpoints ?? []) {
        for (const file of checkpoint.files) {
          if (file.blobKey === key) {
            return true;
          }
        }
      }
    }
    return false;
  }

  private async deleteBlobIfUnused(key: string | undefined): Promise<void> {
    if (!key || this.blobReferenced(key)) {
      return;
    }
    await this.fs.deleteBlob(key);
  }

  private async deleteTurnBlobs(turn: JournalTurn): Promise<void> {
    for (const file of turn.files) {
      await this.deleteBlobIfUnused(file.beforeKey);
      await this.deleteBlobIfUnused(file.afterKey);
    }
  }

  private async deleteCheckpointBlobs(checkpoint: MessageCheckpoint): Promise<void> {
    for (const file of checkpoint.files) {
      await this.deleteBlobIfUnused(file.blobKey);
    }
  }

  private async deleteRestorePointBlobs(point: JournalRestorePoint): Promise<void> {
    for (const file of point.files) {
      await this.deleteBlobIfUnused(file.blobKey);
    }
    for (const turn of point.rewind?.turns ?? []) {
      await this.deleteTurnBlobs(turn);
    }
    for (const checkpoint of point.rewind?.checkpoints ?? []) {
      await this.deleteCheckpointBlobs(checkpoint);
    }
  }

  private loadIndex(): JournalIndex {
    if (!this.index) {
      const stored = this.storage.get<JournalIndex | undefined>(JOURNAL_KEY, undefined);
      this.index =
        stored && Array.isArray(stored.turns)
          ? {
              turns: stored.turns,
              restorePoints: Array.isArray(stored.restorePoints) ? stored.restorePoints : [],
              checkpoints: Array.isArray(stored.checkpoints) ? stored.checkpoints : []
            }
          : { turns: [], restorePoints: [], checkpoints: [] };
    }
    if (!Array.isArray(this.index.checkpoints)) {
      this.index.checkpoints = [];
    }
    return this.index;
  }

  private async persist(index: JournalIndex): Promise<void> {
    this.index = index;
    await this.storage.update(JOURNAL_KEY, index);
  }

  /** Serialise a mutation behind any in-flight one. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn, fn);
    this.chain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

/** A shallow copy, so a caller cannot mutate the cached index through a read. */
function copyTurn(turn: JournalTurn): JournalTurn {
  return { ...turn, files: turn.files.map((file) => ({ ...file })) };
}

/** A shallow copy of a restore point, so a read cannot mutate the cached index. */
function copyRestorePoint(point: JournalRestorePoint): JournalRestorePoint {
  return {
    ...point,
    files: point.files.map((file) => ({ ...file })),
    ...(point.rewind
      ? {
          rewind: {
            ...point.rewind,
            transcript: point.rewind.transcript.slice(),
            plans: point.rewind.plans.map(copyPlanRecord),
            turns: point.rewind.turns.map(copyTurn),
            checkpoints: point.rewind.checkpoints.map(copyCheckpoint)
          }
        }
      : {})
  };
}

function copyCheckpoint(checkpoint: MessageCheckpoint): MessageCheckpoint {
  return {
    ...checkpoint,
    files: checkpoint.files.map((file) => ({ ...file })),
    plans: checkpoint.plans.map(copyPlanRecord)
  };
}

function copyPlanRecord(record: CheckpointPlanRecord): CheckpointPlanRecord {
  return {
    ...record,
    ...(record.state
      ? { state: { ...record.state, steps: record.state.steps.map((step) => ({ ...step })) } }
      : {})
  };
}

/**
 * How a turn's change was learned, preferring a structured `reported` fact over
 * a watcher observation. A rename consults both the pre- and post-turn paths, so
 * the move is attributed to the turn even if only one side was observed. A
 * candidate that the turn neither reported nor watched was still a pre-turn
 * snapshot of a path we were told to expect, which is the watcher's remit.
 */
/**
 * The pre-edit text of a file that had no turn-start snapshot.
 *
 * A full before/after pair is used only when the reported after text still
 * matches disk. Otherwise the tool's old/new strings, then its unified diff,
 * are reversed onto the finished file. An empty result is refused: that is a
 * patch that claims the whole file was added, which would review as a green wash.
 */
function recoverObservedBefore(afterText: string, observation: Observation): string | undefined {
  if (
    observation.beforeText !== undefined &&
    observation.afterText !== undefined &&
    observation.beforeText.length > 0 &&
    observation.beforeText !== observation.afterText &&
    sameFileText(observation.afterText, afterText)
  ) {
    return observation.beforeText;
  }
  if (observation.replacements.length > 0) {
    const replaced = contentBeforeReplacements(afterText, observation.replacements);
    if (replaced !== undefined && replaced.length > 0) {
      return replaced;
    }
  }
  if (observation.diffs.length > 0) {
    const patched = contentBeforePatches(afterText, observation.diffs);
    if (patched !== undefined && patched.length > 0) {
      return patched;
    }
  }
  return undefined;
}

function sameFileText(reported: string, onDisk: string): boolean {
  return reported.replace(/\r\n/g, '\n') === onDisk.replace(/\r\n/g, '\n');
}

function sourceOf(pending: PendingTurn, ...paths: string[]): ChangeSource {
  for (const path of paths) {
    if (pending.observations.get(path)?.source === 'reported') {
      return 'reported';
    }
  }
  return 'watched';
}

export function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * One identity for an absolute path. Slash style never makes two keys, and on
 * Windows neither does letter case, so a report and a watcher event for the
 * same file stay one observation.
 */
export function canonicalAbsPath(absPath: string): string {
  const posix = stripTrailingSlash(toPosix(absPath));
  return process.platform === 'win32' ? posix.toLowerCase() : posix;
}

/** Identity of a workspace-relative path, matching `canonicalAbsPath`. */
export function relPathKey(relPath: string): string {
  const posix = toPosix(relPath).replace(/^\.\//, '').replace(/^\/+/, '');
  return process.platform === 'win32' ? posix.toLowerCase() : posix;
}

/** Prefer a draft that has real before and after bytes over a second alias of the same file. */
function draftRank(draft: Draft): number {
  return (draft.before ? 2 : 0) + (draft.after ? 1 : 0);
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '');
}

/** A POSIX path relative to a root, or `undefined` when outside it. */
export function relativeWithin(absPath: string, root: string): string | undefined {
  const path = toPosix(absPath);
  const normalizedRoot = stripTrailingSlash(toPosix(root));
  if (normalizedRoot.length === 0) {
    return undefined;
  }
  if (path.toLowerCase() === normalizedRoot.toLowerCase()) {
    return '';
  }
  if (path.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
    return path.slice(normalizedRoot.length + 1);
  }
  return undefined;
}

/** The workspace root and relative path for an absolute path, or `undefined`. */
export function workspaceRelative(
  absPath: string,
  roots: readonly string[]
): { root: string; relPath: string } | undefined {
  for (const root of roots) {
    const relPath = relativeWithin(absPath, root);
    // `''` is a root directory, not a trackable file.
    if (relPath !== undefined && relPath.length > 0) {
      return { root, relPath };
    }
  }
  return undefined;
}

/** A side is storable when it is text and within the inline byte cap. */
function storable(snapshot: FileSnapshot, binary: boolean, maxInlineBytes: number): boolean {
  return !binary && snapshot.size <= maxInlineBytes;
}

/** A NUL byte in the first bytes marks the content binary. */
function sniffBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
}

/** A blob-path-safe form of a turn id. */
function blobSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
