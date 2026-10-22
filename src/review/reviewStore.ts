import type { DiffReviewFinding, DiffReviewResult, DiffReviewStatus } from './diffReview.ts';

/**
 * Persists the advisory diff-review result for a finished turn.
 *
 * The store is workspace-scoped, matching the change journal it annotates: a
 * review about turn `t1` in this workspace has no meaning in another. The map is
 * bounded to the newest {@link REVIEW_STORE_LIMIT} turns, so a long-lived
 * workspace keeps the recent review snapshots and cannot grow without limit.
 *
 * Following the `ModelSettingsStore` precedent, the store takes only the narrow
 * slice of `vscode.Memento` it needs. That keeps it runnable under plain
 * `node --test` with a fake memento and never lets it import the host.
 */

/** The `workspaceState` key the host and the diff review agree on. */
export const REVIEW_STORE_KEY = 'melink.review.findings';

/** The separate key for the advisory styling check, so the two never mix. */
export const STYLING_REVIEW_STORE_KEY = 'melink.review.styling';

/** How many turns keep a stored review. */
export const REVIEW_STORE_LIMIT = 50;

/** The narrow slice of `vscode.Memento` this store needs. */
export interface ReviewStoreMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

interface StoredReview {
  result: DiffReviewResult;
  updatedAt: number;
}

type ReviewIndex = Record<string, StoredReview>;

/** Stable key for one turn's review. Exported so tests and callers agree. */
export function reviewStoreKey(backendId: string, threadId: string, turnId: string): string {
  return `${backendId}:${threadId}:${turnId}`;
}

export class ReviewStore {
  private readonly memento: ReviewStoreMemento;
  private readonly now: () => number;
  private readonly key: string;
  /** Loaded once, then updated only through the serialized write chain. */
  private index?: ReviewIndex;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    memento: ReviewStoreMemento,
    now: () => number = () => Date.now(),
    key: string = REVIEW_STORE_KEY
  ) {
    this.memento = memento;
    this.now = now;
    this.key = key;
  }

  /** The stored result for one turn, or `undefined` when it was never reviewed. */
  get(backendId: string, threadId: string, turnId: string): DiffReviewResult | undefined {
    const entry = this.load()[reviewStoreKey(backendId, threadId, turnId)];
    if (!entry || !isStoredResult(entry.result)) {
      return undefined;
    }
    return cloneResult(entry.result);
  }

  /** Store one turn's result and evict the oldest reviews beyond the cap. */
  set(
    backendId: string,
    threadId: string,
    turnId: string,
    result: DiffReviewResult
  ): Promise<void> {
    return this.enqueue((index) => {
      index[reviewStoreKey(backendId, threadId, turnId)] = {
        result: cloneResult(result),
        updatedAt: this.now()
      };
      const kept = Object.entries(index)
        .sort(([leftKey, left], [rightKey, right]) => {
          if (left.updatedAt !== right.updatedAt) {
            return right.updatedAt - left.updatedAt;
          }
          return leftKey < rightKey ? 1 : leftKey > rightKey ? -1 : 0;
        })
        .slice(0, REVIEW_STORE_LIMIT);
      return Object.fromEntries(kept);
    });
  }

  /** Remove one turn's review. A missing key is harmless. */
  clear(backendId: string, threadId: string, turnId: string): Promise<void> {
    return this.enqueue((index) => {
      const key = reviewStoreKey(backendId, threadId, turnId);
      if (!(key in index)) {
        return undefined;
      }
      delete index[key];
      return index;
    });
  }

  /** Remove every stored review, used when the workspace conversation is reset. */
  clearAll(): Promise<void> {
    return this.enqueue((index) => (Object.keys(index).length === 0 ? undefined : {}));
  }

  private load(): ReviewIndex {
    if (this.index === undefined) {
      const raw = this.memento.get<ReviewIndex>(this.key);
      this.index = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    }
    return this.index;
  }

  /**
   * Serialize a read-modify-write. Two turns finishing together must both
   * survive: without the chain both would read the same index and the later
   * write would erase the earlier result.
   */
  private enqueue(change: (index: ReviewIndex) => ReviewIndex | undefined): Promise<void> {
    const operation = this.writeChain.then(async () => {
      const next = change({ ...this.load() });
      if (next === undefined) {
        return;
      }
      await this.memento.update(this.key, next);
      this.index = next;
    });
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }
}

function isStoredResult(value: unknown): value is DiffReviewResult {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const result = value as Partial<DiffReviewResult>;
  return (
    isStatus(result.status) &&
    Array.isArray(result.findings) &&
    result.findings.every(isFinding) &&
    (result.notice === undefined || typeof result.notice === 'string')
  );
}

function isStatus(value: unknown): value is DiffReviewStatus {
  return value === 'reviewed' || value === 'no-findings' || value === 'failed';
}

function isFinding(value: unknown): value is DiffReviewFinding {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const finding = value as Partial<DiffReviewFinding>;
  return (
    typeof finding.path === 'string' &&
    typeof finding.line === 'number' &&
    (finding.severity === 'error' || finding.severity === 'warning' || finding.severity === 'info') &&
    typeof finding.message === 'string'
  );
}

function cloneResult(result: DiffReviewResult): DiffReviewResult {
  return {
    status: result.status,
    findings: result.findings.map(cloneFinding),
    ...(result.notice === undefined ? {} : { notice: result.notice })
  };
}

function cloneFinding(finding: DiffReviewFinding): DiffReviewFinding {
  return {
    path: finding.path,
    line: finding.line,
    severity: finding.severity,
    message: finding.message
  };
}
