/**
 * Persists the post-turn check result for a turn.
 *
 * The store is workspace-scoped, like the change journal it annotates: a check
 * run for turn `t1` has no meaning in another workspace. It takes only the
 * narrow `get`/`update` slice of a VS Code memento, so tests drive it with a
 * fake and this module never imports the host.
 *
 * ## Invariants
 *
 * - **Bounded.** The newest {@link CHECK_STORE_LIMIT} runs are kept; older runs
 *   are evicted so a long-lived workspace cannot grow without limit.
 * - **Serialized writes.** `set` and `clear` run through one chain, so two
 *   results finishing together cannot lose one another's update.
 * - **Reload-safe.** A run left `running` when the window closed is reported as
 *   `skipped` on read, never as a spinner that never stops.
 * - **Defensive.** Malformed stored entries are dropped rather than trusted.
 */

import type { CheckOverallStatus, CheckResult, CheckRunView, CheckStatus } from './checks.ts';

/** The `workspaceState` key the host and this module agree on. */
export const CHECK_STORE_KEY = 'melink.review.checks';

/** How many turns keep a stored check run. */
export const CHECK_STORE_LIMIT = 50;

/** Shown for a run that was still running when the window reloaded. */
export const INTERRUPTED_CHECK_REASON = 'Checks were interrupted when the window reloaded.';

const INTERRUPTED_SUMMARY = 'Checks: interrupted when the window reloaded';

const CHECK_STATUSES: ReadonlySet<CheckStatus> = new Set([
  'passed',
  'failed',
  'timed-out',
  'error',
  'skipped'
]);

const OVERALL_STATUSES: ReadonlySet<CheckOverallStatus> = new Set([
  'running',
  'passed',
  'failed',
  'skipped',
  'untrusted'
]);

/** The narrow slice of `vscode.Memento` this store needs. */
export interface CheckStoreMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

interface StoredCheckRun {
  backendId: string;
  threadId: string;
  turnId: string;
  view: CheckRunView;
  updatedAt: number;
}

type CheckIndex = Record<string, StoredCheckRun>;

/** Stable key for one turn's check run. */
export function checkStoreKey(backendId: string, threadId: string, turnId: string): string {
  return `${backendId}:${threadId}:${turnId}`;
}

export class CheckStore {
  private readonly memento: CheckStoreMemento;
  private readonly now: () => number;
  private index?: CheckIndex;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(memento: CheckStoreMemento, now: () => number = () => Date.now()) {
    this.memento = memento;
    this.now = now;
  }

  /** The stored run for one turn, with an interrupted `running` state settled. */
  get(backendId: string, threadId: string, turnId: string): CheckRunView | undefined {
    const entry = this.load()[checkStoreKey(backendId, threadId, turnId)];
    return entry ? cloneView(entry.view) : undefined;
  }

  /** Store one run and evict the oldest entries beyond the cap. */
  set(backendId: string, threadId: string, turnId: string, view: CheckRunView): Promise<void> {
    return this.enqueue(() => {
      const index = this.load();
      index[checkStoreKey(backendId, threadId, turnId)] = {
        backendId,
        threadId,
        turnId,
        view: cloneView(view),
        updatedAt: this.now()
      };
      trimIndex(index);
      return this.persist(index);
    });
  }

  /** Drop one turn's run. */
  clear(backendId: string, threadId: string, turnId: string): Promise<void> {
    return this.enqueue(() => {
      const index = this.load();
      const key = checkStoreKey(backendId, threadId, turnId);
      if (!(key in index)) {
        return;
      }
      delete index[key];
      return this.persist(index);
    });
  }

  /** Drop every stored run for a thread, e.g. when its session is discarded. */
  clearThread(threadId: string): Promise<void> {
    return this.enqueue(() => {
      const index = this.load();
      let changed = false;
      for (const [key, entry] of Object.entries(index)) {
        if (entry.threadId === threadId) {
          delete index[key];
          changed = true;
        }
      }
      if (changed) {
        return this.persist(index);
      }
    });
  }

  private enqueue(work: () => Promise<void> | void): Promise<void> {
    const run = this.writeChain.then(work, work);
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private load(): CheckIndex {
    if (this.index) {
      return this.index;
    }
    const raw = this.memento.get<unknown>(CHECK_STORE_KEY);
    this.index = normalizeIndex(raw, this.now());
    return this.index;
  }

  private async persist(index: CheckIndex): Promise<void> {
    this.index = index;
    await this.memento.update(CHECK_STORE_KEY, index);
  }
}

function normalizeIndex(raw: unknown, now: number): CheckIndex {
  if (!isRecord(raw)) {
    return {};
  }
  const index: CheckIndex = {};
  for (const value of Object.values(raw)) {
    const entry = normalizeEntry(value, now);
    if (!entry) {
      continue;
    }
    const canonical = checkStoreKey(entry.backendId, entry.threadId, entry.turnId);
    const existing = index[canonical];
    if (!existing || entry.updatedAt >= existing.updatedAt) {
      index[canonical] = entry;
    }
  }
  trimIndex(index);
  return index;
}

function normalizeEntry(value: unknown, now: number): StoredCheckRun | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const backendId = value.backendId;
  const threadId = value.threadId;
  const turnId = value.turnId;
  if (typeof backendId !== 'string' || typeof threadId !== 'string' || typeof turnId !== 'string') {
    return undefined;
  }
  const view = normalizeView(value.view, now);
  if (!view) {
    return undefined;
  }
  const updatedAt =
    typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0;
  return { backendId, threadId, turnId, view, updatedAt };
}

function normalizeView(value: unknown, now: number): CheckRunView | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.status !== 'string' || !OVERALL_STATUSES.has(value.status as CheckOverallStatus)) {
    return undefined;
  }
  const status = value.status as CheckOverallStatus;
  const resultsRaw = Array.isArray(value.results) ? value.results : [];
  const results = resultsRaw
    .map(normalizeResult)
    .filter((entry): entry is CheckResult => entry !== undefined);
  const startedAt =
    typeof value.startedAt === 'number' && Number.isFinite(value.startedAt) ? value.startedAt : 0;
  const finishedAt =
    typeof value.finishedAt === 'number' && Number.isFinite(value.finishedAt)
      ? value.finishedAt
      : undefined;
  const summary =
    typeof value.summary === 'string' && value.summary.length > 0
      ? value.summary
      : 'Checks: no checks';
  const view: CheckRunView = { status, summary, results, startedAt };
  if (finishedAt !== undefined) {
    view.finishedAt = finishedAt;
  }
  return status === 'running' ? interruptedView(view, now) : view;
}

function normalizeResult(value: unknown): CheckResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    typeof value.name !== 'string' ||
    typeof value.command !== 'string' ||
    typeof value.status !== 'string' ||
    !CHECK_STATUSES.has(value.status as CheckStatus) ||
    typeof value.durationMs !== 'number' ||
    !Number.isFinite(value.durationMs)
  ) {
    return undefined;
  }
  const result: CheckResult = {
    name: value.name,
    command: value.command,
    status: value.status as CheckStatus,
    durationMs: Math.max(0, value.durationMs)
  };
  if (typeof value.output === 'string') {
    result.output = value.output;
  }
  if (typeof value.reason === 'string') {
    result.reason = value.reason;
  }
  return result;
}

function interruptedView(view: CheckRunView, now: number): CheckRunView {
  const results = view.results.map((result) => ({ ...result }));
  if (!results.some((result) => result.reason === INTERRUPTED_CHECK_REASON)) {
    results.push({
      name: 'Checks',
      command: '',
      status: 'skipped',
      durationMs: Math.max(0, now - view.startedAt),
      reason: INTERRUPTED_CHECK_REASON
    });
  }
  const finishedAt = now;
  return {
    status: 'skipped',
    summary: INTERRUPTED_SUMMARY,
    results,
    startedAt: view.startedAt,
    finishedAt
  };
}

function trimIndex(index: CheckIndex): void {
  const entries = Object.entries(index);
  if (entries.length <= CHECK_STORE_LIMIT) {
    return;
  }
  entries
    .sort(([leftKey, left], [rightKey, right]) => {
      if (left.updatedAt !== right.updatedAt) {
        return right.updatedAt - left.updatedAt;
      }
      return leftKey < rightKey ? 1 : leftKey > rightKey ? -1 : 0;
    })
    .slice(CHECK_STORE_LIMIT)
    .forEach(([key]) => {
      delete index[key];
    });
}

function cloneView(view: CheckRunView): CheckRunView {
  const copy: CheckRunView = {
    status: view.status,
    summary: view.summary,
    results: view.results.map((result) => ({ ...result })),
    startedAt: view.startedAt
  };
  if (view.finishedAt !== undefined) {
    copy.finishedAt = view.finishedAt;
  }
  return copy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
