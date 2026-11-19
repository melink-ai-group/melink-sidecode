import type { JSX } from 'react';
import type { ApprovalRequest, FileChange } from '../../backends/types';
import { prettyPath } from '../prettyPath';
import { AlertIcon, CheckIcon, CrossIcon, StopIcon } from '../Icons';
import type { TranscriptEntry } from '../activityGroups';
import type { ItemStatus, TranscriptItemView } from '../state';

export function StatusChip({ status, doneLabel = 'Passed' }: { status: ItemStatus; doneLabel?: string }): JSX.Element {
  switch (status) {
    case 'streaming':
      return <StatusMark tone="running" label="Running" />;
    case 'completed':
      return <StatusMark tone="done" label={doneLabel} icon={<CheckIcon />} />;
    case 'failed':
      return <StatusMark tone="failed" label="Failed" icon={<CrossIcon />} />;
    case 'warning':
      return <StatusMark tone="warning" label="Check" icon={<AlertIcon />} />;
    case 'canceled':
      return <StatusMark label="Stopped" icon={<StopIcon />} />;
    default:
      return <span className="status-slot" aria-hidden="true" />;
  }
}

/** Icon-only status. The word stays in the tooltip and the accessible name. */
export function StatusMark({
  label,
  tone,
  icon
}: {
  label: string;
  tone?: 'running' | 'done' | 'failed' | 'warning';
  icon?: JSX.Element;
}): JSX.Element {
  const toneClass = tone ? ` status-chip--${tone}` : '';
  return (
    <span
      className={`status-chip status-chip--icon${toneClass}`}
      title={label}
      role={tone === 'running' ? 'status' : 'img'}
      aria-label={label}
    >
      {tone === 'running' ? <span className="spinner" aria-hidden="true" /> : icon}
    </span>
  );
}

/** A short, honest label for what a settled approval concerned. */
export function describeApprovalSubject(request: ApprovalRequest): string {
  switch (request.kind) {
    case 'command': {
      const command = request.displayCommand ?? request.command;
      return command ? prettyPath(command) : 'a command';
    }
    case 'file-change': {
      const paths = request.paths ?? [];
      if (paths.length === 0) {
        return 'file changes';
      }
      if (paths.length === 1) {
        return prettyPath(paths[0]);
      }
      return `${prettyPath(paths[0])} +${paths.length - 1} more`;
    }
    case 'permissions':
      return request.network ? `network access to ${request.network}` : 'extra permissions';
    default:
      return '';
  }
}

export function filePathLabel(files: FileChange[]): string {
  if (files.length === 0) {
    return '';
  }
  if (files.length === 1) {
    return prettyPath(files[0].path);
  }
  return `${prettyPath(files[0].path)} +${files.length - 1} more`;
}

/** Title and optional path, each one line. The tooltip is the full visual text. */
export function CardLines({ title, detail }: { title: string; detail?: string }): JSX.Element {
  const heading = prettyPath(title);
  const sub = detail ? prettyPath(detail) : '';
  return (
    <span className="item-main">
      <span className="item-kind" title={heading}>
        {heading}
      </span>
      {sub ? (
        <span className="item-path" title={sub}>
          {sub}
        </span>
      ) : null}
    </span>
  );
}

export function totals(files: FileChange[]): { additions: number; deletions: number } | undefined {
  if (files.length === 0) {
    return undefined;
  }
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  if (additions === 0 && deletions === 0) {
    return undefined;
  }
  return { additions, deletions };
}

export function diffStatsLabel(files: FileChange[]): string {
  const sum = totals(files);
  return sum ? `${sum.additions} additions, ${sum.deletions} deletions` : '';
}

export function copyText(text: string): void {
  void navigator.clipboard?.writeText(text);
}

export function entryContains(entry: TranscriptEntry, itemId: string): boolean {
  if (entry.kind === 'item') {
    return entry.item.id === itemId;
  }
  return (entry.kind === 'narration' && entry.message.id === itemId) || entry.items.some((item) => item.id === itemId);
}

export function sameItems(left: readonly TranscriptItemView[], right: readonly TranscriptItemView[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
