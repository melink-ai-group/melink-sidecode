/**
 * Display and gating for the host's post-turn check view.
 *
 * The host decides what ran and whether a keep is blocked; this module only
 * turns the stored view into text a person can read without relying on colour.
 * It is plain data with no React or DOM dependency, so the wording and the
 * gate can be tested headlessly.
 */

import type { CheckResult, CheckRunView, CheckStatus } from '../review/checks';

/** Keep the visible failure detail short; the host already bounds the stored output. */
export const CHECK_EXCERPT_LIMIT = 400;

export type KeepGate = 'allowed' | 'blocked-running' | 'needs-override';

export interface CheckRowView {
  name: string;
  command?: string;
  status: CheckStatus | 'running';
  /** A word, so the state never depends on colour. */
  statusLabel: string;
  durationLabel: string;
  /** True for an outcome that keeps requires an explicit override. */
  failed: boolean;
  /** Bounded output excerpt for a failed, timed-out, or errored check. */
  excerpt?: string;
  /** Why a check was skipped, or the host's failure reason. */
  reason?: string;
}

const STATUS_LABELS: Readonly<Record<CheckStatus | 'running', string>> = {
  passed: 'Passed',
  failed: 'Failed',
  'timed-out': 'Timed out',
  error: 'Error',
  skipped: 'Skipped',
  running: 'Running'
};

const FAILURE_STATUSES: ReadonlySet<CheckStatus> = new Set(['failed', 'timed-out', 'error']);

function isFailure(status: CheckStatus): boolean {
  return FAILURE_STATUSES.has(status);
}

/**
 * The one-line header summary. Undefined means the turn has no check view at
 * all, so the caller shows nothing.
 */
export function checkSummary(checks: CheckRunView | undefined): string | undefined {
  if (!checks) {
    return undefined;
  }
  if (checks.status === 'running') {
    return 'Checks running…';
  }
  if (checks.status === 'untrusted' || checks.status === 'skipped') {
    // The host's summary carries the reason (untrusted, disabled, no scripts,
    // interrupted); the fixed wording would throw that away.
    const hostSummary = checks.summary?.trim();
    if (hostSummary) {
      return hostSummary;
    }
    return checks.status === 'untrusted'
      ? 'Checks skipped (untrusted workspace)'
      : 'Checks skipped';
  }
  const passed = checks.results.filter((result) => result.status === 'passed').length;
  if (checks.status === 'passed') {
    return `Checks: ${passed} passed`;
  }
  const failed = checks.results.filter((result) => isFailure(result.status)).length;
  if (failed === 0) {
    return 'Checks failed';
  }
  return passed > 0 ? `Checks: ${failed} failed · ${passed} passed` : `Checks: ${failed} failed`;
}

/** One row per check, plus a running row while the host has not reported names. */
export function checkRows(checks: CheckRunView | undefined): CheckRowView[] {
  if (!checks) {
    return [];
  }
  if (checks.results.length === 0) {
    if (checks.status === 'running') {
      return [
        {
          name: 'Checks',
          status: 'running',
          statusLabel: STATUS_LABELS.running,
          durationLabel: '',
          failed: false
        }
      ];
    }
    if (checks.status === 'skipped' || checks.status === 'untrusted') {
      return [
        {
          name: 'Checks',
          status: 'skipped',
          statusLabel: STATUS_LABELS.skipped,
          durationLabel: '',
          failed: false,
          reason: reasonFromSummary(checks.summary, checks.status)
        }
      ];
    }
  }
  return checks.results.map((result) => toRow(result));
}

/**
 * Whether Keep may run now. A still-running check is never bypassable; a
 * failed, timed-out, or errored check requires the user's explicit override.
 */
export function keepGate(checks: CheckRunView | undefined): KeepGate {
  if (!checks) {
    return 'allowed';
  }
  if (checks.status === 'running') {
    return 'blocked-running';
  }
  if (checks.status === 'failed') {
    return 'needs-override';
  }
  return 'allowed';
}

function toRow(result: CheckResult): CheckRowView {
  const failed = isFailure(result.status);
  const row: CheckRowView = {
    name: result.name,
    ...(result.command ? { command: result.command } : {}),
    status: result.status,
    statusLabel: statusLabel(result.status),
    durationLabel: formatDuration(result.durationMs),
    failed
  };
  if (failed) {
    const excerpt = boundedExcerpt(result.output);
    if (excerpt) {
      row.excerpt = excerpt;
    }
    if (result.reason) {
      row.reason = result.reason;
    }
  } else if (result.status === 'skipped' && result.reason) {
    row.reason = result.reason;
  }
  return row;
}

/** The reason inside a host summary, without the repeated "Checks skipped:" label. */
function reasonFromSummary(summary: string | undefined, status: CheckRunView['status']): string {
  const trimmed = summary?.trim();
  if (!trimmed) {
    return status === 'untrusted' ? 'Workspace is untrusted.' : 'Checks were skipped.';
  }
  const stripped = trimmed.replace(/^Checks skipped:\s*/i, '').trim();
  return stripped || trimmed;
}

function statusLabel(status: CheckStatus): string {
  return STATUS_LABELS[status];
}

/** Milliseconds below one second, seconds above it, never a bare number. */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return '';
  }
  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`;
  }
  const seconds = durationMs / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}

/** Keep the tail of a failure detail, bounded to `max` including the ellipsis. */
export function boundedExcerpt(text: string | undefined, max = CHECK_EXCERPT_LIMIT): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (max <= 0) {
    return undefined;
  }
  if (trimmed.length <= max) {
    return trimmed;
  }
  if (max === 1) {
    return '…';
  }
  return `…${trimmed.slice(trimmed.length - (max - 1))}`;
}
