import { memo, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type {
  ChangeDecisionResult,
  ChangeFileView,
  ChangeView,
  ConflictResolution
} from '../protocol';
import {
  AlertIcon,
  CheckIcon,
  ChevronRightIcon,
  CrossIcon,
  DiffIcon,
  FileIcon,
  InfoIcon,
  PencilIcon,
  PlusIcon,
  PauseIcon,
  RenameIcon,
  RestoreIcon,
  SearchIcon,
  ShieldIcon,
  TrashIcon
} from './Icons';
import { checkRows, checkSummary, keepGate, type CheckRowView } from './checkReviewView';
import { prettyPath } from './prettyPath.ts';
import { diffReviewView, stylingReviewView, type DiffReviewView } from './diffReviewView.ts';
import { confirmRestoreTarget, focusableControls, trapTab } from './focusTrap.ts';
import { ReviewNotice } from './ReviewNotice';

/**
 * The change review surface: what a turn changed, with per-file keep/reject.
 *
 * A full-width inline panel inside the view, never a floating popover (the
 * switcher invariant). It starts collapsed to a one-line count, and when open
 * renders one compact row per recorded file. The diff itself opens in the
 * workbench editor. The header's primary action is `Keep`.
 *
 * Decision state is carried by text and an icon, never colour alone, so it is
 * legible with colour removed. Reject (per file and all) is destructive and
 * never implicit: it opens a confirmation that names the affected paths, and
 * only an explicit confirm posts the decision.
 *
 * The host owns every fact here: paths, statuses, counts, diffs and the
 * decisions made so far. Nothing in this component decides anything locally; it
 * only reflects the snapshot and asks the host to act.
 */

export interface ChangesReviewProps {
  review: ChangeView;
  /** True while a turn is running, so the surface shows its pending state. */
  busy: boolean;
  /** True while a decision request is in flight, so controls lock. */
  deciding: boolean;
  /** Send the listed issues as a normal user message. */
  onFix: (text: string) => void;
  fixDisabled?: boolean;
  hideFix?: boolean;
  /** The most recent decision outcomes, so a conflict or failure is surfaced. */
  decisionResults?: ChangeDecisionResult[];
  /** The destructive reject awaiting an explicit confirmation, if any. */
  rejectConfirm?: { scope: 'file' | 'all'; paths: string[] };
  /** Open one changed file in the editor (its working copy). */
  onOpenFile: (absPath: string) => void;
  /**
   * Open one changed file's pre-turn vs working diff in the built-in diff
   * editor. The host serves the left-hand side from the journal and degrades to
   * a notice when the native view is unavailable, never throwing.
   */
  onOpenDiff: (path: string) => void;
  /** Open the whole turn in the built-in multi-file changes view. */
  onOpenAllInEditor: () => void;
  /** Fallback: reveal a changed file / open the Source Control view. */
  onRevealInSourceControl: (absPath?: string) => void;
  /** `overrideChecks` is true only after the user confirmed the failed-check bypass. */
  onKeep: (path: string, overrideChecks?: boolean) => void;
  /** Open the destructive reject confirmation for one file or the whole turn. */
  onRequestReject: (scope: 'file' | 'all', paths: string[]) => void;
  onCancelReject: () => void;
  /** Confirm the pending reject; the host decides the scope from the request. */
  onConfirmReject: () => void;
  onKeepAll: (overrideChecks?: boolean) => void;
  /** Resolve a conflict with an explicit choice; nothing overwrites silently. */
  onResolveConflict: (path: string, resolution: ConflictResolution) => void;
  /** Load hunk lines for one expanded file. The snapshot omits them until then. */
  onLoadHunks: (path: string) => void;
}

function ChangesReviewView({
  review,
  busy,
  deciding,
  onFix,
  fixDisabled,
  hideFix,
  decisionResults,
  rejectConfirm,
  onOpenFile,
  onOpenDiff,
  onOpenAllInEditor,
  onRevealInSourceControl,
  onKeep,
  onRequestReject,
  onCancelReject,
  onConfirmReject,
  onKeepAll,
  onResolveConflict
}: ChangesReviewProps): JSX.Element {
  const [visibleFileCount, setVisibleFileCount] = useState(24);
  /** The file list stays closed until the user opens it. */
  const [expanded, setExpanded] = useState(false);
  /**
   * Outcomes accumulate across decision rounds. A single `changes/decisionResult`
   * carries only the files that just resolved, so replacing the map would erase a
   * still-unresolved conflict when an unrelated file is decided. Reset when the
   * turn (and therefore its review) changes.
   */
  const [outcomeMemory, setOutcomeMemory] = useState<Map<string, ChangeDecisionResult>>(() => new Map());
  const outcomeTurnRef = useRef<string | undefined>(undefined);
  /** The keep awaiting confirmation because the post-turn checks failed. */
  const [keepConfirm, setKeepConfirm] = useState<{ scope: 'file' | 'all'; path?: string } | undefined>(
    undefined
  );
  const checks = review.checks;
  const gate = keepGate(checks);
  const summary = checkSummary(checks);
  const rows = checkRows(checks);
  const failedNames = rows.filter((row) => row.failed).map((row) => row.name);
  const sectionRef = useRef<HTMLElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const confirmTriggerRef = useRef<HTMLElement | null>(null);
  const restoreFrameRef = useRef<number | undefined>(undefined);
  const cancelRejectRef = useRef(onCancelReject);
  cancelRejectRef.current = onCancelReject;
  const confirmOpen = rejectConfirm !== undefined;
  const confirmKey = rejectConfirm ? `${rejectConfirm.scope}:${rejectConfirm.paths.join('|')}` : '';
  useEffect(() => {
    setVisibleFileCount(24);
    setExpanded(false);
    setKeepConfirm(undefined);
  }, [review.turnId]);

  useEffect(() => {
    // A fresh check view that no longer needs an override closes a stale dialog.
    if (gate !== 'needs-override') {
      setKeepConfirm(undefined);
    }
  }, [gate]);

  useEffect(() => {
    // Only one destructive-style confirmation may be on screen at a time.
    if (rejectConfirm) {
      setKeepConfirm(undefined);
    }
  }, [rejectConfirm]);

  useEffect(() => {
    setOutcomeMemory((current) => {
      const next =
        outcomeTurnRef.current === review.turnId ? new Map(current) : new Map<string, ChangeDecisionResult>();
      outcomeTurnRef.current = review.turnId;
      for (const result of decisionResults ?? []) {
        next.set(result.relPath, result);
      }
      return next;
    });
  }, [review.turnId, decisionResults]);

  // The destructive confirmation is a modal step: capture what opened it, put
  // focus on its first choice, and keep Tab inside. Re-capture when the confirm
  // target changes while it stays open.
  useEffect(() => {
    if (!confirmOpen) {
      return;
    }
    if (restoreFrameRef.current !== undefined) {
      cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = undefined;
    }
    const invoking = document.activeElement;
    if (
      invoking instanceof HTMLElement &&
      invoking !== document.body &&
      !confirmRef.current?.contains(invoking)
    ) {
      confirmTriggerRef.current = invoking;
    }
    const first = focusableControls(confirmRef.current)[0];
    (first ?? confirmRef.current)?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelRejectRef.current();
        return;
      }
      trapTab(event, confirmRef.current);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [confirmOpen, confirmKey]);

  // Restore only after the decision has repainted the review. A confirmed
  // reject disables the row trigger, so the frame checks usability and falls
  // back to the still-enabled panel header instead of focusing a dead button.
  useEffect(() => {
    if (!confirmOpen) {
      return;
    }
    return () => {
      if (restoreFrameRef.current !== undefined) {
        cancelAnimationFrame(restoreFrameRef.current);
      }
      restoreFrameRef.current = requestAnimationFrame(() => {
        restoreFrameRef.current = undefined;
        const trigger = confirmTriggerRef.current;
        const triggerUsable =
          trigger?.isConnected === true && !('disabled' in trigger && trigger.disabled);
        if (confirmRestoreTarget(triggerUsable) === 'trigger' && trigger) {
          trigger.focus();
          return;
        }
        sectionRef.current?.querySelector<HTMLElement>('.changes-review__collapse')?.focus();
      });
    };
  }, [confirmOpen]);

  // A row still `pending` shows its remembered conflict or failure marker; a row
  // that has resolved clears it, because the decision took effect and the host
  // repainted the file's decision.
  const outcomes = useMemo(() => {
    const map = new Map<string, ChangeDecisionResult>();
    for (const file of review.files) {
      if (file.decision !== 'pending') {
        continue;
      }
      const remembered = outcomeMemory.get(file.path);
      if (remembered) {
        map.set(file.path, remembered);
      }
    }
    return map;
  }, [review, outcomeMemory]);

  const visibleFiles = review.files.slice(0, visibleFileCount);
  const countLabel = fileCountLabel(review.files);
  const diffReview = diffReviewView(review.diffReview);
  const stylingReview = stylingReviewView(review.stylingReview);
  // An advisory pass that could not run produced no assessment, so its notice
  // is not shown and it contributes no attention count or Fix instruction.
  const visibleDiffReview = diffReview?.kind === 'failed' ? undefined : diffReview;
  const visibleStylingReview = stylingReview?.kind === 'failed' ? undefined : stylingReview;
  const reviews = [visibleDiffReview, visibleStylingReview].filter(
    (view): view is DiffReviewView => view !== undefined
  );
  const attention = (['error', 'warning', 'info'] as const).map((severity) => ({
    severity,
    count: reviews.reduce((count, view) => count + view.findings.filter((finding) => finding.severity === severity).length, 0) +
      (severity === 'error' ? Math.max(rows.filter((row) => row.failed).length, gate === 'needs-override' ? 1 : 0) : 0)
  })).filter(({ count }) => count > 0);
  const fixMessage = [
    'Fix the following issues. Inspect the current files first and rerun the relevant checks after making changes.',
    ...reviews.flatMap((view) =>
      view.findings.map((finding) => `${finding.severityLabel}: ${finding.location} — ${finding.message}`)),
    ...rows.filter((row) => row.failed).map((row) =>
      `${row.statusLabel}: ${row.name}${row.command ? ` (${row.command})` : ''}\n${[row.reason, row.excerpt].filter(Boolean).join('\n')}`),
    ...(gate === 'needs-override' && !rows.some((row) => row.failed) ? [summary ?? 'Post-turn checks failed.'] : [])
  ].join('\n\n');

  const locked = busy || deciding;
  const keepBlocked = gate === 'blocked-running';
  const allKept = review.files.length > 0 && review.files.every((file) => file.decision === 'accepted');

  const requestKeep = (target: { scope: 'file' | 'all'; path?: string }): void => {
    if (keepBlocked) {
      return;
    }
    if (gate === 'needs-override') {
      if (rejectConfirm) {
        onCancelReject();
      }
      setKeepConfirm(target);
      return;
    }
    if (target.scope === 'all') {
      onKeepAll();
    } else if (target.path) {
      onKeep(target.path);
    }
  };

  const confirmKeep = (): void => {
    const pending = keepConfirm;
    if (!pending) {
      return;
    }
    setKeepConfirm(undefined);
    if (pending.scope === 'all') {
      onKeepAll(true);
    } else if (pending.path) {
      onKeep(pending.path, true);
    }
  };

  const requestReject = (scope: 'file' | 'all', paths: string[]): void => {
    setKeepConfirm(undefined);
    onRequestReject(scope, paths);
  };

  const rejectPaths =
    rejectConfirm?.scope === 'all'
      ? review.files.map((file) => file.path)
      : rejectConfirm?.paths ?? [];

  return (
    <section
      ref={sectionRef}
      className={`changes-review${expanded ? ' is-open' : ''}${allKept ? ' changes-review--kept' : ''}`}
      aria-labelledby={`changes-review-title-${review.turnId}`}
      aria-busy={busy}
    >
      <header className="changes-review__head">
        <button
          className="changes-review__collapse"
          type="button"
          aria-expanded={expanded}
          aria-controls={`changes-review-files-${review.turnId}`}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronRightIcon className="ico ico--xs changes-review__chevron" />
          <span className="changes-review__title" id={`changes-review-title-${review.turnId}`}>
            {allKept ? 'Kept' : 'Files changed'}
          </span>
          {busy ? (
            <span className="status-chip status-chip--icon status-chip--running" title="Running" role="status" aria-label="Running">
              <span className="spinner" aria-hidden="true" />
            </span>
          ) : countLabel ? (
            <span className="changes-review__counts">{countLabel}</span>
          ) : null}
          {summary ? (
            <span
              className={`changes-review__checks-summary${
                gate === 'needs-override' ? ' changes-review__checks-summary--failed' : ''
              }`}
              role="status"
            >
              {checks?.status === 'running' ? (
                <span className="spinner" aria-hidden="true" />
              ) : gate === 'needs-override' ? (
                <AlertIcon className="ico ico--xs" />
              ) : null}
              {summary}
            </span>
          ) : null}
        </button>
        {!expanded && attention.length > 0 ? (
          <span className="changes-review__attention" role="status" aria-label="Issues need attention">
            {attention.map(({ severity, count }) => {
              const Icon = severity === 'info' ? InfoIcon : severity === 'error' ? CrossIcon : AlertIcon;
              const label = `${count} ${severity === 'info' ? 'informational notice' : severity}${count === 1 ? '' : 's'}`;
              return (
                <span key={severity} className={`changes-review__attention-item diff-review__severity--${severity}`} role="img" aria-label={label} title={label}>
                  <Icon className="ico ico--xs" />{count}
                </span>
              );
            })}
          </span>
        ) : null}
        {attention.length > 0 && !hideFix ? (
          <button className="btn changes-review__fix" type="button" disabled={busy || deciding || fixDisabled} onClick={() => onFix(fixMessage)} title="Send a message asking the agent to fix the reported issues">
            <PencilIcon className="ico ico--xs" />Fix
          </button>
        ) : null}
        {allKept ? null : (
          <>
            <button
              className="btn changes-review__icon-btn changes-review__icon-btn--danger"
              type="button"
              disabled={locked || review.files.length === 0}
              aria-label="Undo this turn"
              title="Undo this turn's file changes. Restoring the chat to this message stays available."
              onClick={() => requestReject('all', review.files.map((file) => file.path))}
            >
              <RestoreIcon className="ico ico--xs" />
            </button>
            <button
              className="btn btn--primary changes-review__icon-btn"
              type="button"
              disabled={locked || keepBlocked || review.files.length === 0}
              aria-label="Keep this turn"
              title={
                keepBlocked
                  ? 'Keep is disabled until the checks finish.'
                  : gate === 'needs-override'
                    ? 'Checks failed. Confirm to keep anyway.'
                    : "Keep this turn's file changes."
              }
              onClick={() => requestKeep({ scope: 'all' })}
            >
              <CheckIcon className="ico ico--xs" />
            </button>
          </>
        )}
        <button
          className="btn changes-review__review changes-review__icon-btn"
          type="button"
          aria-label="Review"
          title="Review this turn's files in the workbench changes editor."
          onClick={onOpenAllInEditor}
        >
          <DiffIcon className="ico ico--sm" />
        </button>
      </header>

      {expanded ? (
        <div id={`changes-review-files-${review.turnId}`}>
          {busy ? (
            <div className="changes-review__pending" role="status" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              <span>Applying edits to the workspace...</span>
              <span className="spacer" />
              <span className="changes-review__pending-note">Decisions stay disabled until the turn finishes.</span>
            </div>
          ) : null}

          {visibleDiffReview && visibleDiffReview.kind !== 'empty' ? <DiffReviewSection view={visibleDiffReview} /> : null}
          {visibleStylingReview && visibleStylingReview.kind !== 'empty' ? <DiffReviewSection view={visibleStylingReview} label="Styling check" /> : null}
          {rows.length > 0 ? <CheckRows rows={rows} /> : null}

          <ul className="changes-review__list" aria-label="Changed files">
            {visibleFiles.map((file) => (
              <ChangeRow
                key={file.path}
                file={file}
                outcome={outcomes.get(file.path)}
                locked={locked}
                keepBlocked={keepBlocked}
                busy={busy}
                onOpenFile={() => onOpenFile(file.absPath)}
                onOpenDiff={() => onOpenDiff(file.path)}
                onReveal={() => onRevealInSourceControl(file.absPath)}
                onKeep={() => requestKeep({ scope: 'file', path: file.path })}
                onReject={() => requestReject('file', [file.path])}
                onResolveConflict={(resolution) => onResolveConflict(file.path, resolution)}
              />
            ))}
          </ul>

          {visibleFileCount < review.files.length ? (
            <button
              className="changes-review__more btn"
              type="button"
              onClick={() => setVisibleFileCount((count) => Math.min(count + 24, review.files.length))}
            >
              Show {Math.min(24, review.files.length - visibleFileCount)} more files
            </button>
          ) : null}
          {visibleDiffReview || visibleStylingReview ? (
            <span className="changes-review__notices" role="group" aria-label="Review notices">
              {visibleDiffReview ? (
                <ReviewNotice label={visibleDiffReview.summary} message={[visibleDiffReview.heading, visibleDiffReview.detail].filter(Boolean).join('\n')} tone={visibleDiffReview.tone}>
                  <ShieldIcon className="ico ico--xs" />
                </ReviewNotice>
              ) : null}
              {visibleStylingReview ? (
                <ReviewNotice label={visibleStylingReview.summary} message={visibleStylingReview.heading} tone={visibleStylingReview.tone}>
                  <PencilIcon className="ico ico--xs" />
                </ReviewNotice>
              ) : null}
              <ReviewNotice label="About advisory reviews" message="Advisory only; it never keeps or rejects changes.">
                <InfoIcon className="ico ico--xs" />
              </ReviewNotice>
              {visibleStylingReview?.detail ? (
                <ReviewNotice label="Styling check details" message={visibleStylingReview.detail}>
                  <FileIcon className="ico ico--xs" />
                </ReviewNotice>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}

      {keepConfirm ? (
        <div
          className="changes-review__confirm changes-review__confirm--checks"
          role="alertdialog"
          aria-label="Confirm keeping despite failed checks"
        >
          <AlertIcon className="ico ico--xs" />
          <div className="changes-review__confirm-body">
            <span>
              {keepConfirm.scope === 'all'
                ? 'Keep all changes in this turn anyway? '
                : `Keep the change to ${keepConfirm.path} anyway? `}
              Checks failed
              {failedNames.length > 0 ? ` (${failedNames.join(', ')})` : ''}. The failed check will be bypassed.
            </span>
          </div>
          <span className="changes-review__confirm-actions">
            <button className="btn" type="button" onClick={() => setKeepConfirm(undefined)}>
              Cancel
            </button>
            <button className="btn btn--danger" type="button" onClick={confirmKeep}>
              {keepConfirm.scope === 'all' ? 'Keep all anyway' : 'Keep anyway'}
            </button>
          </span>
        </div>
      ) : null}

      {rejectConfirm ? (
        <div
          ref={confirmRef}
          className="changes-review__confirm"
          role="alertdialog"
          aria-modal="true"
          aria-label="Confirm rejecting changes"
          tabIndex={-1}
        >
          <AlertIcon className="ico ico--xs" />
          <div className="changes-review__confirm-body">
            <span>
              {rejectConfirm.scope === 'all'
                ? `Undo this turn's ${rejectPaths.length} file${rejectPaths.length === 1 ? '' : 's'}? The pre-turn content is written back. Restoring the chat to this message stays available.`
                : discardCopy(review, rejectPaths, 'prompt')}
            </span>
            {rejectPaths.length > 0 ? (
              <ul className="changes-review__confirm-paths">
                {rejectPaths.slice(0, 8).map((path) => (
                  <li key={path} title={path}>
                    {path}
                  </li>
                ))}
                {rejectPaths.length > 8 ? <li>and {rejectPaths.length - 8} more</li> : null}
              </ul>
            ) : null}
          </div>
          <span className="changes-review__confirm-actions">
            <button className="btn" type="button" onClick={onCancelReject}>
              Cancel
            </button>
            <button className="btn btn--danger" type="button" onClick={onConfirmReject}>
              {rejectConfirm.scope === 'all' ? 'Undo turn' : discardCopy(review, rejectPaths, 'confirm')}
            </button>
          </span>
        </div>
      ) : null}

    </section>
  );
}

function sameChangesReview(prev: ChangesReviewProps, next: ChangesReviewProps): boolean {
  return (
    prev.review === next.review &&
    prev.busy === next.busy &&
    prev.deciding === next.deciding &&
    prev.onFix === next.onFix &&
    prev.fixDisabled === next.fixDisabled &&
    prev.decisionResults === next.decisionResults &&
    prev.rejectConfirm === next.rejectConfirm
  );
}

/** Skip a re-render unless the snapshot the row shows actually changed. */
export const ChangesReview = memo(ChangesReviewView, sameChangesReview);

/**
 * The advisory second-pass review, shown above the file rows.
 *
 * It is informational only: the Keep/Reject controls below are unchanged, and a
 * failed pass is a non-blocking notice rather than a decision blocker. Severity
 * is a visible word plus an icon, never colour alone.
 */
function DiffReviewSection({
  view,
  label = 'Diff review'
}: {
  view: DiffReviewView;
  label?: string;
}): JSX.Element {
  const Icon = view.kind === 'failed' ? InfoIcon : view.kind === 'empty' ? CheckIcon : view.tone === 'info' ? InfoIcon : AlertIcon;
  return (
    <section
      className={`diff-review diff-review--${view.kind} diff-review--${view.tone}`}
      aria-label={label}
    >
      <div className="diff-review__head">
        <Icon className="ico ico--xs" />
        <span className="diff-review__title">{view.heading}</span>
      </div>
      {view.detail ? <p className="diff-review__detail">{view.detail}</p> : null}
      {view.findings.length > 0 ? (
        <ul className="diff-review__findings" aria-label={`${label} findings`}>
          {view.findings.map((finding, index) => (
            <li
              className={`diff-review__finding diff-review__finding--${finding.severity}`}
              key={`${finding.location}:${index}`}
            >
              <span className={`diff-review__severity diff-review__severity--${finding.severity}`}>
                {finding.severity === 'info' ? (
                  <InfoIcon className="ico ico--xs" />
                ) : finding.severity === 'error' ? (
                  <CrossIcon className="ico ico--xs" />
                ) : (
                  <AlertIcon className="ico ico--xs" />
                )}
                <span>{finding.severityLabel}</span>
              </span>
              <span className="diff-review__location" title={finding.location}>
                {finding.location}
              </span>
              <span className="diff-review__message">{finding.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** The post-turn check rows, one per check, each with a word for its state. */
function CheckRows({ rows }: { rows: CheckRowView[] }): JSX.Element {
  return (
    <div className="changes-review__checks" role="group" aria-label="Post-turn checks">
      <div className="changes-review__checks-head">Post-turn checks</div>
      <ul className="check-rows">
        {rows.map((row, index) => (
          <li
            key={`${row.name}-${index}`}
            className={`check-row check-row--${row.status}${row.failed ? ' check-row--failed' : ''}${
              row.status === 'running' ? ' check-row--running' : ''
            }`}
          >
            <span className="check-row__status">
              {row.status === 'running' ? <span className="spinner" aria-hidden="true" /> : null}
              {row.status === 'passed' ? <CheckIcon className="ico ico--xs" /> : row.failed ? <AlertIcon className="ico ico--xs" /> : row.status === 'skipped' ? <InfoIcon className="ico ico--xs" /> : null}
              <span className="check-row__status-word">{row.statusLabel}</span>
            </span>
            <span className="check-row__name" title={row.command ?? row.name}>
              {row.name}
            </span>
            {row.durationLabel ? <span className="check-row__duration">{row.durationLabel}</span> : null}
            {row.excerpt ? <pre className="check-row__detail">{row.excerpt}</pre> : null}
            {row.reason ? (
              <span className="check-row__reason">{row.failed ? `Reason: ${row.reason}` : row.reason}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One changed file, as a single compact full-width row. The diff opens in the editor. */
function ChangeRow({
  file,
  outcome,
  locked,
  keepBlocked,
  busy,
  onOpenFile,
  onOpenDiff,
  onReveal,
  onKeep,
  onReject,
  onResolveConflict
}: {
  file: ChangeFileView;
  outcome?: ChangeDecisionResult;
  locked: boolean;
  /** True only while checks run; Reject stays available in that state. */
  keepBlocked: boolean;
  busy: boolean;
  onOpenFile: () => void;
  onOpenDiff: () => void;
  onReveal: () => void;
  onKeep: () => void;
  onReject: () => void;
  onResolveConflict: (resolution: ConflictResolution) => void;
}): JSX.Element {
  const conflicted = outcome?.conflict === true && !outcome.ok;
  const failed = outcome !== undefined && !outcome.ok && !outcome.conflict;
  const reviewable = file.diffable;
  const decision = busy ? 'pending' : file.decision;

  return (
    <li className={`change-row${conflicted ? ' change-row--conflict' : ''}`}>
      <div className="change-row__line">
        <StatusMark file={file} />
        <PathLabel full={file.path} />
        <span className="diff-stats change-row__stats" aria-label={`${file.additions} added, ${file.deletions} removed`}>
          {file.additions > 0 ? <span className="add">+{file.additions}</span> : null}
          {file.deletions > 0 ? <span className="del">-{file.deletions}</span> : null}
        </span>
        <span className="change-row__decision">
          {reviewable ? <DecisionState decision={decision} conflicted={conflicted} failed={failed} /> : null}
        </span>
        <button
          className="btn btn--link change-row__icon-btn change-row__diff-btn"
          type="button"
          aria-label="Open diff"
          title="Open this file's pre-turn vs current diff in the workbench diff editor"
          onClick={onOpenDiff}
        >
          <DiffIcon className="ico ico--xs" />
        </button>
        <span className="change-row__actions">
          {!reviewable && file.status !== 'deleted' ? (
            <button
              className="btn btn--link change-row__icon-btn"
              type="button"
              title="Open this file in the editor"
              aria-label="Open this file in the editor"
              onClick={onOpenFile}
            >
              <FileIcon className="ico ico--xs" />
            </button>
          ) : null}
          {!reviewable ? (
            <button
              className="btn btn--link change-row__icon-btn"
              type="button"
              title="Reveal this file in Source Control"
              aria-label="Reveal this file in Source Control"
              onClick={onReveal}
            >
              <SearchIcon className="ico ico--xs" />
            </button>
          ) : null}
          {conflicted ? (
            <>
              <button
                className="btn btn--link change-row__icon-btn"
                type="button"
                disabled={locked}
                aria-label="Keep what is on disk"
                title="Keep what is on disk"
                onClick={() => onResolveConflict('keep-current')}
              >
                <CheckIcon className="ico ico--xs" />
              </button>
              <button
                className="btn btn--link change-row__icon-btn change-row__icon-btn--danger"
                type="button"
                disabled={locked}
                aria-label="Overwrite with pre-turn"
                title="Overwrite with the pre-turn snapshot"
                onClick={() => onResolveConflict('overwrite-pre-turn')}
              >
                <RestoreIcon className="ico ico--xs" />
              </button>
            </>
          ) : reviewable ? (
            <>
              {decision === 'accepted' ? null : (
                <button
                  className="btn btn--link change-row__icon-btn"
                  type="button"
                  disabled={locked || keepBlocked}
                  aria-label={`Keep changes to ${file.path}`}
                  title={keepBlocked ? 'Keep is disabled until the checks finish.' : 'Keep changes to this file.'}
                  onClick={onKeep}
                >
                  <CheckIcon className="ico ico--xs" />
                </button>
              )}
              {decision === 'accepted' ? null : (
                <button
                  className="btn btn--link change-row__icon-btn change-row__icon-btn--danger"
                  type="button"
                  aria-pressed={decision === 'rejected'}
                  disabled={locked || decision === 'rejected'}
                  aria-label={`${file.restorable === true ? 'Undo' : 'Reject'} changes to ${file.path}`}
                  title={
                    file.restorable === true
                      ? 'Restore this file to its pre-change snapshot.'
                      : 'Discard this unaccepted edit.'
                  }
                  onClick={onReject}
                >
                  {file.restorable === true ? (
                    <RestoreIcon className="ico ico--xs" />
                  ) : (
                    <CrossIcon className="ico ico--xs" />
                  )}
                </button>
              )}
            </>
          ) : null}
        </span>
      </div>
      {failed ? (
        <p className="change-row__note change-row__note--error" role="alert">
          <AlertIcon className="ico ico--xs" />
          <span>{outcome?.error ?? 'The decision could not be applied.'}</span>
        </p>
      ) : null}
    </li>
  );
}

/** Inline counts for the collapsed header. A zero category is omitted. */
function fileCountLabel(files: readonly ChangeFileView[]): string {
  const changed = files.filter((file) => file.status === 'modified' || file.status === 'renamed').length;
  const added = files.filter((file) => file.status === 'created').length;
  const deleted = files.filter((file) => file.status === 'deleted').length;
  const parts: string[] = [];
  if (changed > 0) {
    parts.push(`${changed} changed`);
  }
  if (added > 0) {
    parts.push(`${added} added`);
  }
  if (deleted > 0) {
    parts.push(`${deleted} deleted`);
  }
  return parts.join(' · ');
}

/**
 * The relative path, ellipsized from the start so the file name stays visible.
 * The LTR embedding keeps slash-separated segments in order inside an RTL box,
 * which is what places the ellipsis on the left.
 */
function PathLabel({ full }: { full: string }): JSX.Element {
  const visual = prettyPath(full);
  return (
    <span className="change-row__path" title={visual}>
      {`\u202A${visual}\u202C`}
    </span>
  );
}

/** Status as a fixed-width icon. The word stays available as the accessible name. */
function StatusMark({ file }: { file: ChangeFileView }): JSX.Element {
  const kind = !file.diffable
    ? file.binary
      ? 'binary'
      : 'large'
    : file.status === 'created'
      ? 'added'
      : file.status === 'deleted'
        ? 'deleted'
        : file.status === 'renamed'
          ? 'renamed'
          : 'modified';
  const label =
    kind === 'binary'
      ? 'Binary'
      : kind === 'large'
        ? 'Too large'
        : kind === 'added'
          ? 'Added'
          : kind === 'deleted'
            ? 'Deleted'
            : kind === 'renamed'
              ? 'Renamed'
              : 'Modified';
  const Icon =
    kind === 'added' ? PlusIcon : kind === 'deleted' ? TrashIcon : kind === 'renamed' ? RenameIcon : kind === 'modified' ? PencilIcon : InfoIcon;
  return (
    <span className={`change-row__mark change-row__mark--${kind}`} role="img" title={label} aria-label={label}>
      <Icon className="ico ico--xs" />
    </span>
  );
}

/**
 * The per-file discard word. A restorable file puts the pre-change snapshot
 * back. Without that snapshot the action only discards an unaccepted edit, so
 * the confirmation stays Reject.
 */
function discardCopy(review: ChangeView, paths: readonly string[], kind: 'prompt' | 'confirm'): string {
  const file = review.files.find((entry) => entry.path === paths[0]);
  const undo = file?.restorable === true;
  if (kind === 'confirm') {
    return undo ? 'Undo' : 'Reject file';
  }
  return undo
    ? 'Undo this file? The pre-change snapshot is written back to disk.'
    : 'Reject this file? The unaccepted edit is discarded.';
}

function DecisionState({
  decision,
  conflicted,
  failed
}: {
  decision: ChangeFileView['decision'];
  conflicted: boolean;
  failed: boolean;
}): JSX.Element {
  if (conflicted) {
    return (
      <span className="decision-state decision-state--conflict">
        <AlertIcon className="ico ico--xs" />
        Conflict: the file changed on disk. Choose explicitly.
      </span>
    );
  }
  if (failed) {
    return (
      <span className="decision-state decision-state--failed">
        <AlertIcon className="ico ico--xs" />
        Not applied
      </span>
    );
  }
  if (decision === 'accepted') {
    return (
      <span className="decision-state decision-state--kept">
        <CheckIcon className="ico ico--xs" />
        Kept
      </span>
    );
  }
  if (decision === 'rejected') {
    return (
      <span className="decision-state decision-state--rejected">
        <CrossIcon className="ico ico--xs" />
        Rejected
      </span>
    );
  }
  return (
    <span className="decision-state decision-state--pending">
      <PauseIcon className="ico ico--xs" />
      No decision yet
    </span>
  );
}

