/**
 * Host-free post-turn checks.
 *
 * The host owns trust, the workspace root and the real child process. This
 * module only decides which scripts to run, runs them through an injected
 * `SpawnCheck` seam, and reduces the results to a bounded, serializable view.
 * It imports no `vscode`, filesystem, child-process, or network module, so it
 * is unit-testable headless and can never change the workspace itself.
 */

export type CheckStatus = 'passed' | 'failed' | 'timed-out' | 'error' | 'skipped';
export type CheckOverallStatus = 'running' | 'passed' | 'failed' | 'skipped' | 'untrusted';

export interface CheckCommand {
  name: string;
  command: string;
}

export interface CheckResult {
  name: string;
  command: string;
  status: CheckStatus;
  durationMs: number;
  output?: string;
  reason?: string;
}

export interface CheckRunView {
  status: CheckOverallStatus;
  summary: string;
  results: CheckResult[];
  startedAt: number;
  finishedAt?: number;
}

export interface CheckSettings {
  enabled: boolean;
  commands?: string[];
  timeoutMs: number;
}

export interface CheckResolveContext {
  trusted: boolean;
  scripts: Readonly<Record<string, string>>;
  packageManager?: string;
}

export type CheckPlan =
  | { status: 'run'; commands: CheckCommand[] }
  | { status: 'off' | 'untrusted' | 'no-scripts'; summary: string };

export interface CheckProcess {
  promise: Promise<{ code: number | null; stdout: string; stderr: string; error?: string }>;
  kill(): void;
}

export type SpawnCheck = (command: string, options: { cwd: string }) => CheckProcess;

export interface CheckRunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  now?: () => number;
}

export const CHECK_OUTPUT_LIMIT = 4000;

const TRUNCATION_MARKER = '…';
const SUPERSEDED_REASON = 'Superseded by a newer turn';

/** Pick the scripts a turn should run by default, preferring typecheck over lint. */
export function detectDefaultChecks(
  scripts: Readonly<Record<string, string>>,
  packageManager = 'npm'
): CheckCommand[] {
  const prefix = packageManagerName(packageManager);
  const names: string[] = [];
  if (hasScript(scripts, 'typecheck')) {
    names.push('typecheck');
  } else if (hasScript(scripts, 'lint')) {
    names.push('lint');
  }
  if (hasScript(scripts, 'test')) {
    names.push('test');
  }

  const seen = new Set<string>();
  const commands: CheckCommand[] = [];
  for (const name of names) {
    const command = `${prefix} run ${name}`;
    if (seen.has(command)) {
      continue;
    }
    seen.add(command);
    commands.push({ name, command });
  }
  return commands;
}

/** Decide whether to run, skip, or report why there is nothing to run. */
export function resolveCheckPlan(settings: CheckSettings, context: CheckResolveContext): CheckPlan {
  if (!context.trusted) {
    return { status: 'untrusted', summary: 'Checks skipped: workspace is untrusted.' };
  }
  if (!settings.enabled) {
    return { status: 'off', summary: 'Checks are disabled.' };
  }
  if (settings.commands !== undefined) {
    if (settings.commands.length === 0) {
      return { status: 'off', summary: 'Checks disabled by configuration.' };
    }
    return {
      status: 'run',
      commands: settings.commands.map((command) => ({ name: command, command }))
    };
  }

  const commands = detectDefaultChecks(context.scripts, context.packageManager);
  if (commands.length === 0) {
    return {
      status: 'no-scripts',
      summary: 'Checks skipped: package.json has no typecheck, lint, or test script.'
    };
  }
  return { status: 'run', commands };
}

/** Run checks in order. A failure or a timeout never stops the remaining checks. */
export async function runChecks(
  commands: readonly CheckCommand[],
  spawn: SpawnCheck,
  options: CheckRunOptions
): Promise<CheckResult[]> {
  const now = options.now ?? Date.now;
  const timeoutMs = Math.max(1, options.timeoutMs);
  const results: CheckResult[] = [];

  for (const check of commands) {
    if (options.signal?.aborted) {
      results.push(skippedResult(check));
      continue;
    }

    const startedAt = now();
    const finish = (status: CheckStatus, output?: string, reason?: string): CheckResult => {
      const result: CheckResult = {
        name: check.name,
        command: check.command,
        status,
        durationMs: Math.max(0, now() - startedAt)
      };
      if (output !== undefined && output.length > 0) {
        result.output = output;
      }
      if (reason !== undefined) {
        result.reason = reason;
      }
      return result;
    };

    let process: CheckProcess;
    try {
      process = spawn(check.command, { cwd: options.cwd });
    } catch (error) {
      results.push(finish('error', undefined, errorMessage(error)));
      continue;
    }

    const outcome = await waitForProcess(process, timeoutMs, options.signal);
    if (outcome.kind === 'timeout') {
      safeKill(process);
      results.push(finish('timed-out', undefined, `Check timed out after ${timeoutMs}ms.`));
      continue;
    }
    if (outcome.kind === 'aborted') {
      safeKill(process);
      results.push(finish('skipped', undefined, SUPERSEDED_REASON));
      continue;
    }

    const output = combineOutput(outcome.value.stdout, outcome.value.stderr);
    if (outcome.value.error) {
      results.push(finish('error', output, outcome.value.error));
      continue;
    }
    results.push(
      outcome.value.code === 0 ? finish('passed', output) : finish('failed', output)
    );
  }

  return results;
}

/** Overall status for a finished (or partial) set of results. */
export function overallCheckStatus(results: readonly CheckResult[]): CheckOverallStatus {
  if (results.length === 0) {
    return 'skipped';
  }
  if (results.some((result) => result.status === 'failed' || result.status === 'timed-out' || result.status === 'error')) {
    return 'failed';
  }
  if (results.every((result) => result.status === 'skipped')) {
    return 'skipped';
  }
  return 'passed';
}

/** Build the view the host stores for one finished run. */
export function summarizeChecks(
  results: readonly CheckResult[],
  startedAt: number,
  finishedAt?: number
): CheckRunView {
  const view: CheckRunView = {
    status: overallCheckStatus(results),
    summary: checkSummary(results),
    results: results.map((result) => ({ ...result })),
    startedAt
  };
  if (finishedAt !== undefined) {
    view.finishedAt = finishedAt;
  }
  return view;
}

/** Keep the tail of check output, bounded to `max` characters including the marker. */
export function checkOutputExcerpt(text: string, max = CHECK_OUTPUT_LIMIT): string {
  if (max <= 0) {
    return '';
  }
  if (text.length <= max) {
    return text;
  }
  if (max === 1) {
    return TRUNCATION_MARKER;
  }
  return `${TRUNCATION_MARKER}${text.slice(text.length - (max - 1))}`;
}

type ProcessOutcome =
  | { kind: 'result'; value: Awaited<CheckProcess['promise']> }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

function waitForProcess(
  process: CheckProcess,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ProcessOutcome> {
  return new Promise<ProcessOutcome>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const settle = (outcome: ProcessOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve(outcome);
    };

    timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs);
    if (signal) {
      if (signal.aborted) {
        settle({ kind: 'aborted' });
        return;
      }
      onAbort = () => settle({ kind: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });
    }

    process.promise.then(
      (value) => settle({ kind: 'result', value }),
      (error: unknown) =>
        settle({
          kind: 'result',
          value: { code: null, stdout: '', stderr: '', error: errorMessage(error) }
        })
    );
  });
}

function skippedResult(check: CheckCommand): CheckResult {
  return {
    name: check.name,
    command: check.command,
    status: 'skipped',
    durationMs: 0,
    reason: SUPERSEDED_REASON
  };
}

function safeKill(process: CheckProcess): void {
  try {
    process.kill();
  } catch {
    // A check must never throw into the host.
  }
}

function combineOutput(stdout: string, stderr: string): string | undefined {
  const parts: string[] = [];
  if (stdout) {
    parts.push(stdout);
  }
  if (stderr) {
    parts.push(stderr);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return checkOutputExcerpt(parts.join('\n'), CHECK_OUTPUT_LIMIT);
}

function packageManagerName(packageManager: string): string {
  const trimmed = packageManager.trim();
  const at = trimmed.lastIndexOf('@');
  const name = at > 0 ? trimmed.slice(0, at) : trimmed;
  return name || 'npm';
}

function hasScript(scripts: Readonly<Record<string, string>>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(scripts, name);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error) {
    return error;
  }
  return 'The check failed to start.';
}

function checkSummary(results: readonly CheckResult[]): string {
  if (results.length === 0) {
    return 'Checks: no checks';
  }
  const counts: ReadonlyArray<readonly [CheckStatus, string]> = [
    ['passed', 'passed'],
    ['failed', 'failed'],
    ['timed-out', 'timed out'],
    ['error', 'errored'],
    ['skipped', 'skipped']
  ];
  const parts: string[] = [];
  for (const [status, label] of counts) {
    const count = results.filter((result) => result.status === status).length;
    if (count > 0) {
      parts.push(`${count} ${label}`);
    }
  }
  return `Checks: ${parts.join(' · ')}`;
}
