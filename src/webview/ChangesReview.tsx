import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type {
  ChangeDecisionResult,
  ChangeFileView,
  ChangeView,
  CheckpointView,
  ConflictResolution
} from '../protocol';
import {
  AlertIcon,
  CheckIcon,
  ChevronRightIcon,
  CrossIcon,
  DiffIcon,
  InfoIcon,
  PencilIcon,
  PlusIcon,
  PauseIcon,
  RenameIcon,
  RestoreIcon,
  TrashIcon
} from './Icons';

/**
 * The change review surface: what a turn changed, with per-file keep/reject.
 *
 * A full-width inline panel inside the view, never a floating popover (the
 * switcher invariant). It renders one row per recorded file, the diff of an
 * expanded row, and a footer whose single primary action is `Keep all`.
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
  /** The most recent decision outcomes, so a conflict or failure is surfaced. */
  decisionResults?: ChangeDecisionResult[];
  /** The destructive reject awaiting an explicit confirmation, if any. */
  rejectConfirm?: { scope: 'file' | 'all'; paths: string[] };
  /** The checkpoint this turn opened, when one exists, for the restore entry. */
  checkpoint?: CheckpointView;
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
  onKeep: (path: string) => void;
  /** Open the destructive reject confirmation for one file or the whole turn. */
  onRequestReject: (scope: 'file' | 'all', paths: string[]) => void;
  onCancelReject: () => void;
  /** Confirm the pending reject; the host decides the scope from the request. */
  onConfirmReject: () => void;
  onKeepAll: () => void;
  /** Resolve a conflict with an explicit choice; nothing overwrites silently. */
  onResolveConflict: (path: string, resolution: ConflictResolution) => void;
  /** Open the existing checkpoint restore confirmation for this turn. */
  onRestoreCheckpoint: (checkpoint: CheckpointView) => void;
}

export function ChangesReview({
  review,
  busy,
  deciding,
  decisionResults,
  rejectConfirm,
  checkpoint,
  onOpenFile,
  onOpenDiff,
  onOpenAllInEditor,
  onRevealInSourceControl,
  onKeep,
  onRequestReject,
  onCancelReject,
  onConfirmReject,
  onKeepAll,
  onResolveConflict,
  onRestoreCheckpoint
}: ChangesReviewProps): JSX.Element {
  const [visibleFileCount, setVisibleFileCount] = useState(24);
  const [openPaths, setOpenPaths] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * Outcomes accumulate across decision rounds. A single `changes/decisionResult`
   * carries only the files that just resolved, so replacing the map would erase a
   * still-unresolved conflict when an unrelated file is decided. Reset when the
   * turn (and therefore its review) changes.
   */
  const [outcomeMemory, setOutcomeMemory] = useState<Map<string, ChangeDecisionResult>>(() => new Map());
  const outcomeTurnRef = useRef<string | undefined>(undefined);
  const panelRef = useRef<HTMLElement>(null);
  const focusedTurnRef = useRef<string | undefined>(undefined);

  // Focus lands on the panel when it first opens, matching the approval-prompt
  // precedent. A repaint of the same turn does not steal focus back.
  useEffect(() => {
    setVisibleFileCount(24);
  }, [review.turnId]);

  useEffect(() => {
    if (focusedTurnRef.current === review.turnId) {
      return;
    }
    focusedTurnRef.current = review.turnId;
    panelRef.current?.focus();
  }, [review.turnId]);

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

  const reviewableCount = review.files.reduce((count, file) => count + Number(file.diffable), 0);
  const nonReviewableCount = review.files.length - reviewableCount;
  const undecided = review.files.reduce((count, file) => count + Number(file.decision === 'pending'), 0);
  const visibleFiles = review.files.slice(0, visibleFileCount);
  const summaryParts = [
    review.additions > 0 || review.deletions > 0 ? (
      <span className="diff-stats" aria-label="Total changes" key="diff-stats">
        {review.additions > 0 ? <span className="add">+{review.additions}</span> : null}
        {review.deletions > 0 ? <span className="del">-{review.deletions}</span> : null}
      </span>
    ) : null,
    reviewableCount > 0 ? <span key="reviewable">{reviewableCount} to review</span> : null,
    nonReviewableCount > 0 ? <span key="non-reviewable">{nonReviewableCount} not reviewable</span> : null,
    undecided > 0 ? <span key="undecided">{undecided} undecided</span> : null
  ].filter((part): part is JSX.Element => part !== null);

  const togglePath = (path: string): void => {
    setOpenPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const locked = busy || deciding;

  const rejectPaths =
    rejectConfirm?.scope === 'all'
      ? review.files.map((file) => file.path)
      : rejectConfirm?.paths ?? [];

  return (
    <section
      className="changes-review"
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby="changes-review-title"
      aria-busy={busy}
    >
      <header className="changes-review__head">
        <span className="changes-review__title" id="changes-review-title">
          Files changed
        </span>
        {!busy ? (
          <span className="chip chip--scope">
            {review.files.length === 1 ? '1 file' : `${review.files.length} files`}
          </span>
        ) : (
          <span className="chip chip--scope">Running</span>
        )}
        <span className="spacer" />
        <button
          className="btn btn--primary"
          type="button"
          disabled={locked || review.files.length === 0}
          title="Keep all changes from this turn."
          onClick={onKeepAll}
        >
          <CheckIcon className="ico ico--xs" />
          <span>Keep</span>
        </button>
        <button
          className="btn"
          type="button"
          title="Review every changed file in the workbench changes editor."
          onClick={onOpenAllInEditor}
        >
          <DiffIcon className="ico ico--sm" />
          <span>Review</span>
        </button>
        {checkpoint ? (
          <button
            className="btn btn--link"
            type="button"
            title={`Undo this turn by restoring ${checkpoint.fileCount} file${checkpoint.fileCount === 1 ? '' : 's'} to their pre-turn content. The conversation stays.`}
            onClick={() => onRestoreCheckpoint(checkpoint)}
          >
            <RestoreIcon className="ico ico--sm" />
            <span>Undo</span>
          </button>
        ) : null}
      </header>

      {busy ? (
        <div className="changes-review__pending" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <span>Applying edits to the workspace...</span>
          <span className="spacer" />
          <span className="changes-review__pending-note">Decisions stay disabled until the turn finishes.</span>
        </div>
      ) : summaryParts.length > 0 ? (
        <div className="changes-review__summary">
          {summaryParts.map((part, index) => (
            <span className="changes-review__summary-part" key={part.key ?? index}>
              {index > 0 ? <span className="changes-review__sep" aria-hidden="true">&middot;</span> : null}
              {part}
            </span>
          ))}
        </div>
      ) : null}

      <ul className="changes-review__list" aria-label="Changed files">
        {visibleFiles.map((file) => (
          <ChangeRow
            key={file.path}
            file={file}
            outcome={outcomes.get(file.path)}
            open={openPaths.has(file.path)}
            locked={locked}
            busy={busy}
            onToggle={() => togglePath(file.path)}
            onOpenFile={() => onOpenFile(file.absPath)}
            onOpenDiff={() => onOpenDiff(file.path)}
            onReveal={() => onRevealInSourceControl(file.absPath)}
            onKeep={() => onKeep(file.path)}
            onReject={() => onRequestReject('file', [file.path])}
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

      {rejectConfirm ? (
        <div className="changes-review__confirm" role="alertdialog" aria-label="Confirm rejecting changes">
          <AlertIcon className="ico ico--xs" />
          <div className="changes-review__confirm-body">
            <span>
              {rejectConfirm.scope === 'all'
                ? `Reject all ${rejectPaths.length} file${rejectPaths.length === 1 ? '' : 's'}? The pre-turn content is written back to disk.`
                : 'Reject this file? The pre-turn content is written back to disk.'}
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
              {rejectConfirm.scope === 'all'
                ? `Reject ${rejectPaths.length} file${rejectPaths.length === 1 ? '' : 's'}`
                : 'Reject file'}
            </button>
          </span>
        </div>
      ) : null}

    </section>
  );
}

/** One changed file: path, status, counts, decision state, and its diff. */
function ChangeRow({
  file,
  outcome,
  open,
  locked,
  busy,
  onToggle,
  onOpenFile,
  onOpenDiff,
  onReveal,
  onKeep,
  onReject,
  onResolveConflict
}: {
  file: ChangeFileView;
  outcome?: ChangeDecisionResult;
  open: boolean;
  locked: boolean;
  busy: boolean;
  onToggle: () => void;
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
  const { dir, base } = splitPath(file.path);
  const diffId = `change-diff-${stableId(file.path)}`;

  const decision = busy ? 'pending' : file.decision;

  return (
    <li className={`change-row${open ? ' change-row--open' : ''}${conflicted ? ' change-row--conflict' : ''}`}>
      <div className="change-row__head">
        {reviewable ? (
          <button
            className="change-row__toggle"
            type="button"
            aria-expanded={open}
            aria-controls={open ? diffId : undefined}
            aria-label={`${open ? 'Collapse' : 'Expand'} diff for ${file.path}`}
            onClick={onToggle}
          >
            <ChevronRightIcon className="ico ico--xs change-row__chevron" />
            <PathLabel dir={dir} base={base} full={file.path} />
          </button>
        ) : (
          <span className="change-row__toggle change-row__toggle--static">
            <span className="change-row__chevron-spacer" aria-hidden="true" />
            <PathLabel dir={dir} base={base} full={file.path} />
          </span>
        )}
        <span className="change-row__tags">
          <StatusChip file={file} />
          <span className="diff-stats" aria-label={`${file.additions} added, ${file.deletions} removed`}>
            {file.additions > 0 ? <span className="add">+{file.additions}</span> : null}
            {file.deletions > 0 ? <span className="del">-{file.deletions}</span> : null}
          </span>
        </span>
      </div>

      {!reviewable ? (
        <p className="change-row__note">
          <InfoIcon className="ico ico--xs" />
          <span>{file.detail ?? 'No inline diff is available for this file.'}</span>
          <button
            className="btn btn--link"
            type="button"
            title="Open the pre-turn content and the current file in the workbench diff editor"
            onClick={onOpenDiff}
          >
            Open diff
          </button>
          {file.status !== 'deleted' ? (
            <button
              className="btn btn--link"
              type="button"
              title="Open this file in the editor"
              onClick={onOpenFile}
            >
              Open in editor
            </button>
          ) : null}
          <button
            className="btn btn--link"
            type="button"
            title="Reveal this file in Source Control"
            onClick={onReveal}
          >
            Reveal
          </button>
        </p>
      ) : (
        <div className="change-row__bar">
          <DecisionState decision={decision} conflicted={conflicted} failed={failed} />
          <button
            className="btn btn--link"
            type="button"
            title="Open this file's pre-turn vs current diff in the workbench diff editor"
            onClick={onOpenDiff}
          >
            Open diff
          </button>
          <span className="spacer" />
          {conflicted ? (
            <>
              <button className="btn" type="button" disabled={locked} onClick={() => onResolveConflict('keep-current')}>
                Keep what is on disk
              </button>
              <button
                className="btn btn--danger"
                type="button"
                disabled={locked}
                onClick={() => onResolveConflict('overwrite-pre-turn')}
              >
                Overwrite with pre-turn
              </button>
            </>
          ) : (
            <>
              <button
                className="btn"
                type="button"
                aria-pressed={decision === 'accepted'}
                disabled={locked || decision === 'accepted'}
                aria-label={`Keep changes to ${file.path}`}
                onClick={onKeep}
              >
                Keep
              </button>
              <button
                className="btn btn--danger"
                type="button"
                aria-pressed={decision === 'rejected'}
                disabled={locked || decision === 'rejected'}
                aria-label={`Reject changes to ${file.path}`}
                onClick={onReject}
              >
                Reject
              </button>
            </>
          )}
        </div>
      )}

      {failed ? (
        <p className="change-row__note change-row__note--error" role="alert">
          <AlertIcon className="ico ico--xs" />
          <span>{outcome?.error ?? 'The decision could not be applied.'}</span>
        </p>
      ) : null}

      {reviewable && open ? (
        <div className="change-row__diff" id={diffId} tabIndex={0} role="group" aria-label={`Diff for ${file.path}`}>
          {file.hunks.map((hunk) => (
            <section className="change-hunk" key={hunk.id}>
              <span className="change-hunk__head">{hunk.header}</span>
              {hunk.lines.map((line, index) => (
                <div className={`diff-line diff-line--${line.kind === 'add' ? 'add' : line.kind === 'del' ? 'del' : 'ctx'}`} key={`${index}-${line.kind}`}>
                  <span className="sign" aria-hidden="true">
                    {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                  </span>
                  <span>
                    {line.text}
                    {line.noNewline ? <span className="change-hunk__no-newline">{'\\ No newline at end of file'}</span> : null}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      ) : null}
    </li>
  );
}

/** The relative path, middle-ellipsized: the directory truncates, the name holds. */
function PathLabel({ dir, base, full }: { dir: string; base: string; full: string }): JSX.Element {
  return (
    <span className="change-row__path" title={full}>
      {dir ? <span className="change-row__path-dir">{dir}</span> : null}
      <span className="change-row__path-base">{base}</span>
    </span>
  );
}

function StatusChip({ file }: { file: ChangeFileView }): JSX.Element {
  if (!file.diffable) {
    return (
      <span className="status-chip status-chip--muted">
        {file.binary ? 'Binary' : 'Too large'}
      </span>
    );
  }
  const label =
    file.status === 'created'
      ? 'Created'
      : file.status === 'deleted'
        ? 'Deleted'
        : file.status === 'renamed'
          ? 'Renamed'
          : 'Modified';
  const Icon = file.status === 'created' ? PlusIcon : file.status === 'deleted' ? TrashIcon : file.status === 'renamed' ? RenameIcon : PencilIcon;
  return (
    <span className="status-chip">
      <Icon className="ico ico--xs" />
      {label}
    </span>
  );
}

/** Decision state as text plus an icon: legible with colour removed. */
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

/** Split a POSIX-relative path into its directory and file name. */
function splitPath(path: string): { dir: string; base: string } {
  const index = path.lastIndexOf('/');
  if (index === -1) {
    return { dir: '', base: path };
  }
  return { dir: path.slice(0, index + 1), base: path.slice(index + 1) };
}

/** A DOM-id-safe, stable token for a path. */
function stableId(path: string): string {
  return path.replace(/[^a-zA-Z0-9_-]/g, '_');
}
