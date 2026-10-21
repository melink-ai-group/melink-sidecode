/**
 * The post-turn check runner, independent of VS Code.
 *
 * The host supplies the workspace root, a package.json reader, the resolved
 * settings and a spawn seam. This class owns the turn lifecycle:
 *
 * - one run per turn, and at most one active run per thread;
 * - the per-thread slot is claimed synchronously, before any await, so two
 *   overlapping starts cannot both own the thread;
 * - a stored `running` view and an update before the manifest read, so Keep is
 *   gated from the first review paint even on the auto-detect path;
 * - a stored final view and one update when it finishes;
 * - cancellation that kills the child and stores a skipped state;
 * - late results are dropped after cancellation or a superseded run.
 *
 * A background turn still stores its result; only the active surface receives
 * `onUpdate`. Output is bounded twice: 64 KiB per stream here and the core's
 * 4,000-character tail excerpt in the stored view. Check output never reaches a
 * model or provider, and no decision is ever made automatically.
 */

import {
  checkOutputExcerpt,
  resolveCheckPlan,
  runChecks,
  summarizeChecks,
  type CheckProcess,
  type CheckRunView,
  type CheckSettings,
  type SpawnCheck
} from './checks.ts';
import type { ResolvedCheckSettings } from './checkSettings.ts';
import type { CheckStore } from './checkStore.ts';

/** Per-stream bound applied before the core's smaller excerpt. */
export const CHECK_PROCESS_OUTPUT_LIMIT = 64 * 1024;

/** The scripts and package manager the check planner reads. */
export interface CheckManifest {
  scripts: Readonly<Record<string, string>>;
  packageManager?: string;
}

/** The workspace seam the host binds to VS Code. */
export interface CheckWorkspaceSource {
  workspaceRoot(): string | undefined;
  readManifest(root: string): Promise<CheckManifest | undefined>;
}

export interface CheckHostOptions extends CheckWorkspaceSource {
  store: CheckStore;
  readSettings: () => ResolvedCheckSettings;
  spawn: SpawnCheck;
  /** True while this turn is still known to the host (active or background). */
  isKnownTurn(backendId: string, threadId: string, turnId: string): boolean;
  /** True while this turn is the one the visible surface is showing. */
  isActiveTurn(backendId: string, threadId: string, turnId: string): boolean;
  now?: () => number;
}

export interface StartTurnChecksInput {
  backendId: string;
  threadId: string;
  turnId: string;
  hasChanges: boolean;
  /** The orchestration testing gate; false starts nothing at all. */
  shouldRun?: boolean;
  /**
   * The already-resolved orchestration testing value. When present it replaces
   * the legacy `enabled` reader, so a new explicit value always wins; trust,
   * commands, and the timeout still come from `readSettings`.
   */
  enabledOverride?: boolean;
  onUpdate?: (view: CheckRunView) => void;
}

interface RunRecord {
  backendId: string;
  threadId: string;
  turnId: string;
  startedAt: number;
  controller: AbortController;
  cancelled: boolean;
  /** True once the record has begun writing its own terminal view. */
  settled: boolean;
  onUpdate?: (view: CheckRunView) => void;
}

export class CheckHost {
  private readonly store: CheckStore;
  private readonly readSettings: () => ResolvedCheckSettings;
  private readonly workspace: CheckWorkspaceSource;
  private readonly spawn: SpawnCheck;
  private readonly isKnownTurn: CheckHostOptions['isKnownTurn'];
  private readonly isActiveTurn: CheckHostOptions['isActiveTurn'];
  private readonly now: () => number;
  /** Turns that have already been offered a run; a turn never runs twice. */
  private readonly started = new Set<string>();
  /** The single active run per thread. */
  private readonly activeByThread = new Map<string, RunRecord>();

  constructor(options: CheckHostOptions) {
    this.store = options.store;
    this.readSettings = options.readSettings;
    this.workspace = options;
    this.spawn = options.spawn;
    this.isKnownTurn = options.isKnownTurn;
    this.isActiveTurn = options.isActiveTurn;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Offer a turn's post-turn checks. The returned promise settles when the run
   * (and its final store write) is done; callers that do not want to wait may
   * ignore it. A turn without changes, an unknown turn, or a turn already
   * offered a run is ignored.
   */
  async startTurnChecks(input: StartTurnChecksInput): Promise<void> {
    if (!input.hasChanges || input.shouldRun === false) {
      return;
    }
    if (!this.isKnownTurn(input.backendId, input.threadId, input.turnId)) {
      return;
    }
    const key = runKey(input);
    if (this.started.has(key)) {
      return;
    }
    // The stored result, not the in-flight guard, is what makes a turn run at
    // most once: the guard is pruned when a run settles so it cannot grow.
    if (this.store.get(input.backendId, input.threadId, input.turnId)) {
      return;
    }

    const threadKey = threadRunKey(input);
    const previous = this.activeByThread.get(threadKey);
    const startedAt = this.now();
    const record: RunRecord = {
      backendId: input.backendId,
      threadId: input.threadId,
      turnId: input.turnId,
      startedAt,
      controller: new AbortController(),
      cancelled: false,
      settled: false,
      ...(input.onUpdate ? { onUpdate: input.onUpdate } : {})
    };
    // Claim the per-thread slot synchronously, before any await. A second start
    // for this thread now sees this record and supersedes it; nothing can
    // overwrite the slot without first cancelling the record it replaces.
    this.activeByThread.set(threadKey, record);
    this.started.add(key);

    if (previous) {
      await this.cancelRecord(previous, 'Superseded by a newer turn.');
    }
    if (this.isStale(record)) {
      return;
    }

    try {
      const settings = this.readSettings();
      const enabled = input.enabledOverride ?? settings.enabled;
      const root = this.workspace.workspaceRoot();
      const mayRun =
        settings.trusted &&
        enabled &&
        (settings.commands === undefined || settings.commands.length > 0) &&
        root !== undefined;

      if (mayRun) {
        // Store and post the starting state before the manifest read. Keep is
        // then gated from the first review paint, not after the read returns.
        const starting: CheckRunView = {
          status: 'running',
          summary: 'Checks starting…',
          results: [],
          startedAt
        };
        await this.store.set(input.backendId, input.threadId, input.turnId, starting);
        if (this.isStale(record)) {
          return;
        }
        this.postIfActive(input, starting);
      }

      let manifest: CheckManifest | undefined;
      if (settings.trusted && enabled && settings.commands === undefined) {
        try {
          manifest = root ? await this.workspace.readManifest(root) : undefined;
        } catch {
          manifest = undefined;
        }
        if (this.isStale(record)) {
          return;
        }
      }

      const coreSettings: CheckSettings = {
        enabled,
        timeoutMs: settings.timeoutMs,
        ...(settings.commands !== undefined ? { commands: settings.commands } : {})
      };
      const plan = resolveCheckPlan(coreSettings, {
        trusted: settings.trusted,
        scripts: manifest?.scripts ?? {},
        ...(manifest?.packageManager !== undefined ? { packageManager: manifest.packageManager } : {})
      });

      if (plan.status !== 'run' || !root) {
        const terminal = terminalView(
          plan.status === 'untrusted' ? 'untrusted' : 'skipped',
          plan.status === 'run' ? 'Checks skipped: no workspace folder is open.' : plan.summary,
          startedAt,
          this.now()
        );
        record.settled = true;
        await this.store.set(input.backendId, input.threadId, input.turnId, terminal);
        if (this.isStale(record)) {
          return;
        }
        this.postIfActive(input, terminal);
        return;
      }

      if (!this.isKnownTurn(input.backendId, input.threadId, input.turnId)) {
        const terminal = terminalView(
          'skipped',
          'Checks skipped: the turn is no longer available.',
          startedAt,
          this.now()
        );
        record.settled = true;
        await this.store.set(input.backendId, input.threadId, input.turnId, terminal);
        if (this.isStale(record)) {
          return;
        }
        this.postIfActive(input, terminal);
        return;
      }

      const results = await runChecks(plan.commands, this.boundedSpawn(), {
        cwd: root,
        timeoutMs: settings.timeoutMs,
        signal: record.controller.signal,
        now: this.now
      });
      if (this.isStale(record)) {
        return;
      }
      if (!this.isKnownTurn(input.backendId, input.threadId, input.turnId)) {
        const terminal = terminalView(
          'skipped',
          'Checks skipped: the turn is no longer available.',
          startedAt,
          this.now()
        );
        record.settled = true;
        await this.store.set(input.backendId, input.threadId, input.turnId, terminal);
        if (this.isStale(record)) {
          return;
        }
        this.postIfActive(input, terminal);
        return;
      }

      const final = summarizeChecks(results, startedAt, this.now());
      record.settled = true;
      await this.store.set(input.backendId, input.threadId, input.turnId, final);
      if (this.isStale(record)) {
        return;
      }
      this.postIfActive(input, final);
    } catch (error) {
      if (this.isStale(record)) {
        return;
      }
      const finishedAt = this.now();
      const failed: CheckRunView = {
        status: 'failed',
        summary: 'Checks: errored',
        results: [
          {
            name: 'Checks',
            command: '',
            status: 'error',
            durationMs: Math.max(0, finishedAt - startedAt),
            reason: errorMessage(error)
          }
        ],
        startedAt,
        finishedAt
      };
      record.settled = true;
      await this.store.set(input.backendId, input.threadId, input.turnId, failed);
      if (this.isStale(record)) {
        return;
      }
      this.postIfActive(input, failed);
    } finally {
      if (this.activeByThread.get(threadKey) === record) {
        this.activeByThread.delete(threadKey);
      }
      this.started.delete(key);
    }
  }

  /**
   * Abort the active run for a thread and store a skipped state for its turn.
   * Late results from the killed run are ignored by the run-identity check.
   */
  async cancelThread(
    backendId: string,
    threadId: string,
    reason = 'Superseded by a newer turn.'
  ): Promise<void> {
    const record = this.activeByThread.get(threadRunKey({ backendId, threadId }));
    if (!record) {
      return;
    }
    await this.cancelRecord(record, reason);
  }

  /** True while this turn's run offer is in flight (the guard is pruned on finish). */
  hasStarted(backendId: string, threadId: string, turnId: string): boolean {
    return this.started.has(runKey({ backendId, threadId, turnId }));
  }

  /** True when this record was cancelled or has been replaced in its slot. */
  private isStale(record: RunRecord): boolean {
    return record.cancelled || this.activeByThread.get(threadRunKey(record)) !== record;
  }

  /**
   * Supersede one record: mark it synchronously, abort its child, and write a
   * skipped state unless the record already began its own terminal write.
   */
  private async cancelRecord(record: RunRecord, reason: string): Promise<void> {
    if (record.cancelled || record.settled) {
      return;
    }
    record.cancelled = true;
    const threadKey = threadRunKey(record);
    if (this.activeByThread.get(threadKey) === record) {
      this.activeByThread.delete(threadKey);
    }
    this.started.delete(runKey(record));
    try {
      record.controller.abort();
    } catch {
      // The controller cannot fail in practice; cancellation still proceeds.
    }

    const current = this.store.get(record.backendId, record.threadId, record.turnId);
    if (current && current.status !== 'running') {
      return;
    }
    const finishedAt = this.now();
    const startedAt = current?.startedAt ?? record.startedAt;
    const skipped: CheckRunView = {
      status: 'skipped',
      summary: `Checks skipped: ${reason}`,
      results: [
        {
          name: 'Checks',
          command: '',
          status: 'skipped',
          durationMs: Math.max(0, finishedAt - startedAt),
          reason
        }
      ],
      startedAt,
      finishedAt
    };
    await this.store.set(record.backendId, record.threadId, record.turnId, skipped);
    if (record.onUpdate) {
      if (this.isActiveTurn(record.backendId, record.threadId, record.turnId)) {
        safeUpdate(record.onUpdate, skipped);
      }
    }
  }

  private boundedSpawn(): SpawnCheck {
    return (command: string, options: { cwd: string }): CheckProcess => {
      const process = this.spawn(command, options);
      return {
        kill: () => process.kill(),
        promise: process.promise.then((value) => ({
          code: value.code,
          stdout: checkOutputExcerpt(value.stdout, CHECK_PROCESS_OUTPUT_LIMIT),
          stderr: checkOutputExcerpt(value.stderr, CHECK_PROCESS_OUTPUT_LIMIT),
          ...(value.error !== undefined ? { error: value.error } : {})
        }))
      };
    };
  }

  private postIfActive(input: StartTurnChecksInput, view: CheckRunView): void {
    if (!input.onUpdate) {
      return;
    }
    if (this.isActiveTurn(input.backendId, input.threadId, input.turnId)) {
      safeUpdate(input.onUpdate, view);
    }
  }
}

function runKey(input: { backendId: string; threadId: string; turnId: string }): string {
  return `${input.backendId}:${input.threadId}:${input.turnId}`;
}

function threadRunKey(input: { backendId: string; threadId: string }): string {
  return `${input.backendId}:${input.threadId}`;
}

function terminalView(
  status: 'skipped' | 'untrusted',
  summary: string,
  startedAt: number,
  finishedAt: number
): CheckRunView {
  return { status, summary, results: [], startedAt, finishedAt };
}

function safeUpdate(update: (view: CheckRunView) => void, view: CheckRunView): void {
  try {
    update(view);
  } catch {
    // A UI consumer must not break the check lifecycle.
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error) {
    return error;
  }
  return 'The checks could not complete.';
}
