import type { JSX } from 'react';
import { applyViewExclusions, type ContextView } from '../protocol';
import { canCompactContext, contextUsagePercent } from '../backends/contextUsage';
import { AlertIcon, CircleMinusIcon, CirclePlusIcon, ContextIcon, FileIcon } from './Icons';

/**
 * The strip directly above the composer.
 *
 * It names the workspace and the file open in the editor. It does not list
 * project-context references. The context ring is drawn beside the composer
 * actions. While the agent is idle and the window is above 25% full, that ring
 * compacts the thread.
 */

export interface ContextStripProps {
  view?: ContextView;
  settingsEnabled: boolean;
  exclusions: string[];
  /** Open the active file (or a context file) in the editor. */
  onOpenFile: (path: string) => void;
  /** Whether the file open in the editor is included on the next turn. */
  includeViewedFile: boolean;
  /** Add or remove that file. Off until the user asks. */
  onSetIncludeViewedFile: (included: boolean) => void;
  plan?: ContextFileProps;
}

interface ContextFileProps {
  path: string;
  included: boolean;
  blocked?: boolean;
  onOpen: () => void;
  onSetIncluded: (included: boolean) => void;
}

function ContextFile({ path, included, blocked, onOpen, onSetIncluded }: ContextFileProps): JSX.Element {
  const action = included ? 'Remove ' + path + ' from context' : 'Add ' + path + ' to context';
  return (
    <span className={included ? 'context-file is-on' : 'context-file is-ghost'}>
      <button className="context-path" type="button" title={'Open ' + path + ' in the editor'} onClick={onOpen}>
        <FileIcon className="ico ico--xs" />
        <span className="context-path-text">{path}</span>
      </button>
      <button
        className="context-file-toggle"
        type="button"
        aria-pressed={included}
        aria-label={action}
        title={blocked ? 'This file cannot be added to the next turn' : action}
        disabled={blocked}
        onClick={() => onSetIncluded(!included)}
      >
        {included ? <CircleMinusIcon /> : <CirclePlusIcon />}
      </button>
    </span>
  );
}

export function ContextStrip({
  view,
  settingsEnabled,
  exclusions,
  onOpenFile,
  includeViewedFile,
  onSetIncludeViewedFile,
  plan
}: ContextStripProps): JSX.Element | null {
  if (!view && !plan) {
    return null;
  }

  const effective = view && applyViewExclusions(view, exclusions);
  const status = settingsEnabled ? effective?.status : 'empty';
  const included = includeViewedFile && !effective?.viewedFileBlocked;
  const sameIncludedPlan = plan?.included && effective?.viewedFile?.replace(/\\/g, '/') === plan.path;

  const selectionLabel =
    effective && effective.selectionLines > 0
      ? `${effective.selectionLines} line${effective.selectionLines === 1 ? '' : 's'} selected`
      : undefined;

  return (
    <div className="ctx-region">
      <div className={`context-strip is-${status}`} aria-label="Project context for the next turn">
        {effective ? <span className="context-workspace">{effective.workspaceName ?? 'Workspace'}</span> : null}

        {effective?.viewedFile && status !== 'empty' && !sameIncludedPlan ? (
          <>
            <span className="context-sep" aria-hidden="true">
              ·
            </span>
            <ContextFile
              path={effective.viewedFile}
              included={included}
              blocked={effective.viewedFileBlocked}
              onOpen={() => onOpenFile(effective.viewedFilePath ?? '')}
              onSetIncluded={onSetIncludeViewedFile}
            />
          </>
        ) : null}

        {selectionLabel ? <span className="context-selection">{selectionLabel}</span> : null}
        {plan ? <ContextFile {...plan} /> : null}

        {status === 'building' ? (
          <span className="context-status" role="status">
            <span className="spinner" aria-hidden="true" />
            Building context…
          </span>
        ) : null}

        {status === 'empty' ? (
          <span className="context-status">
            <ContextIcon className="ico ico--xs" />
            {settingsEnabled ? 'No folder open' : 'Context off'}
          </span>
        ) : null}

        {status === 'failed' ? (
          <span className="context-status context-status--error">
            <AlertIcon className="ico ico--xs" />
            Could not build context
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A ring filled by the share of the context window in use.
 *
 * The fill is the percent. The ring is a button only while the agent is idle
 * and that percent is above 25, which is when compaction runs.
 */
export function ContextMeter({
  usedTokens,
  maxTokens,
  busy,
  onCompact
}: {
  usedTokens: number;
  maxTokens?: number;
  busy: boolean;
  onCompact: () => void;
}): JSX.Element | null {
  const percent = contextUsagePercent(usedTokens, maxTokens);
  if (percent === undefined) {
    return null;
  }
  const compactable = canCompactContext(percent, busy);
  const level = percent >= 85 ? 'high' : percent >= 60 ? 'warn' : 'ok';
  const label = `${percent}% of the context window is in use`;
  const ring = (
    <>
      <svg className="context-meter__ring" viewBox="0 0 36 36" aria-hidden="true">
        <circle className="context-meter__track" cx="18" cy="18" r="15" pathLength={100} />
        <circle
          className="context-meter__value"
          cx="18"
          cy="18"
          r="15"
          pathLength={100}
          strokeDasharray={`${percent} ${100 - percent}`}
        />
      </svg>
    </>
  );

  if (compactable) {
    return (
      <button
        className={`context-meter is-${level}`}
        type="button"
        aria-label={`Compact context. ${label}`}
        title="Compact context"
        onClick={onCompact}
      >
        {ring}
      </button>
    );
  }

  return (
    <span
      className={`context-meter is-${level}${busy ? ' is-busy' : ''}`}
      role="img"
      aria-label={label}
      title={label}
    >
      {ring}
    </span>
  );
}
