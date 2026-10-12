import type { ChangeEntry, ChangeStatus, ReportedChange } from '../backends/types';
import { filterListedFiles } from './ignore.ts';
import type { ChangeJournal, JournalFileEntry } from './journal';
import { sessionChangeSet } from './sessionFiles.ts';

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
  /** The user message that opened the turn, when one was recorded. */
  messageId?: string;
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
  /** Every turn that is still open. One chat tab does not replace another's. */
  private readonly openTurns = new Map<string, { turnId: string; threadId: string; backendId: string }>();
  /** The turn most recently started. `endTurn()` with no id closes this one. */
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

  /** The turn most recently started, or `undefined` when idle. */
  get currentTurnId(): string | undefined {
    return this.active && this.openTurns.has(this.active.turnId) ? this.active.turnId : undefined;
  }

  /** True when this turn is still open. A later turn on another chat does not close it. */
  isOpen(turnId: string): boolean {
    return this.openTurns.has(turnId);
  }

  /**
   * Open a turn boundary. A second `beginTurn` for the same thread replaces
   * that thread's open turn, so a missed lifecycle notification cannot strand
   * the tracker. A different thread stays open beside it.
   */
  async beginTurn(options: BeginTurnOptions): Promise<void> {
    for (const open of this.openTurns.values()) {
      if (open.threadId === options.threadId && open.turnId !== options.turnId) {
        this.openTurns.delete(open.turnId);
      }
    }
    const entry = { turnId: options.turnId, threadId: options.threadId, backendId: options.backendId };
    this.openTurns.set(options.turnId, entry);
    this.active = entry;
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
    const active =
      threadId !== undefined
        ? [...this.openTurns.values()].find((turn) => turn.threadId === threadId)
        : this.openTurns.size === 1
          ? [...this.openTurns.values()][0]
          : undefined;
    if (!active) {
      return;
    }
    for (const change of changes) {
      void this.journal.observe(active.turnId, change.absPath, 'reported', change.status, change.diff, {
        ...(change.replacement ? { replacement: change.replacement } : {}),
        ...(change.beforeText !== undefined ? { beforeText: change.beforeText } : {}),
        ...(change.afterText !== undefined ? { afterText: change.afterText } : {})
      });
    }
  }

  /**
   * Record a path the workspace watcher observed. `status` is the hint the
   * watcher supplied (`created`/`changed`/`deleted`); it is used only when a
   * late snapshot cannot prove the kind on its own.
   */
  watch(absPath: string, status?: ChangeStatus): void {
    for (const active of this.openTurns.values()) {
      void this.journal.observe(active.turnId, absPath, 'watched', status);
    }
  }

  /** True when a turn is open, so the host can decide whether to keep watching. */
  get isTracking(): boolean {
    return this.openTurns.size > 0;
  }

  /**
   * The most recently finished, observed change set for a thread, or `undefined`
   * when the thread has none. Used to repaint the change surface on a webview
   * reload; a thread whose latest turn observed nothing yields `undefined`, so a
   * reload never fabricates a verified empty set.
   */
  async latestFor(threadId: string): Promise<TurnChangeSet | undefined> {
    const turn = this.journal.listTurns(threadId)[0];
    if (!turn || !turn.observed) {
      return undefined;
    }
    return {
      backendId: turn.backendId,
      threadId: turn.threadId,
      turnId: turn.turnId,
      entries: (await this.listed(turn.files)).map(toChangeEntry)
    };
  }

  /**
   * Every surviving file the thread changed, not only the latest turn.
   *
   * Plan execution is one turn per step. The review surface names the newest
   * observed turn, and the entries are the net of the whole thread: a path
   * touched on an earlier step stays listed, and a path a later step restored
   * does not.
   */
  /**
   * One change set per observed turn that still has listed files, oldest first.
   * A turn that observed nothing, or whose files are all omitted, is skipped
   * so a reload cannot invent a card for it.
   */
  async observedSets(threadId: string): Promise<TurnChangeSet[]> {
    const turns = [...this.journal.listTurns(threadId)].reverse();
    const sets: TurnChangeSet[] = [];
    for (const turn of turns) {
      if (!turn.observed) {
        continue;
      }
      const entries = (await this.listed(turn.files)).map(toChangeEntry);
      if (entries.length === 0) {
        continue;
      }
      sets.push({
        backendId: turn.backendId,
        threadId: turn.threadId,
        turnId: turn.turnId,
        ...(turn.messageId ? { messageId: turn.messageId } : {}),
        entries
      });
    }
    return sets;
  }

  async sessionFor(threadId: string): Promise<TurnChangeSet | undefined> {
    const session = sessionChangeSet(this.journal.listTurns(threadId));
    if (!session) {
      return undefined;
    }
    const files = await this.listed(session.files.map((file) => file.entry));
    return {
      backendId: session.backendId,
      threadId: session.threadId,
      turnId: session.turnId,
      entries: files.map(toChangeEntry)
    };
  }

  /** Drop any in-flight turn state. Used when the view is torn down. */
  dispose(): void {
    this.openTurns.clear();
    this.active = undefined;
    this.listeners.clear();
  }

  /**
   * Close the active turn, snapshot-diff it, and publish the recorded set. A
   * turn that observed nothing returns `undefined` and fires nothing: silence is
   * not a claim that the agent changed nothing.
   */
  async endTurn(turnId?: string, afterPaths: readonly string[] = []): Promise<TurnChangeSet | undefined> {
    const active = turnId !== undefined ? this.openTurns.get(turnId) : this.active;
    if (!active || !this.openTurns.has(active.turnId)) {
      return undefined;
    }
    this.openTurns.delete(active.turnId);
    if (this.active?.turnId === active.turnId) {
      this.active = [...this.openTurns.values()].at(-1);
    }
    await this.journal.endTurn(active.turnId, afterPaths);
    const turn = this.journal.getTurn(active.turnId);
    if (!turn || !turn.observed) {
      return undefined;
    }
    const set: TurnChangeSet = {
      backendId: active.backendId,
      threadId: active.threadId,
      turnId: active.turnId,
      ...(turn.messageId ? { messageId: turn.messageId } : {}),
      entries: (await this.listed(turn.files)).map(toChangeEntry)
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

  /**
   * Rows for the changes strip. A binary stays in the journal and is omitted
   * here. A path excluded by any `.gitignore` is omitted too, including one
   * recorded before that rule existed.
   */
  private listed(files: readonly JournalFileEntry[]): Promise<JournalFileEntry[]> {
    return filterListedFiles(files, (path) => this.journal.readWorkspaceFile(path));
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
