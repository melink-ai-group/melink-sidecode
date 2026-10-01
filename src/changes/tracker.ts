import type { ChangeEntry, ChangeStatus, ReportedChange } from '../backends/types';
import type { ChangeJournal, JournalFileEntry } from './journal';

/**
 * Coordinates the per-turn change journal for a backend turn.
 *
 * The tracker is the single place the two observation channels meet:
 *
 * - **Reported** — an adapter saw a structured edit event and named the paths it
 *   touched (`report`).
 * - **Watched** — the workspace filesystem watcher saw a path change that emitted
 *   no structured event (`watch`), e.g. a formatter or `git apply` run through
 *   the shell.
 *
 * It is storage-agnostic and free of `vscode`: it holds only the active turn and
 * forwards observations to the injected `ChangeJournal`, so `npm test` can drive
 * it with the journal's fake fs. The thin binding to the real watcher lives in
 * `vscodeChanges.ts`.
 *
 * ## Honesty rule
 *
 * `endTurn` returns `undefined` — and fires no notification — when nothing was
 * observed at all. An empty array is only ever returned for a turn the tracker
 * actually observed, where "no files changed" is a verified fact. A caller must
 * therefore treat `undefined` as "unknown", never as "no changes".
 */

/** The recorded change set for one finished turn. */
export interface TurnChangeSet {
  backendId: string;
  threadId: string;
  turnId: string;
  entries: ChangeEntry[];
}

export interface BeginTurnOptions {
  turnId: string;
  threadId: string;
  backendId: string;
  /**
   * The user message that opened the turn, when the host knows it. Recorded on
   * the turn so its pre-state snapshot is addressable as that message's
   * checkpoint.
   */
  messageId?: string;
  /**
   * Absolute paths known before the turn that are worth a real pre-turn
   * snapshot (open editors, files the agent is about to touch). Optional: a
   * shell-driven write is caught by the watcher regardless, only with a less
   * complete before side.
   */
  candidates?: readonly string[];
}

export class ChangeTracker {
  private active?: { turnId: string; threadId: string; backendId: string };
  private readonly listeners = new Set<(set: TurnChangeSet) => void>();
  private readonly journal: ChangeJournal;
  private readonly now: () => number;

  constructor(journal: ChangeJournal, now: () => number = () => Date.now()) {
    this.journal = journal;
    this.now = now;
  }

  /** Subscribe to a finished turn's change set. Fires only for observed turns. */
  onTurnChanges(listener: (set: TurnChangeSet) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** The turn currently being tracked, or `undefined` when idle. */
  get currentTurnId(): string | undefined {
    return this.active?.turnId;
  }

  /**
   * Open a turn boundary. A second `beginTurn` before the first ends replaces
   * the active turn, so a missed lifecycle notification cannot strand the
   * tracker on a stale turn id.
   */
  async beginTurn(options: BeginTurnOptions): Promise<void> {
    this.active = { turnId: options.turnId, threadId: options.threadId, backendId: options.backendId };
    await this.journal.beginTurn({
      turnId: options.turnId,
      threadId: options.threadId,
      backendId: options.backendId,
      ...(options.messageId !== undefined ? { messageId: options.messageId } : {}),
      candidates: options.candidates ?? [],
      startedAt: this.now()
    });
  }

  /**
   * Record paths a backend reported through a structured edit event. Ignored
   * when no turn is active, and when the report names a different thread, so a
   * late or background report cannot attach to an unrelated turn.
   */
  reportChanges(changes: readonly ReportedChange[], threadId?: string): void {
    const active = this.active;
    if (!active || (threadId !== undefined && threadId !== active.threadId)) {
      return;
    }
    for (const change of changes) {
      void this.journal.observe(active.turnId, change.absPath, 'reported', change.status);
    }
  }

  /**
   * Record a path the workspace watcher observed. `status` is the hint the
   * watcher supplied (`created`/`changed`/`deleted`); it is used only when a
   * late snapshot cannot prove the kind on its own.
   */
  watch(absPath: string, status?: ChangeStatus): void {
    const active = this.active;
    if (!active) {
      return;
    }
    void this.journal.observe(active.turnId, absPath, 'watched', status);
  }

  /** True when a turn is open, so the host can decide whether to keep watching. */
  get isTracking(): boolean {
    return this.active !== undefined;
  }

  /**
   * The most recently finished, observed change set for a thread, or `undefined`
   * when the thread has none. Used to repaint the change surface on a webview
   * reload; a thread whose latest turn observed nothing yields `undefined`, so a
   * reload never fabricates a verified empty set.
   */
  latestFor(threadId: string): TurnChangeSet | undefined {
    const turn = this.journal.listTurns(threadId)[0];
    if (!turn || !turn.observed) {
      return undefined;
    }
    return {
      backendId: turn.backendId,
      threadId: turn.threadId,
      turnId: turn.turnId,
      entries: turn.files.map(toChangeEntry)
    };
  }

  /** Drop any in-flight turn state. Used when the view is torn down. */
  dispose(): void {
    this.active = undefined;
    this.listeners.clear();
  }

  /**
   * Close the active turn, snapshot-diff it, and publish the recorded set. A
   * turn that observed nothing returns `undefined` and fires nothing: silence is
   * not a claim that the agent changed nothing.
   */
  async endTurn(turnId?: string, afterPaths: readonly string[] = []): Promise<TurnChangeSet | undefined> {
    const active = this.active;
    if (!active || (turnId !== undefined && turnId !== active.turnId)) {
      return undefined;
    }
    this.active = undefined;
    await this.journal.endTurn(active.turnId, afterPaths);
    const turn = this.journal.getTurn(active.turnId);
    if (!turn || !turn.observed) {
      return undefined;
    }
    const set: TurnChangeSet = {
      backendId: active.backendId,
      threadId: active.threadId,
      turnId: active.turnId,
      entries: turn.files.map(toChangeEntry)
    };
    for (const listener of this.listeners) {
      try {
        listener(set);
      } catch {
        // A misbehaving consumer must not break the turn teardown.
      }
    }
    return set;
  }
}

/** Map the journal's stored entry onto the protocol-facing change entry. */
export function toChangeEntry(file: JournalFileEntry): ChangeEntry {
  const entry: ChangeEntry = {
    absPath: file.absPath,
    path: file.relPath,
    status: file.status,
    source: file.source
  };
  if (file.renamedFrom) {
    entry.renamedFrom = file.renamedFrom;
  }
  return entry;
}
