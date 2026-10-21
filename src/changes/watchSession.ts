import type { ChangeStatus } from '../backends/types';
import { hasIgnoredSegment } from './ignore.ts';
import { relativeWithin } from './journal.ts';

/**
 * The host-free half of the fallback change watcher.
 *
 * It owns everything about a watch that can be reasoned about without a VS Code
 * runtime: the workspace-folder filter and the write-burst debounce. The thin
 * `vscode` binding in `vscodeChanges.ts` only creates the real
 * `FileSystemWatcher`, forwards its events here, and forwards what this session
 * decides to record on to the tracker.
 *
 * Separating the two is what lets `npm test` prove the two invariants that
 * matter — a path outside every workspace folder is ignored, and a burst of
 * writes is coalesced to one observation per path — without a VS Code host.
 *
 * It is explicitly one-turn scoped: `stop()` flushes and then makes the session
 * inert, so a later event cannot attach to a turn that has already ended.
 */

/** Receives one coalesced observation: an absolute path and its last status. */
export type ObserveChange = (absPath: string, status: ChangeStatus) => void;

export interface ChangeWatchSessionOptions {
  /** The open workspace roots, read lazily so a folder change is seen. */
  workspaceRoots: () => readonly string[];
  /** Called once per path after the debounce settles (and on stop). */
  onObserve: ObserveChange;
  /** Debounce window in milliseconds. */
  debounceMs?: number;
  /** Timer seam, injected so a test is deterministic. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Default debounce window for a burst of writes. */
export const DEFAULT_WATCH_DEBOUNCE_MS = 150;

export class ChangeWatchSession {
  private readonly pending = new Map<string, ChangeStatus>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly options: ChangeWatchSessionOptions;
  private readonly debounceMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  constructor(options: ChangeWatchSessionOptions) {
    this.options = options;
    this.debounceMs = options.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  /** True when a later observation would still be recorded. */
  get active(): boolean {
    return !this.stopped;
  }

  /**
   * Note a filesystem event for an absolute path. A path outside every workspace
   * folder is dropped here, before it can reach the tracker and be snapshotted.
   * A later event for the same path in one burst wins, so a create followed by a
   * modify coalesces to the modify that describes the end state.
   */
  observe(absPath: string, status: ChangeStatus): void {
    const relPath = this.relativePath(absPath);
    if (this.stopped || relPath === undefined || hasIgnoredSegment(relPath)) {
      return;
    }
    this.pending.set(absPath, status);
    this.schedule();
  }

  /**
   * Flush anything debounced but not yet recorded, then make the session inert.
   * Called when the turn ends and when the extension deactivates; safe to call
   * when nothing is pending and safe to call more than once.
   */
  stop(): void {
    this.flush();
    this.stopped = true;
  }

  private schedule(): void {
    if (this.timer) {
      return;
    }
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.flush();
    }, this.debounceMs);
  }

  flush(): void {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    if (this.pending.size === 0) {
      return;
    }
    for (const [absPath, status] of this.pending) {
      this.options.onObserve(absPath, status);
    }
    this.pending.clear();
  }

  /** The workspace-relative path, or `undefined` when it sits outside every root. */
  private relativePath(absPath: string): string | undefined {
    for (const root of this.options.workspaceRoots()) {
      const rel = relativeWithin(absPath, root);
      if (rel !== undefined && rel.length > 0) {
        return rel;
      }
    }
    return undefined;
  }
}
