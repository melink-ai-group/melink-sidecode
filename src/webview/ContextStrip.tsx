import { useEffect, useRef, useState, type JSX } from 'react';
import {
  applyViewExclusions,
  categoryExclusionKey,
  itemExclusionKey,
  type ContextCategoryView,
  type ContextItemView,
  type ContextView
} from '../protocol';
import { AlertIcon, ChevronDownIcon, ContextIcon, FileIcon, InfoIcon } from './Icons';

/**
 * The context strip and its floating inspect panel.
 *
 * Placement: one compact strip directly above the composer, in the same control
 * row family as the model switcher and the mode/permission row. Activating it
 * opens a bounded floating panel above the composer so it cannot change the
 * chat or composer dimensions.
 *
 * The strip renders only what will actually be sent: the workspace and branch,
 * the active file as a workspace-relative path that opens in the editor when
 * activated, a selection indicator only when a selection exists, and one chip
 * summarising the remaining categories. The panel lists one row per category
 * with its entry count and truncation state, expanding to the exact excerpts.
 *
 * The host owns the read model; this component only renders it and reports
 * toggles. A failed context is never shown as an empty one: the failed state
 * carries its own message and a recovery route.
 */

export interface ContextStripProps {
  view?: ContextView;
  settingsEnabled: boolean;
  exclusions: string[];
  busy: boolean;
  onToggle: (key: string) => void;
  onResetExclusions: () => void;
  /** Re-read the snapshot on demand, e.g. after a failure. */
  onRefresh: () => void;
  /** Open the active file (or a context file) in the editor. */
  onOpenFile: (path: string) => void;
}

export function ContextStrip({
  view,
  settingsEnabled,
  exclusions,
  busy,
  onToggle,
  onResetExclusions,
  onRefresh,
  onOpenFile
}: ContextStripProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [open]);

  if (!view) {
    return null;
  }

  const effective = applyViewExclusions(view, exclusions);
  const status = settingsEnabled ? effective.status : 'empty';
  const disabledMessage =
    'Project context is turned off in settings. The agent will not see these workspace files.';
  const message = settingsEnabled ? effective.message : disabledMessage;

  const selectionLabel =
    effective.selectionLines > 0
      ? `${effective.selectionLines} line${effective.selectionLines === 1 ? '' : 's'} selected`
      : undefined;

  const summaryCount = effective.remainingGroups;
  const stripLabel = `${effective.workspaceName ?? 'Workspace'}${
    effective.branch ? `, branch ${effective.branch}` : ''
  }`;

  return (
    <div className="ctx-region">
      <div
        className={`context-strip is-${status}${open ? ' is-open' : ''}`}
        aria-label="Project context for the next turn"
      >
        <button
          className="context-toggle"
          type="button"
          ref={triggerRef}
          aria-expanded={open}
          aria-controls="context-panel"
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronDownIcon className="context-chevron" />
          <span className="context-workspace">{effective.workspaceName ?? 'Workspace'}</span>
          <span className="sr-only">{`, ${stripLabel}. Show project context`}</span>
        </button>

        {effective.branch ? (
          <>
            <span className="context-sep" aria-hidden="true">
              ·
            </span>
            <span className="context-branch">
              <span className="context-branch-name">{effective.branch}</span>
            </span>
          </>
        ) : null}

        {effective.activeFile && status !== 'empty' ? (
          <>
            <span className="context-sep" aria-hidden="true">
              ·
            </span>
            <button
              className="context-path"
              type="button"
              title={`Open ${effective.activeFile} in the editor`}
              onClick={() => onOpenFile(effective.activeFilePath ?? '')}
            >
              <FileIcon className="ico ico--xs" />
              <span className="context-path-text">{effective.activeFile}</span>
            </button>
          </>
        ) : null}

        {selectionLabel ? <span className="context-selection">{selectionLabel}</span> : null}

        {status === 'ready' && summaryCount > 0 ? (
          <button
            className="context-more"
            type="button"
            aria-expanded={open}
            aria-controls="context-panel"
            onClick={() => setOpen((value) => !value)}
          >
            <span className="context-more-label">{`+${summaryCount} context group${
              summaryCount === 1 ? '' : 's'
            }`}</span>
          </button>
        ) : null}

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

        {effective.excludedCount > 0 ? (
          <span className="context-reduced" title="Some context is excluded from the next turn">
            {effective.excludedCount} excluded
          </span>
        ) : null}
      </div>

      {open ? (
        <section
          className="context-panel"
          id="context-panel"
          ref={panelRef}
          aria-label="Project context details"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
        >
          <div className="context-panel__head">
            <ContextIcon className="ico ico--sm" />
            <span className="context-panel__title" id="context-panel-title">
              Project context
            </span>
            <span className="spacer" />
            <span className="context-panel__note">
              {status === 'ready'
                ? `${effective.includedCount} item${effective.includedCount === 1 ? '' : 's'} with the next turn`
                : 'not sent'}
            </span>
          </div>

          {status === 'empty' || status === 'failed' ? (
            <div className="context-state">
              <p className="context-state__text">
                {status === 'failed'
                  ? 'Project context could not be built for this workspace.'
                  : message}
              </p>
              <p className="context-state__hint">
                {status === 'failed'
                  ? 'No context will be attached to the next turn, so answers may be based on the conversation alone.'
                  : settingsEnabled
                    ? 'Open a folder in the editor to let the agent see your files, the active file, and any selection.'
                    : 'Enable project context in settings to send workspace files with a turn.'}
              </p>
              <div className="context-state__actions">
                <button className="btn btn--primary" type="button" data-autofocus onClick={onRefresh}>
                  {status === 'failed' ? 'Retry context' : 'Refresh context'}
                </button>
              </div>
            </div>
          ) : status === 'building' ? (
            <div className="context-state">
              <p className="context-state__text">Reading your workspace and selection.</p>
              <p className="context-state__hint">
                This usually takes under a second. The last complete set stays attached until this finishes.
              </p>
            </div>
          ) : (
            <>
              {effective.categories.map((entry) => (
                <ContextCategory key={entry.id} category={entry} onToggle={onToggle} />
              ))}
              <p className="context-panel__footnote">
                <InfoIcon className="ico ico--xs" />
                <span>
                  Exclusions apply to the next turn only. Context is built by the extension and rendered here as
                  received.
                </span>
              </p>
              <div className="context-panel__foot">
                <button
                  className="btn btn--link"
                  type="button"
                  disabled={effective.excludedCount === 0}
                  onClick={onResetExclusions}
                >
                  Reset to defaults
                </button>
                <span className="spacer" />
                {busy ? <span className="context-panel__note">A turn is running</span> : null}
              </div>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}

/**
 * One category row in the inspect panel: a disclosure that expands to the exact
 * entries, plus a per-category exclude toggle. An excluded item is shown as
 * excluded with its reason rather than as a blank row.
 */
function ContextCategory({
  category,
  onToggle
}: {
  category: ContextCategoryView;
  onToggle: (key: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const excluded = category.excluded;
  return (
    <div className={`context-category${excluded ? ' is-excluded' : ''}`}>
      <div className="context-category__head">
        <button
          className="context-category__toggle"
          type="button"
          aria-expanded={open}
          aria-controls={`context-category-${category.id}`}
          disabled={excluded}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronDownIcon className="context-chevron" />
          <span className="context-category__name">{category.label}</span>
          <span className="context-category__meta">
            {category.count} entr{category.count === 1 ? 'y' : 'ies'}
            {category.truncated ? ' · truncated' : ''}
          </span>
        </button>
        <span className="spacer" />
        <button
          className="context-exclude"
          type="button"
          aria-pressed={excluded}
          aria-label={excluded ? `Include ${category.label}` : `Exclude ${category.label} for the next turn`}
          onClick={() => onToggle(categoryExclusionKey(category.id))}
        >
          {excluded ? 'Include' : 'Exclude'}
        </button>
      </div>

      {excluded ? (
        <p className="context-excluded-note">
          <AlertIcon className="ico ico--xs" />
          <span>
            Excluded for the next turn. {category.count} entr{category.count === 1 ? 'y' : 'ies'} will not be sent;
            nothing is added back automatically.
          </span>
        </p>
      ) : null}

      {open && !excluded ? (
        <div className="context-category__body" id={`context-category-${category.id}`}>
          {category.truncationNote ? (
            <p className="context-truncation">
              <AlertIcon className="ico ico--xs" />
              <span>{category.truncationNote}</span>
            </p>
          ) : null}
          {category.items.length === 0 ? (
            <p className="context-category__empty">Nothing in this category for this workspace.</p>
          ) : (
            category.items.map((item) => (
              <ContextItem
                key={item.id}
                categoryId={category.id}
                item={item}
                onToggle={onToggle}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/** One entry: its label, count, whether it is sent, and the exact excerpt. */
function ContextItem({
  categoryId,
  item,
  onToggle
}: {
  categoryId: ContextCategoryView['id'];
  item: ContextItemView;
  onToggle: (key: string) => void;
}): JSX.Element {
  return (
    <div className={`context-item${item.excluded ? ' is-excluded' : ''}`}>
      <div className="context-item__head">
        <span className="context-item__label" title={item.label}>
          {item.label}
        </span>
        <span className="spacer" />
        {item.meta ? <span className="context-item__count">{item.meta}</span> : null}
        <button
          className="context-item__toggle"
          type="button"
          aria-pressed={item.excluded}
          aria-label={item.excluded ? `Include ${item.label}` : `Exclude ${item.label} for the next turn`}
          onClick={() => onToggle(itemExclusionKey(categoryId, item.id))}
        >
          {item.excluded ? 'Include' : 'Exclude'}
        </button>
      </div>
      {item.excluded ? (
        <p className="context-excluded-note">
          <AlertIcon className="ico ico--xs" />
          <span>
            {item.reason
              ? `${item.reason} This entry is not sent.`
              : 'Excluded for the next turn. This entry is not sent.'}
          </span>
        </p>
      ) : item.excerpt ? (
        <pre className="context-excerpt">{item.excerpt}</pre>
      ) : null}
    </div>
  );
}
