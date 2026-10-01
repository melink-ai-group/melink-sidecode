import type { JSX } from 'react';
import { applyViewExclusions, type ContextView } from '../protocol';
import { canCompactContext, contextUsagePercent } from '../backends/contextUsage';
import { AlertIcon, ContextIcon, FileIcon } from './Icons';

/**
 * The strip directly above the composer.
 *
 * It names the workspace and the file open in the editor. It does not list
 * project-context references. The ring on the right is the share of the model's
 * max context setting currently in use. While the agent is idle and that share
 * is above 25%, the ring compacts the thread.
 */

export interface ContextStripProps {
  view?: ContextView;
  settingsEnabled: boolean;
  exclusions: string[];
  busy: boolean;
  /** Open the active file (or a context file) in the editor. */
  onOpenFile: (path: string) => void;
  /** Whether the file open in the editor is included on the next turn. */
  includeViewedFile: boolean;
  /** Add or remove that file. Off until the user asks. */
  onSetIncludeViewedFile: (included: boolean) => void;
  /** Tokens currently occupying the context window. */
  usedTokens: number;
  /** Effective max context setting, when one is known. */
  maxTokens?: number;
  /** Compact the active thread. Called only when the ring is enabled. */
  onCompact: () => void;
}

export function ContextStrip({
  view,
  settingsEnabled,
  exclusions,
  busy,
  onOpenFile,
  includeViewedFile,
  onSetIncludeViewedFile,
  usedTokens,
  maxTokens,
  onCompact
}: ContextStripProps): JSX.Element | null {
  const meter = (
    <ContextMeter usedTokens={usedTokens} maxTokens={maxTokens} busy={busy} onCompact={onCompact} />
  );

  if (!view) {
    return meter ? (
      <div className="ctx-region">
        <div className="context-strip" aria-label="Context window">
          {meter}
        </div>
      </div>
    ) : null;
  }

  const effective = applyViewExclusions(view, exclusions);
  const status = settingsEnabled ? effective.status : 'empty';

  const selectionLabel =
    effective.selectionLines > 0
      ? `${effective.selectionLines} line${effective.selectionLines === 1 ? '' : 's'} selected`
      : undefined;

  return (
    <div className="ctx-region">
      <div className={`context-strip is-${status}`} aria-label="Project context for the next turn">
        <span className="context-workspace">{effective.workspaceName ?? 'Workspace'}</span>

        {effective.viewedFile && status !== 'empty' ? (
          <>
            <span className="context-sep" aria-hidden="true">
              ·
            </span>
            <span
              className={`context-file${includeViewedFile && !effective.viewedFileBlocked ? ' is-on' : ' is-ghost'}`}
            >
              <button
                className="context-path"
                type="button"
                title={`Open ${effective.viewedFile} in the editor`}
                onClick={() => onOpenFile(effective.viewedFilePath ?? '')}
              >
                <FileIcon className="ico ico--xs" />
                <span className="context-path-text">{effective.viewedFile}</span>
              </button>
              {effective.viewedFileBlocked ? (
                <span className="context-file-note">excluded</span>
              ) : (
                <button
                  className="context-file-toggle"
                  type="button"
                  aria-pressed={includeViewedFile}
                  aria-label={
                    includeViewedFile
                      ? `Remove ${effective.viewedFile} from context`
                      : `Add ${effective.viewedFile} to context`
                  }
                  title={
                    includeViewedFile
                      ? 'Remove the current file from the next turn'
                      : 'Add the current file to the next turn'
                  }
                  onClick={() => onSetIncludeViewedFile(!includeViewedFile)}
                >
                  {includeViewedFile ? '−' : '+'}
                </button>
              )}
            </span>
          </>
        ) : null}

        {selectionLabel ? <span className="context-selection">{selectionLabel}</span> : null}

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

        {meter}
      </div>
    </div>
  );
}

/**
 * A ring filled by the share of the context window in use.
 *
 * The number is the displayed percent. The ring is a button only while the
 * agent is idle and that percent is above 25, which is when compaction runs.
 */
function ContextMeter({
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
      <span className="context-meter__pct">{percent}</span>
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
