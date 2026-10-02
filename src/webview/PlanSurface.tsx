import { useEffect, useRef, useState, type JSX } from 'react';
import type { PlanArtifact, TodoStep, TodoStepStatus } from '../backends/types';
import { Markdown } from './Markdown';
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  CrossIcon,
  FileIcon,
  InfoIcon,
  RefreshIcon
} from './Icons';

/**
 * The plan review surface and its todo list.
 *
 * One artifact, one card: the plan card (`PlanCard`) is the review surface while
 * a plan is pending; once it is built the same card collapses to a reference and
 * the todo list (`TodoList`) becomes the single step surface, so the two never
 * compete. Step status comes from the host-persisted plan, so a reload keeps
 * real progress; nothing here tracks steps of its own.
 */

export interface PlanSurfaceProps {
  plan: PlanArtifact;
  /** True while a revision is requested and its updated plan has not arrived. */
  revising: boolean;
  /** True while the destructive reject confirmation is shown. */
  rejectConfirmationOpen: boolean;
  /** True while a turn is running, so a partial list is not read as finished. */
  busy: boolean;
  /** Open the plan markdown file in the editor. */
  onOpenPlan: () => void;
  onBuild: () => void;
  onOpenReject: () => void;
  onCancelReject: () => void;
  onReject: () => void;
  /** Send a revision request attached to the plan card. */
  onRevise: (text: string) => void;
}

export function PlanSurface({
  plan,
  revising,
  rejectConfirmationOpen,
  busy,
  onOpenPlan,
  onBuild,
  onOpenReject,
  onCancelReject,
  onReject,
  onRevise
}: PlanSurfaceProps): JSX.Element {
  const built = plan.built === true;
  if (built) {
    return (
      <TodoList
        plan={plan}
        busy={busy}
        onOpenPlan={onOpenPlan}
        onRevise={onRevise}
      />
    );
  }
  return (
    <PlanCard
      plan={plan}
      revising={revising}
      rejectConfirmationOpen={rejectConfirmationOpen}
      onOpenPlan={onOpenPlan}
      onBuild={onBuild}
      onOpenReject={onOpenReject}
      onCancelReject={onCancelReject}
      onReject={onReject}
      onRevise={onRevise}
    />
  );
}

function PlanCard({
  plan,
  revising,
  rejectConfirmationOpen,
  onOpenPlan,
  onBuild,
  onOpenReject,
  onCancelReject,
  onReject,
  onRevise
}: {
  plan: PlanArtifact;
  revising: boolean;
  rejectConfirmationOpen: boolean;
  onOpenPlan: () => void;
  onBuild: () => void;
  onOpenReject: () => void;
  onCancelReject: () => void;
  onReject: () => void;
  onRevise: (text: string) => void;
}): JSX.Element {
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revision, setRevision] = useState('');
  const stepCount = plan.steps.length;

  const sendRevision = (): void => {
    const text = revision.trim();
    if (text.length === 0 || revising) {
      return;
    }
    setRevision('');
    setRevisionOpen(false);
    onRevise(text);
  };

  return (
    <section
      className={`plan-card${revising ? ' plan-card--revising' : ''}`}
      aria-label="Plan"
      aria-busy={revising}
    >
      <header className="plan-card__head">
        <span className="plan-card__title">{plan.title || 'Plan'}</span>
        <span className="chip chip--scope">
          {stepCount === 1 ? '1 step' : `${stepCount} steps`}
        </span>
        <span className="spacer" />
        {plan.path ? (
          <button className="plan-card__path" type="button" title="Open the rendered plan" onClick={onOpenPlan}>
            <FileIcon className="ico ico--xs" />
            <span className="plan-card__path-text">{plan.path}</span>
          </button>
        ) : null}
        <button
          className="btn btn--primary plan-card__build"
          type="button"
          disabled={revising || stepCount === 0}
          title={stepCount === 0 ? 'Build is disabled until the plan has at least one step.' : 'Build this plan in Agent mode'}
          onClick={onBuild}
        >
          Build
        </button>
      </header>

      {revising ? (
        <div className="plan-revising" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>Updating the plan from your request...</span>
        </div>
      ) : null}

      <div className="plan-doc" tabIndex={0} aria-label="Plan contents">
        {plan.body || plan.summary ? (
          <div className="plan-doc__summary">
            <Markdown text={plan.body || plan.summary || ''} />
          </div>
        ) : null}
        {plan.steps.length > 0 ? (
          <ol className="plan-steps">
            {plan.steps.map((step, index) => (
              <li key={`${index}-${step.text}`}>{step.text}</li>
            ))}
          </ol>
        ) : (
          <p className="plan-doc__empty">
            This plan has no steps yet. Ask for changes to add steps, or reject it and start over.
          </p>
        )}
      </div>

      {rejectConfirmationOpen ? (
        <div className="plan-confirm" role="alertdialog" aria-label="Confirm rejecting the plan">
          <AlertIcon className="ico ico--xs" />
          <span className="plan-confirm__msg">
            Reject this plan? The draft is discarded and the plan file is no longer active. This cannot be undone.
          </span>
          <span className="plan-confirm__actions">
            <button className="btn" type="button" onClick={onCancelReject}>
              Cancel
            </button>
            <button className="btn btn--danger" type="button" onClick={onReject}>
              Reject plan
            </button>
          </span>
        </div>
      ) : null}

      {revisionOpen ? (
        <div className="plan-revise">
          <label className="sr-only" htmlFor="plan-revision">
            Ask the model to update the plan
          </label>
          <textarea
            id="plan-revision"
            className="plan-revise__field"
            value={revision}
            rows={2}
            placeholder="Ask the model to update this plan"
            disabled={revising}
            onChange={(event) => setRevision(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendRevision();
              }
            }}
          />
          <div className="plan-revise__actions">
            <span className="plan-revise__note">The updated plan replaces this one in place.</span>
            <span className="spacer" />
            <button className="btn" type="button" onClick={() => setRevisionOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn--primary"
              type="button"
              disabled={revision.trim().length === 0 || revising}
              onClick={sendRevision}
            >
              Send revision
            </button>
          </div>
        </div>
      ) : null}

      <div className="plan-actions" aria-label="Plan actions">
        <button
          className="btn"
          type="button"
          disabled={revising}
          aria-expanded={revisionOpen}
          onClick={() => setRevisionOpen((open) => !open)}
        >
          Ask for changes
        </button>
        <button
          className="btn btn--danger"
          type="button"
          disabled={revising}
          aria-expanded={rejectConfirmationOpen}
          onClick={onOpenReject}
        >
          Reject
        </button>
        <span className="spacer" />
        <span className="plan-actions__note">
          {stepCount === 0
            ? 'Build is disabled until the plan has at least one step.'
            : 'Building changes files in this workspace.'}
        </span>
      </div>
    </section>
  );
}

/**
 * The todo list once the plan is built. The step list stays closed until the
 * user opens it from the Steps control, in the same anchored popup as mode
 * selection. Progress still comes from the persisted step status.
 */
function TodoList({
  plan,
  busy,
  onOpenPlan,
  onRevise
}: {
  plan: PlanArtifact;
  busy: boolean;
  onOpenPlan: () => void;
  onRevise: (text: string) => void;
}): JSX.Element {
  const [stepsOpen, setStepsOpen] = useState(false);
  const stepsRef = useRef<HTMLDivElement>(null);

  const total = plan.steps.length;
  const done = plan.steps.filter((step) => step.status === 'completed').length;
  const deniedCount = plan.steps.filter((step) => step.status === 'denied').length;
  const allDone = total > 0 && done === total;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  // The build is running only while a turn is in flight. Once no turn is
  // running and progress has been made but the list is not all done, this is the
  // honest partial state, whatever the cause (a denied step, an interruption, or
  // an early end): the list must never keep "Building" with a spinner once
  // nothing runs. A lingering `inProgress` status is treated as stopped here too,
  // so the surface never depends on an echo a reload could miss.
  const madeProgress = done > 0 || deniedCount > 0;
  const stopped = !allDone && !busy && madeProgress;

  const stateClass = allDone ? ' todo--finished' : stopped ? ' todo--stopped' : '';
  const title = allDone ? 'Plan complete' : stopped ? 'Build incomplete' : 'Building plan';

  const progressText = total > 0 ? `${done} of ${total} done` : 'No steps';

  useEffect(() => {
    if (!stepsOpen) {
      return;
    }
    const onPointer = (event: PointerEvent): void => {
      if (!stepsRef.current?.contains(event.target as Node)) {
        setStepsOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setStepsOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [stepsOpen]);

  return (
    <section className={`todo${stateClass}`} aria-label="Plan progress" aria-live="polite">
      <header className="todo__head">
        <span className="plan-card__title">{title}</span>
        <span className="spacer" />
        <span className="todo__progress-text">{progressText}</span>
      </header>
      <div
        className="todo__track"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Plan progress"
      >
        <span className="todo__fill" style={{ width: `${percent}%` }} />
      </div>

      <div className="plan-reference" ref={stepsRef}>
        <button
          className="control-trigger"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={stepsOpen}
          aria-controls="steps-menu"
          disabled={total === 0}
          onClick={() => setStepsOpen((value) => !value)}
        >
          <span className="control-label">Steps</span>
          <ChevronDownIcon className="control-chevron" />
        </button>
        {stepsOpen ? (
          <div className="steps-menu__panel" id="steps-menu" role="dialog" aria-label="Steps">
            <ul className="todo__list">
              {plan.steps.map((step, index) => (
                <TodoRow key={`${index}-${step.text}`} step={step} live={busy} />
              ))}
            </ul>
          </div>
        ) : null}
        <span className="spacer" />
        {plan.path ? (
          <button className="btn btn--link" type="button" onClick={onOpenPlan}>
            Open plan file
          </button>
        ) : null}
      </div>

      {allDone ? (
        <p className="todo__finished">
          <CheckIcon className="ico ico--xs" />
          <span>All steps finished.</span>
        </p>
      ) : stopped ? (
        <p className="todo__note todo__note--stopped" role="status">
          <AlertIcon className="ico ico--xs" />
          <span>
            {deniedCount > 0
              ? `${deniedCount} of ${total} steps ${deniedCount === 1 ? 'was' : 'were'} denied. ${done} of ${total} done, so this is not a completed plan. Steps already done stay applied.`
              : `${done} of ${total} steps done. The build did not finish, so this is not a completed plan. Steps already done stay applied.`}
          </span>
        </p>
      ) : null}
      {stopped ? (
        <p className="todo__retry">
          <button className="btn" type="button" onClick={() => onRevise('Continue the remaining steps of this plan.')}>
            <RefreshIcon />
            Resume remaining steps
          </button>
        </p>
      ) : null}
      {total === 0 ? (
        <p className="todo__note">
          <InfoIcon className="ico ico--xs" />
          <span>The plan has no steps to track.</span>
        </p>
      ) : null}
    </section>
  );
}

function TodoRow({ step, live }: { step: TodoStep; live: boolean }): JSX.Element {
  // A step only reads as running while the turn is actually running. A lingering
  // `inProgress` status from a stopped build is shown as not started, so the list
  // never claims a step is progressing when nothing is.
  const running = step.status === 'inProgress' && live;
  const statusClass =
    step.status === 'completed'
      ? ' todo__item--done'
      : step.status === 'denied'
        ? ' todo__item--denied'
        : running
          ? ' todo__item--active'
          : '';
  return (
    <li className={`todo__item${statusClass}`}>
      <span className="todo__mark" aria-hidden="true">
        {step.status === 'completed' ? (
          <CheckIcon className="ico ico--xs" />
        ) : step.status === 'denied' ? (
          <CrossIcon className="ico ico--xs" />
        ) : running ? (
          <span className="spinner" />
        ) : (
          <span className="todo__dot" />
        )}
      </span>
      <span className="todo__text">{step.text}</span>
      <span className="spacer" />
      <span
        className={
          'todo__status' +
          (step.status === 'completed' ? ' todo__status--done' : '') +
          (step.status === 'denied' ? ' todo__status--denied' : '')
        }
      >
        {statusLabel(step.status, running)}
      </span>
    </li>
  );
}

function statusLabel(status: TodoStepStatus, running: boolean): string {
  switch (status) {
    case 'completed':
      return 'Done';
    case 'inProgress':
      return running ? 'In progress' : 'Not started';
    case 'denied':
      return 'Denied';
    default:
      return 'Pending';
  }
}
