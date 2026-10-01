/**
 * Per-thread project-context delivery.
 *
 * The snapshot service (`projectContext.ts`) owns the workspace picture and the
 * workspace root; the renderer (`render.ts`) owns the wording. This module is
 * the small piece in between that decides *which* block a given turn receives.
 *
 * The rendered snapshot is kept as a **stable prefix** for as long as the thread
 * lives, so a stateless provider (the direct `/api/chat` path) can re-send it
 * identically every turn — cacheable, and per-turn token cost stays flat — while
 * a stateful session (Codex native instructions, an opencode session) consumes
 * it once at start and then needs only the delta. `priming` distinguishes the
 * first turn after a session opens (or a manual refresh) from the rest.
 *
 * It is host-free: it takes the `ProjectContextReads` seam and no `vscode`
 * import, so `npm test` can drive it with a fake snapshot source. A manual
 * `refresh()` re-reads and re-arms priming, which is what makes the UI's
 * on-demand refresh reach the next turn without a window reload.
 */

import type { ContextPayload } from '../backends/types.ts';
import {
  DEFAULT_RENDER_BUDGET,
  renderDelta,
  renderSnapshotResult,
  CONTEXT_UNAVAILABLE_NOTICE,
  type RenderBudget
} from './render.ts';
import type {
  GetSnapshotInput,
  ProjectContextReads,
  ProjectSnapshot
} from './projectContext.ts';
import { applyContextExclusions, type ContextView } from './contextView.ts';
import { buildContextView } from './contextView.ts';

export interface ContextDeliveryOptions {
  /** The reads the snapshot service exposes. Never a workspace-root getter. */
  reads: ProjectContextReads;
  budget?: RenderBudget;
}

/** A rendered prime plus the raw snapshot a later delta is computed against. */
export interface PrimedSnapshot {
  payload: ContextPayload;
  snapshot?: ProjectSnapshot;
}

/**
 * One thread's delivery state. The rendered snapshot text is the stable prefix;
 * `needPrime` marks the next turn as the session opener.
 */
interface ThreadContextState {
  /** The raw snapshot the next delta is computed against. */
  last?: ProjectSnapshot;
  /** The rendered snapshot text, re-sent identically each turn. */
  snapshotText?: string;
  /** A notice used while no snapshot text is available. */
  notice?: string;
  /** True until the first turn after a session opens has been served. */
  needPrime: boolean;
}

export class ContextDelivery {
  private readonly reads: ProjectContextReads;
  private readonly budget?: RenderBudget;
  private readonly states = new Map<string, ThreadContextState>();
  /**
   * Per-turn exclusion keys. Empty by default; the host sets them from the
   * panel and clears them after a turn is sent, so an exclusion is for the next
   * turn only and never persists silently into later ones.
   */
  private exclusions: readonly string[] = [];

  constructor(options: ContextDeliveryOptions) {
    this.reads = options.reads;
    this.budget = options.budget;
  }

  /**
   * The render budget for the current settings: an explicit budget wins, then
   * the user's overall byte cap, then the renderer's own default. The remaining
   * render caps (languages, tree, documents) stay at their defaults, because the
   * screen exposes only the overall bound.
   */
  private renderBudget(): RenderBudget | undefined {
    const maxBytes = this.reads.contextSettings?.().maxBytes;
    if (maxBytes === undefined) {
      return this.budget;
    }
    return { ...DEFAULT_RENDER_BUDGET, snapshot: maxBytes, ...(this.budget ?? {}) };
  }

  /** A stable key for one thread of one backend. */
  static key(backendId: string, threadId: string): string {
    return `${backendId}:${threadId}`;
  }

  /** The exclusion keys in effect for the next turn. */
  exclusionKeys(): string[] {
    return [...this.exclusions];
  }

  /**
   * Set the per-turn exclusions and re-arm the full snapshot for every thread.
   *
   * The previously rendered prefix was built from the unfiltered set, so it is
   * dropped along with the raw baseline: the next turn re-renders a complete,
   * filtered snapshot rather than sending a delta with no prefix. This reuses
   * the same reset path as a settings change, so an exclusion reaches an open
   * conversation's next turn exactly the way a settings change does.
   */
  setExclusions(keys: readonly string[]): void {
    this.exclusions = [...keys];
    this.resetRendered();
  }

  /** Drop each thread's rendered prefix and raw baseline, re-arming priming. */
  private resetRendered(): void {
    for (const [key, state] of this.states) {
      state.last = undefined;
      state.snapshotText = undefined;
      state.notice = undefined;
      state.needPrime = true;
      this.states.set(key, state);
    }
  }

  /**
   * The composer's context read model, built from a fresh snapshot with the
   * current exclusions applied. This is what the strip and panel render; the
   * webview never computes it.
   */
  async view(building = false): Promise<ContextView> {
    try {
      const snapshot = await this.reads.getSnapshot();
      return buildContextView(snapshot, { exclusions: this.exclusions, building });
    } catch {
      // A build that throws is reported as a distinct failure, never as an
      // empty workspace: the difference is exactly what the user needs before
      // trusting an answer.
      return {
        status: 'failed',
        selectionLines: 0,
        categories: [],
        includedCount: 0,
        excludedCount: 0,
        remainingGroups: 0,
        message: 'Project context could not be built for this workspace.'
      };
    }
  }

  /**
   * Read and render a fresh snapshot without attaching it to a thread. Used at
   * session start, before the thread id exists. A throw or an unbuildable
   * snapshot becomes a notice, never an exception.
   */
  async snapshot(input: GetSnapshotInput = {}): Promise<PrimedSnapshot> {
    try {
      const snapshot = await this.reads.getSnapshot(input);
      const filtered = applyContextExclusions(snapshot, this.exclusions);
      const rendered = renderSnapshotResult(filtered, { budget: this.renderBudget() });
      const workspaceRoot = filtered.workspace.roots[0];
      if (!rendered.ok) {
        return { payload: { notice: rendered.notice, priming: true, workspaceRoot } };
      }
      return { payload: { snapshot: rendered.text, priming: true, workspaceRoot }, snapshot };
    } catch {
      return { payload: { notice: CONTEXT_UNAVAILABLE_NOTICE, priming: true } };
    }
  }

  /**
   * Attach a session's prime to a thread. `primed` is true when the adapter
   * consumed the snapshot natively at start/resume; it only affects whether the
   * first turn is marked `priming` for an adapter that primes per turn. The
   * snapshot text is retained either way as the stable prefix.
   */
  begin(threadKey: string, prime: PrimedSnapshot, primed: boolean): void {
    this.states.set(threadKey, {
      last: prime.snapshot,
      snapshotText: prime.payload.snapshot,
      notice: prime.payload.notice,
      needPrime: !primed
    });
  }

  /**
   * The payload for the next turn: the stable snapshot prefix (when one exists)
   * plus a compact delta for anything that changed, with `priming` true on the
   * first turn of a session. A stateless adapter re-sends the prefix every turn;
   * a stateful one consumes it once.
   */
  async forTurn(threadKey: string, input: GetSnapshotInput = {}): Promise<ContextPayload> {
    const state = this.states.get(threadKey) ?? { needPrime: true };
    const delta = await this.buildDelta(threadKey, state, input);
    const priming = state.needPrime;
    state.needPrime = false;
    this.states.set(threadKey, state);
    return {
      ...(state.snapshotText ? { snapshot: state.snapshotText } : {}),
      ...(delta ? { delta } : {}),
      ...(!state.snapshotText && state.notice ? { notice: state.notice } : {}),
      ...(state.last ? { workspaceRoot: state.last.workspace.roots[0] } : {}),
      priming
    };
  }

  /**
   * Drop the cached picture and re-arm priming, so the next turn sends a fresh
   * snapshot. Called by the manual-refresh protocol message.
   */
  async refresh(threadKey: string, input: GetSnapshotInput = {}): Promise<ContextPayload> {
    const prime = await this.snapshot(input);
    const state = this.states.get(threadKey) ?? { needPrime: true };
    state.last = prime.snapshot;
    state.snapshotText = prime.payload.snapshot;
    state.notice = prime.payload.notice;
    state.needPrime = true;
    this.states.set(threadKey, state);
    return prime.payload;
  }

  /** Forget a thread's state, e.g. when its session ends. */
  forget(threadKey: string): void {
    this.states.delete(threadKey);
  }

  /**
   * Drop every thread's cached rendered prefix and re-arm priming, so the next
   * turn in each thread rebuilds the snapshot from current settings.
   *
   * This is what makes a saved `melink.context` change apply to the next turn of
   * an *open* conversation: without it, a primed thread would keep re-sending the
   * snapshot that was rendered under the old include flags, cap, or patterns, so
   * turning selection off would still ship the old selected text. The rebuild is
   * deferred to the next `forTurn`, so no snapshot is read here.
   */
  invalidateAll(): void {
    this.resetRendered();
  }

  /** The compact delta for this turn, or `undefined` when nothing changed. */
  private async buildDelta(
    threadKey: string,
    state: ThreadContextState,
    input: GetSnapshotInput
  ): Promise<string | undefined> {
    try {
      const current = await this.reads.getSnapshot(input);
      if (!state.last) {
        // No prior picture to diff against: the snapshot itself is the context.
        state.last = current;
        const filtered = applyContextExclusions(current, this.exclusions);
        const rendered = renderSnapshotResult(filtered, { budget: this.renderBudget() });
        if (rendered.ok) {
          state.snapshotText = rendered.text;
        }
        this.states.set(threadKey, state);
        return undefined;
      }
      // The delta compares the true pictures, then the rendering reflects the
      // next turn's exclusions, so a change is never hidden or invented by a
      // per-turn exclusion set.
      const delta = await this.reads.getDelta(state.last, current);
      state.last = current;
      this.states.set(threadKey, state);
      const filtered = applyContextExclusions(current, this.exclusions);
      return renderDelta(delta, filtered, { budget: this.renderBudget() }) ?? undefined;
    } catch {
      this.states.set(threadKey, state);
      return undefined;
    }
  }
}
