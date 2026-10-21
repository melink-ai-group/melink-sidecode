import { useEffect, useRef, type JSX } from 'react';
import type { ApprovalDecision } from '../../backends/types';
import { prettyPath } from '../prettyPath';
import { CheckIcon, InfoIcon, ShieldIcon } from '../Icons';
import { decisionLabel, decisionMessage, decisionScope, requestMessage } from '../state';
import type { TranscriptItemView } from '../state';
import { describeApprovalSubject, diffStatsLabel } from './shared';

/**
 * A pending approval, rendered inline in the transcript flow (never a floating
 * dialog) so the user keeps the surrounding context. It shows what is actually
 * asked: the command and/or the affected files with a compact diff summary,
 * never a raw protocol payload. `allow once` is the single primary action and
 * `always` is never focused by default.
 */
export function ApprovalPrompt({
  item,
  onDecide
}: {
  item: TranscriptItemView;
  onDecide: (decision: ApprovalDecision) => void;
}): JSX.Element {
  const request = item.approval;
  const promptRef = useRef<HTMLElement>(null);

  // Focus lands on the prompt when it appears, so the decision is reachable by
  // keyboard at once. The primary action keeps focus; `always` is never focused.
  useEffect(() => {
    promptRef.current?.focus();
  }, []);

  const files = request?.kind === 'file-change' ? item.files ?? [] : [];
  const paths =
    request?.kind === 'file-change' && files.length === 0 ? request.paths ?? [] : [];
  const reason = request?.reason;

  return (
    <section
      className="prompt prompt--pending"
      ref={promptRef}
      role="group"
      aria-label="Approval needed"
      tabIndex={-1}
    >
      <header className="prompt-head">
        <span className="prompt-head__icon" aria-hidden="true">
          <ShieldIcon />
        </span>
        <span className="prompt-title">Approval needed</span>
        <span className="spacer" />
        <span className="chip chip--waiting">Waiting on you</span>
      </header>
      <div className="prompt-body">
        <p className="ask">{item.text || (request ? requestMessage(request) : 'The agent is asking for a decision.')}</p>

        {request?.command ? (
          <pre className="codeblock" aria-label="Command the agent wants to run">
            {request.command}
          </pre>
        ) : null}

        {files.length > 0 ? (
          <div className="affected">
            <p className="affected-label">Changes it would touch</p>
            {files.map((file) => (
              <div className="file-row" key={file.path}>
                <span className="file-name" title={prettyPath(file.path)}>
                  {prettyPath(file.path)}
                </span>
                <span className="diffstat" aria-label={diffStatsLabel([file])}>
                  <span className="add">+{file.additions ?? 0}</span>
                  <span className="del">-{file.deletions ?? 0}</span>
                </span>
              </div>
            ))}
          </div>
        ) : paths.length > 0 ? (
          <div className="affected">
            <p className="affected-label">Files it would touch</p>
            {paths.map((path) => (
              <div className="file-row" key={path}>
                <span className="file-name" title={prettyPath(path)}>
                  {prettyPath(path)}
                </span>
              </div>
            ))}
          </div>
        ) : request?.kind === 'permissions' && request.network ? (
          <div className="file-row">
            <span className="file-name">{request.network}</span>
          </div>
        ) : null}

        {reason ? <p className="prompt-reason">{reason}</p> : null}

        <div className="decisions" role="group" aria-label="Decide on this request">
          <button className="decision decision--primary" type="button" onClick={() => onDecide('allow-once')}>
            Allow once
          </button>
          <button className="decision" type="button" onClick={() => onDecide('allow-always')}>
            Always allow
          </button>
          <button className="decision" type="button" onClick={() => onDecide('allow-session')}>
            Allow for this session
          </button>
          <button className="decision decision--reject" type="button" onClick={() => onDecide('reject')}>
            Reject
          </button>
        </div>

        <p className="scope-note">
          <InfoIcon className="ico ico--xs" />
          <span>
            “Always allow” saves a lasting rule for this request that outlives this task. The other choices
            last one run or one session.
          </span>
        </p>
      </div>
    </section>
  );
}

/**
 * A settled approval, collapsed to a compact marker naming the decision and the
 * scope it applied at. A denial is informational, not an error. An `always`
 * marker carries the one-click route to review and revoke the stored rules.
 */
export function ApprovalResolvedCard({
  item,
  approved,
  onOpenRules
}: {
  item: TranscriptItemView;
  approved?: boolean;
  onOpenRules: () => void;
}): JSX.Element {
  const decision = item.approvalDecision;
  const isReject = approved === false || decision === 'reject';
  const label = decision ? decisionLabel(decision) : approved ? 'Approved' : 'Rejected';
  const scope = decision ? decisionScope(decision) : '';
  const subject = item.approval ? describeApprovalSubject(item.approval) : '';
  const variant = isReject ? 'reject' : decision === 'allow-always' ? 'always' : decision === 'allow-session' ? 'session' : 'allow';

  return (
    <div className={`marker marker--${variant}`} role="note">
      <span className="marker-icon" aria-hidden="true">
        {isReject ? <InfoIcon className="ico ico--sm" /> : <CheckIcon className="ico ico--sm" />}
      </span>
      <div className="marker-body">
        <p className="marker-title">
          {label}
          {subject ? (
            <>
              {' - '}
              <span className="marker-subject">{subject}</span>
            </>
          ) : null}
        </p>
        <p className="marker-sub">
          {isReject
            ? 'The agent was told and can continue differently. Nothing was changed.'
            : scope || item.text || decisionMessage(decision ?? 'allow-once')}
        </p>
        {decision === 'allow-always' ? (
          <p className="marker-actions">
            <button className="btn btn--link" type="button" onClick={onOpenRules}>
              Review and remove rules
            </button>
          </p>
        ) : null}
      </div>
    </div>
  );
}
