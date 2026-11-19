import type { JSX } from 'react';
import type { AgentActivity } from '../../backends/types';
import { AlertIcon, CheckIcon, StopIcon } from '../Icons';
import type { TranscriptItemView } from '../state';
import { StatusMark } from './shared';

const STATUS_LABELS: Record<AgentActivity['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  unavailable: 'Unavailable'
};

export function PostTurnChecks({ items }: { items: TranscriptItemView[] }): JSX.Element {
  const failed = items.filter((item) => item.agentActivity?.status === 'failed').length;
  const running = items.filter((item) => item.agentActivity?.status === 'running' || item.agentActivity?.status === 'queued').length;
  const cancelled = items.filter((item) => item.agentActivity?.status === 'cancelled').length;
  const status = [failed && `${failed} failed`, running && `${running} running`, cancelled && `${cancelled} cancelled`]
    .filter(Boolean).join(' · ');

  return (
    <details className="agent-activity post-turn-checks">
      <summary>
        <span className="agent-activity__role">Post-turn checks ({items.length})</span>
        {status ? <span className="agent-activity__status" aria-live="polite">{status}</span> : null}
      </summary>
      <div className="activity-group__items">
        {items.map(({ id, agentActivity }) => agentActivity ? <AgentActivityCard key={id} activity={agentActivity} /> : null)}
      </div>
    </details>
  );
}

/**
 * A native disclosure keeps each worker compact and keyboard reachable.
 *
 * An advisory pass that could not run carries no assessment, so its row is
 * hidden rather than reported as a failure.
 */
export function AgentActivityCard({ activity }: { activity: AgentActivity }): JSX.Element | null {
  if (activity.status === 'unavailable') {
    return null;
  }
  const label = STATUS_LABELS[activity.status];
  const tone = activity.status === 'running' ? 'running'
    : activity.status === 'completed' ? 'done'
      : activity.status === 'failed' ? 'failed' : undefined;
  const icon = activity.status === 'completed' ? <CheckIcon />
    : activity.status === 'failed' ? <AlertIcon />
      : activity.status === 'cancelled' ? <StopIcon /> : undefined;
  return (
    <details className="agent-activity">
      <summary aria-label={`${activity.role}: ${label}`}>
        <span className="agent-activity__role">{activity.role}</span>
        <span className="agent-activity__reason" title={activity.reason}>{activity.reason}</span>
        <span className="agent-activity__status" aria-live="polite" aria-atomic="true">
          <StatusMark label={label} tone={tone} icon={icon} />
          <span>{label}</span>
        </span>
      </summary>
      <div className="agent-activity__body">
        <p>{activity.reason}</p>
        {activity.detail ? <p>{activity.detail}</p> : null}
        {activity.findings?.length ? (
          <ul>{activity.findings.map((finding, index) => <li key={`${index}:${finding}`}>{finding}</li>)}</ul>
        ) : activity.status === 'completed' && activity.findings ? <p>No findings.</p> : null}
        {activity.status === 'failed' && !activity.detail ? <p>The worker could not complete.</p> : null}
        {activity.status === 'cancelled' && !activity.detail ? <p>The worker was cancelled.</p> : null}
      </div>
    </details>
  );
}
