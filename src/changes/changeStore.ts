import type { ChangeSource, ChangeStatus } from '../backends/types';
import type { DiffReviewResult } from '../review/diffReview.ts';
import { filterListedFiles, listedForReview, reviewSources, workspaceRootOf } from './ignore.ts';
import { relPathKey, type JournalFileEntry, type JournalStorage, type JournalTurn } from './journal.ts';
import { applyRejectedHunks, diffLines, type DiffLine } from './diff.ts';
import { hashBytes } from './hash.ts';

/**
 * The post-hoc change decision store.
 *
 * With a turn's before/after bytes recorded in the `ChangeJournal`, this store
 * owns the *decisions* a user makes about them: per file and per hunk, each
 * `pending` until the user acts. It is deliberately **not** the pre-execution
 * approval gate (`approvalStore.ts`): approvals block a tool call before it
 * runs, while this surface acts after the edit has already landed. The two never
 * touch each other's state.
 *
 * ## Invariants
 *
 * - **Decisions are never auto-made.** Nothing here accepts or rejects without
 *   an explicit call; there is no timer and no expiry, mirroring the approval
 *   invariant.
 * - **Accept writes nothing.** It only records the decision; the workspace is
 *   untouched, so a rejected-then-accepted file is byte-identical.
 * - **Reject restores, or reports failure.** A whole-file reject writes the
 *   exact pre-turn bytes back (or deletes a created file); a failed write is
 *   reported and the decision is *not* recorded as `rejected`.
 * - **A stale file is never clobbered.** Before writing, the current bytes are
 *   hashed and compared with the post-turn hash. If the file changed since the
 *   turn, the reject stops and returns a conflict; only an explicit
 *   `overwrite-pre-turn` writes.
 * - **Reload-safe, stale-tolerant.** Decisions persist, and an entry whose
 *   content no longer matches the recorded turn is dropped rather than shown as
 *   actionable — the same drop-if-mismatched rule as
 *   `reconcilePendingItems`/`mergeApprovalMarkers`.
 * - **Host-free.** No `vscode` import and no direct `fs`: every read and write
 *   goes through an injected seam, so `npm test` drives it with fakes and the
 *   thin binding lives in `vscodeChangeStore.ts`.
 */

/** A user decision on a file or one of its hunks. */
export type ChangeDecision = 'pending' | 'accepted' | 'rejected';

/** The explicit choice a conflict requires before a reject writes. */
export type ConflictResolution = 'keep-current' | 'overwrite-pre-turn';

/** One rendered hunk, with the decision the user made about it. */
export interface ChangeHunkView {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  additions: number;
  deletions: number;
  lines: DiffLine[];
  decision: ChangeDecision;
}

/** One changed file and its decisions, as the review surface reads it. */
export interface ChangeFileView {
  absPath: string;
  path: string;
  status: ChangeStatus;
  source: ChangeSource;
  binary: boolean;
  /** False when content was not stored (binary or oversize), so no diff exists. */
  diffable: boolean;
  additions: number;
  deletions: number;
  decision: ChangeDecision;
  hunks: ChangeHunkView[];
  /**
   * True when the snapshot lists hunks but omits their lines. The review loads
   * lines for one file when that row is expanded.
   */
  linesOmitted?: boolean;
  /** Plain-language reason a diff is unavailable, when it is. */
  detail?: string;
  /**
   * True when rejecting this file restores a real pre-change snapshot: the
   * stored before bytes, or deletion of a file this turn created. A modified
   * file with no before snapshot is not restorable — rejecting it cannot put
   * the old bytes back.
   */
  restorable?: boolean;
}

/** The whole review snapshot the host pushes to the webview. */
export interface ChangeView {
  backendId: string;
  threadId: string;
  turnId: string;
  /** The user message that opened this turn, when the journal recorded one. */
  messageId?: string;
  files: ChangeFileView[];
  additions: number;
  deletions: number;
  /** True when every file and hunk has a non-`pending` decision. */
  fullyDecided: boolean;
  /**
   * The advisory second-pass review for this turn, when the user opted in and
   * one was stored. It never changes a decision: Keep and Reject remain the
   * only actions, and a failed review is represented here as a notice.
   */
  diffReview?: DiffReviewResult;
}

/** A decision request for one file, or one hunk when `hunkId` is set. */
export interface DecideChangeInput {
  backendId: string;
  threadId: string;
  turnId: string;
  relPath: string;
  hunkId?: string;
  decision: 'accepted' | 'rejected';
  /** Required to complete a reject the conflict guard stopped. */
  conflictResolution?: ConflictResolution;
}

/** A per-file outcome, so a partial failure is never hidden. */
export interface ChangeDecisionResult {
  relPath: string;
  decision: ChangeDecision;
  /** True when the decision took effect (a write may have been a no-op). */
  ok: boolean;
  /** True when the file changed since the turn and a choice is required. */
  conflict?: boolean;
  /** Plain-language reason the decision did not take effect. */
  error?: string;
}

/** A whole-turn decision request, applied to every file. */
export interface DecideAllInput {
  backendId: string;
  threadId: string;
  turnId: string;
  decision: 'accepted' | 'rejected';
  conflictResolution?: ConflictResolution;
}

/** The workspace write seam, bound to `vscode.workspace.fs` by the host. */
export interface ChangeWorkspaceFs {
  /** Reads a workspace file's bytes, or `undefined` when absent/unreadable. */
  readFile(absPath: string): Promise<Uint8Array | undefined>;
  /** Writes a workspace file, creating it when absent. */
  writeFile(absPath: string, bytes: Uint8Array): Promise<void>;
  /** Deletes a workspace file; a missing file is not an error. */
  deleteFile(absPath: string): Promise<void>;
}

/** The recorded-artifact read seam, satisfied by `ChangeJournal`. */
export interface ChangeArtifacts {
  getTurn(turnId: string): JournalTurn | undefined;
  getBefore(turnId: string, relPath: string): Promise<Uint8Array | undefined>;
  getAfter(turnId: string, relPath: string): Promise<Uint8Array | undefined>;
  readBlob(key: string): Promise<Uint8Array | undefined>;
  beginReview(turnId: string): void;
  endReview(): void;
}

export interface ChangeStoreOptions {
  storage: JournalStorage;
  fs: ChangeWorkspaceFs;
  artifacts: ChangeArtifacts;
  /** Epoch milliseconds source, injected so tests are deterministic. */
  now?: () => number;
}

/** The `workspaceState` key the host and this module agree on. */
export const CHANGE_DECISIONS_KEY = 'melink.changeDecisions';

interface StoredDecision {
  backendId: string;
  threadId: string;
  turnId: string;
  relPath: string;
  /** Absent for a whole-file decision. */
  hunkId?: string;
  decision: 'accepted' | 'rejected';
  /**
   * `${beforeHash}>${afterHash}` at decision time. A later turn whose recorded
   * hashes differ means the decision references content that no longer exists,
   * so it is dropped rather than shown as actionable.
   */
  contentKey: string;
  decidedAt: number;
}

type DecisionMap = Record<string, StoredDecision[]>;

function sessionKey(backendId: string, threadId: string): string {
  return `${backendId}:${threadId}`;
}

function contentKey(entry: JournalFileEntry): string {
  return `${entry.beforeHash ?? ''}>${entry.afterHash ?? ''}`;
}

function decode(bytes: Uint8Array | undefined): string {
  return bytes ? new TextDecoder().decode(bytes) : '';
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export class ChangeStore {
  private cache?: DecisionMap;
  private readonly storage: JournalStorage;
  private readonly fs: ChangeWorkspaceFs;
  private readonly artifacts: ChangeArtifacts;
  private readonly now: () => number;

  constructor(options: ChangeStoreOptions) {
    this.storage = options.storage;
    this.fs = options.fs;
    this.artifacts = options.artifacts;
    this.now = options.now ?? (() => Date.now());
  }

  /* ------------------------------- reads ----------------------------------- */

  /**
   * The review snapshot for one turn: every recorded file, its diff, and the
   * decisions that still match the recorded content. Decisions referencing
   * content that no longer matches are dropped here, so a reload never shows a
   * stale decision as actionable. Returns `undefined` for an unknown turn.
   */
  async view(backendId: string, threadId: string, turnId: string): Promise<ChangeView | undefined> {
    const turn = this.artifacts.getTurn(turnId);
    if (!turn) {
      return undefined;
    }
    return this.compose(backendId, threadId, turn);
  }

  /**
   * The turn a decision addresses. Keep and undo apply to that turn's own
   * files and its own baseline, never to earlier steps in the same chat.
   */
  private reviewedTurn(turnId: string): JournalTurn | undefined {
    return this.artifacts.getTurn(turnId);
  }

  private async compose(backendId: string, threadId: string, turn: JournalTurn): Promise<ChangeView> {
    const decisions = this.validDecisions(backendId, threadId, turn.turnId, turn);
    const files: ChangeFileView[] = [];
    for (const entry of await filterListedFiles(turn.files, (path) => this.fs.readFile(path))) {
      files.push(await this.fileView(turn.turnId, entry, decisions));
    }
    const unique = dedupeChangeFiles(files);
    const additions = unique.reduce((sum, file) => sum + file.additions, 0);
    const deletions = unique.reduce((sum, file) => sum + file.deletions, 0);
    const fullyDecided =
      unique.length > 0 &&
      unique.every(
        (file) => file.decision !== 'pending' && file.hunks.every((hunk) => hunk.decision !== 'pending')
      );
    return {
      backendId,
      threadId,
      turnId: turn.turnId,
      ...(turn.messageId ? { messageId: turn.messageId } : {}),
      files: unique,
      additions,
      deletions,
      fullyDecided
    };
  }

  /** True when the strip and the review page show this file. */
  private async listedFile(entry: JournalFileEntry): Promise<boolean> {
    const root = workspaceRootOf(entry.absPath, entry.relPath);
    const sources = root
      ? await reviewSources(root, entry.relPath, (path) => this.fs.readFile(path), new Map())
      : [];
    return listedForReview(entry, sources);
  }

  /** The stored side of a file. A session row carries the blob key of the turn that owns that side. */
  private async readSide(
    turnId: string,
    entry: JournalFileEntry,
    side: 'before' | 'after'
  ): Promise<Uint8Array | undefined> {
    if (side === 'before') {
      if (!entry.hasBefore) {
        return undefined;
      }
      if (entry.beforeKey) {
        return this.artifacts.readBlob(entry.beforeKey);
      }
      return this.artifacts.getBefore(turnId, entry.relPath);
    }
    if (!entry.hasAfter) {
      return undefined;
    }
    if (entry.afterKey) {
      return this.artifacts.readBlob(entry.afterKey);
    }
    return this.artifacts.getAfter(turnId, entry.relPath);
  }

  /* ------------------------------ decisions -------------------------------- */

  /**
   * Apply one decision. Accept only records it; reject restores the pre-turn
   * bytes (or deletes a created file), stopping at a conflict unless the caller
   * supplied an explicit resolution. A failed write is reported and not
   * recorded, so a reject is never claimed to have succeeded when it did not.
   */
  async decide(input: DecideChangeInput): Promise<ChangeDecisionResult> {
    const turn = this.reviewedTurn(input.turnId);
    const wanted = relPathKey(toPosixRel(input.relPath));
    const matches = (turn?.files ?? []).filter((file) => relPathKey(file.relPath) === wanted);
    const entry = matches[0];
    if (!turn || !entry || !(await this.listedFile(entry))) {
      return { relPath: input.relPath, decision: 'pending', ok: false, error: 'That file is no longer part of this turn.' };
    }

    if (input.decision === 'accepted') {
      for (const match of matches) {
        if (!(await this.listedFile(match))) {
          continue;
        }
        await this.record({
          ...input,
          relPath: match.relPath,
          decision: 'accepted',
          contentKey: contentKey(match)
        });
      }
      return { relPath: entry.relPath, decision: 'accepted', ok: true };
    }

    const decisions = this.validDecisions(input.backendId, input.threadId, input.turnId, turn);
    return this.rejectEntry(turn, entry, input, decisions);
  }

  /**
   * Apply one decision to every file in a turn. All files are attempted and
   * every outcome is returned, so a partial failure is reported rather than
   * hidden; the caller must surface any `ok: false` result.
   */
  async decideAll(input: DecideAllInput): Promise<ChangeDecisionResult[]> {
    const turn = this.reviewedTurn(input.turnId);
    if (!turn) {
      return [];
    }
    const results: ChangeDecisionResult[] = [];
    const seen = new Set<string>();
    for (const entry of await filterListedFiles(turn.files, (path) => this.fs.readFile(path))) {
      const key = relPathKey(entry.relPath);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(
        await this.decide({
          backendId: input.backendId,
          threadId: input.threadId,
          turnId: input.turnId,
          relPath: entry.relPath,
          decision: input.decision,
          conflictResolution: input.conflictResolution
        })
      );
    }
    return results;
  }

  /**
   * Drop a turn's stored decisions. Called when a turn is no longer under
   * review so the map cannot grow without bound; a reload of a still-recorded
   * turn re-reads them, so this is not an expiry on a timer.
   */
  async clearTurn(backendId: string, threadId: string, turnId: string): Promise<void> {
    const key = sessionKey(backendId, threadId);
    const map = this.load();
    const existing = map[key];
    if (!existing) {
      return;
    }
    const filtered = existing.filter((entry) => entry.turnId !== turnId);
    if (filtered.length === existing.length) {
      return;
    }
    if (filtered.length === 0) {
      delete map[key];
    } else {
      map[key] = filtered;
    }
    await this.persist(map);
  }

  /* ----------------------------- internals --------------------------------- */

  private async rejectEntry(
    turn: JournalTurn,
    entry: JournalFileEntry,
    input: DecideChangeInput,
    decisions: StoredDecision[]
  ): Promise<ChangeDecisionResult> {
    const before = await this.readSide(turn.turnId, entry, 'before');
    const after = await this.readSide(turn.turnId, entry, 'after');

    const fileDecision = decisions.find((d) => d.relPath === entry.relPath && d.hunkId === undefined);
    const rejectedHunkIds = new Set(
      decisions.filter((d) => d.relPath === entry.relPath && d.hunkId !== undefined && d.decision === 'rejected').map((d) => d.hunkId as string)
    );
    if (input.hunkId && input.decision === 'rejected') {
      rejectedHunkIds.add(input.hunkId);
    }

    // The bytes the file should currently hold, given the decisions already
    // recorded: the post-turn content with every previously rejected hunk
    // reversed, or the pre-turn bytes when the whole file was rejected. This is
    // what the current file is compared against, so a second hunk reject is not
    // mistaken for an external edit.
    const expected = this.expectedBytes(entry, fileDecision, decisions, before, after);

    // The bytes the file must hold once this reject is applied.
    let target: { kind: 'delete' } | { kind: 'write'; bytes: Uint8Array };
    if (input.hunkId) {
      if (!entry.hasAfter || after === undefined) {
        return {
          relPath: entry.relPath,
          decision: 'pending',
          ok: false,
          error: 'The stored content for that hunk is no longer available.'
        };
      }
      // A created file has no before side; its diff is against empty content, so
      // the pre-turn spelling of a rejected hunk is simply the line removed.
      const rebuilt = applyRejectedHunks(decode(before), decode(after), rejectedHunkIds);
      // Rejecting every added line of a created file leaves nothing to keep.
      target = rebuilt.length === 0 && !entry.hasBefore ? { kind: 'delete' } : { kind: 'write', bytes: encode(rebuilt) };
    } else if (!entry.hasBefore || !entry.beforeHash) {
      // Created by the turn (or first seen only after it): rejecting removes it.
      target = { kind: 'delete' };
    } else if (before) {
      target = { kind: 'write', bytes: before };
    } else {
      return {
        relPath: entry.relPath,
        decision: 'pending',
        ok: false,
        error: 'The pre-turn content was not stored, so it cannot be restored.'
      };
    }

    const current = await this.fs.readFile(entry.absPath);

    // A conflict is current content that is neither what the decisions so far
    // imply nor what this reject is about to write. The second condition makes a
    // repeat reject of an already-restored file a no-op rather than a conflict.
    const currentHash = current ? hashBytes(current) : undefined;
    const expectedHash = expected.kind === 'delete' ? undefined : hashBytes(expected.bytes);
    const targetHash = target.kind === 'delete' ? undefined : hashBytes(target.bytes);
    const atTarget = currentHash === targetHash;
    const atExpected = currentHash === expectedHash;

    if (atTarget) {
      await this.record({ ...input, decision: 'rejected', contentKey: contentKey(entry) });
      return { relPath: entry.relPath, decision: 'rejected', ok: true };
    }

    if (!atExpected) {
      if (input.conflictResolution === 'keep-current') {
        // The user chose to keep what is on disk; record the decision, write nothing.
        await this.record({ ...input, decision: 'rejected', contentKey: contentKey(entry) });
        return { relPath: entry.relPath, decision: 'rejected', ok: true, conflict: true };
      }
      if (input.conflictResolution !== 'overwrite-pre-turn') {
        // No silent overwrite: stop and require an explicit choice. The file is
        // left byte-for-byte as it stands.
        return { relPath: entry.relPath, decision: 'pending', ok: false, conflict: true };
      }
    }

    try {
      if (target.kind === 'delete') {
        await this.fs.deleteFile(entry.absPath);
      } else {
        await this.fs.writeFile(entry.absPath, target.bytes);
      }
    } catch (error) {
      // The write failed: report it and do not record the decision as rejected.
      return {
        relPath: entry.relPath,
        decision: 'pending',
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    await this.record({ ...input, decision: 'rejected', contentKey: contentKey(entry) });
    return { relPath: entry.relPath, decision: 'rejected', ok: true };
  }

  /** The content implied by the decisions recorded so far for one file. */
  private expectedBytes(
    entry: JournalFileEntry,
    fileDecision: StoredDecision | undefined,
    decisions: StoredDecision[],
    before: Uint8Array | undefined,
    after: Uint8Array | undefined
  ): { kind: 'delete' } | { kind: 'write'; bytes: Uint8Array } {
    if (fileDecision?.decision === 'rejected') {
      return !entry.hasBefore || !entry.beforeHash ? { kind: 'delete' } : { kind: 'write', bytes: before ?? encode('') };
    }
    if (!after) {
      // A deleted file (no after side): the on-disk truth is absence.
      return { kind: 'delete' };
    }
    const rejected = new Set(
      decisions
        .filter((d) => d.relPath === entry.relPath && d.hunkId !== undefined && d.decision === 'rejected')
        .map((d) => d.hunkId as string)
    );
    if (rejected.size === 0) {
      return { kind: 'write', bytes: after };
    }
    // A created file has no before side; its diff is against empty content.
    const rebuilt = applyRejectedHunks(decode(before), decode(after), rejected);
    return rebuilt.length === 0 && !entry.hasBefore ? { kind: 'delete' } : { kind: 'write', bytes: encode(rebuilt) };
  }

  private async fileView(
    turnId: string,
    entry: JournalFileEntry,
    decisions: StoredDecision[]
  ): Promise<ChangeFileView> {
    const fileDecision = decisions.find((d) => d.relPath === entry.relPath && d.hunkId === undefined);
    let hunks: ChangeHunkView[] = [];
    let additions = 0;
    let deletions = 0;
    let diffable = false;
    let detail: string | undefined;

    const canDiff =
      entry.inlineable &&
      !entry.binary &&
      (entry.hasBefore ? entry.beforeHash !== undefined : true) &&
      (entry.hasAfter ? entry.afterHash !== undefined : true);

    // A modification with no stored before side used to diff the finished file
    // against empty content, so every unchanged line reviewed as an addition.
    const missingBaseline = !entry.hasBefore && entry.status !== 'created';
    if (missingBaseline) {
      detail = 'No pre-change snapshot was recorded, so unchanged lines are not shown as additions.';
      diffable = entry.inlineable && !entry.binary;
    } else if (canDiff) {
      const before = await this.readSide(turnId, entry, 'before');
      const after = await this.readSide(turnId, entry, 'after');
      if ((entry.hasBefore ? before !== undefined : true) && (entry.hasAfter ? after !== undefined : true)) {
        const diff = diffLines(decode(before), decode(after), entry.relPath);
        if (diff.tooLarge) {
          detail = 'This file is too large to diff here. Open it in the editor to review it.';
          diffable = false;
        } else {
        hunks = diff.hunks.map((hunk) => {
          // A hunk's own decision wins; otherwise a whole-file decision cascades
          // to it, so accepting a file accepts each of its hunks and the review
          // surface has one consistent answer per hunk.
          const storedHunk = decisions.find((d) => d.relPath === entry.relPath && d.hunkId === hunk.id);
          const decision: ChangeDecision = storedHunk ? storedHunk.decision : fileDecision?.decision ?? 'pending';
          return { ...hunk, decision };
        });
        additions = diff.additions;
        deletions = diff.deletions;
        diffable = true;
        }
      } else {
        detail = 'The stored content is no longer available, so no diff can be shown.';
      }
    } else {
      detail = entry.binary
        ? 'Binary file: the content is recorded but not shown as text.'
        : 'The file is too large to show as a diff.';
    }

    const decision = resolveFileDecision(fileDecision, hunks);
    return {
      absPath: entry.absPath,
      path: entry.relPath,
      status: entry.status,
      source: entry.source,
      binary: entry.binary,
      diffable,
      additions,
      deletions,
      decision,
      hunks,
      restorable: entry.status === 'created' || entry.hasBefore,
      ...(detail ? { detail } : {})
    };
  }

  private validDecisions(
    backendId: string,
    threadId: string,
    turnId: string,
    turn: JournalTurn
  ): StoredDecision[] {
    const stored = this.load()[sessionKey(backendId, threadId)] ?? [];
    const files = new Map(turn.files.map((file) => [file.relPath, contentKey(file)]));
    return stored.filter(
      (entry) =>
        entry.turnId === turnId &&
        files.get(entry.relPath) === entry.contentKey
    );
  }

  private async record(decision: Omit<StoredDecision, 'decidedAt'>): Promise<void> {
    const map = this.load();
    const key = sessionKey(decision.backendId, decision.threadId);
    const existing = map[key] ?? [];
    const without = existing.filter(
      (entry) =>
        !(
          entry.turnId === decision.turnId &&
          entry.relPath === decision.relPath &&
          entry.hunkId === decision.hunkId
        )
    );
    without.push({ ...decision, decidedAt: this.now() });
    map[key] = without;
    await this.persist(map);
  }

  private load(): DecisionMap {
    if (!this.cache) {
      const stored = this.storage.get<DecisionMap | undefined>(CHANGE_DECISIONS_KEY, undefined);
      this.cache = stored && typeof stored === 'object' ? stored : {};
    }
    return this.cache;
  }

  private async persist(map: DecisionMap): Promise<void> {
    this.cache = map;
    await this.storage.update(CHANGE_DECISIONS_KEY, map);
  }
}

/**
 * One row per path. A report and a watcher event can record the same file twice
 * when their path spellings differ. Keep the decided row, then the larger diff.
 */
export function dedupeChangeFiles(files: readonly ChangeFileView[]): ChangeFileView[] {
  const byPath = new Map<string, ChangeFileView>();
  for (const file of files) {
    const key = relPathKey(file.path);
    const existing = byPath.get(key);
    if (!existing || changeFileRank(file) > changeFileRank(existing)) {
      byPath.set(key, file);
    }
  }
  return files.filter((file) => byPath.get(relPathKey(file.path)) === file);
}

function changeFileRank(file: ChangeFileView): number {
  const decided = file.decision === 'pending' ? 0 : 1;
  return decided * 1_000_000 + file.additions + file.deletions;
}

/** A workspace-relative path in the journal's POSIX spelling. */
function toPosixRel(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * The file's own decision: an explicit whole-file record wins; otherwise it is
 * derived from the hunks (all accepted, all rejected, or still pending).
 */
function resolveFileDecision(fileDecision: StoredDecision | undefined, hunks: ChangeHunkView[]): ChangeDecision {
  if (fileDecision) {
    return fileDecision.decision;
  }
  if (hunks.length === 0) {
    return 'pending';
  }
  if (hunks.every((hunk) => hunk.decision === 'accepted')) {
    return 'accepted';
  }
  if (hunks.every((hunk) => hunk.decision === 'rejected')) {
    return 'rejected';
  }
  return 'pending';
}
