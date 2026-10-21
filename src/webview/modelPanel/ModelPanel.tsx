import { useEffect, useRef, useState, type Dispatch, type JSX } from 'react';
import type { BackendAvailability, BackendModel } from '../../backends/types';
import { defaultProviderTab, sortModels } from '../modelList';
import { TabList, type TabItem } from '../Tabs';
import { backendStatusView } from '../backendStatus';
import { AlertIcon, CheckIcon, InfoIcon, RefreshIcon, SearchIcon, SparkIcon } from '../Icons';
import { bridge } from '../hostBridge';
import type { Action } from '../state';

export function ModelPanel({
  providers,
  models,
  modelErrors,
  selectedBackendId,
  selectedModel,
  filter,
  onFilterChange,
  onClose,
  onSetToken,
  onRetry,
  dispatch
}: {
  providers: BackendAvailability[];
  models: Record<string, BackendModel[]>;
  modelErrors: Record<string, string>;
  selectedBackendId?: string;
  selectedModel?: string;
  filter: string;
  onFilterChange: (value: string) => void;
  onClose: () => void;
  onSetToken: (backendId: string) => void;
  onRetry: (backendId: string) => void;
  dispatch: Dispatch<Action>;
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const query = filter.trim().toLowerCase();

  // Move focus into the panel on open so arrow keys and typing land here.
  // Focus returns to the trigger only for Escape; an outside click should
  // leave focus on whatever was pressed.
  useEffect(() => {
    const target =
      filterRef.current ??
      listRef.current?.querySelector<HTMLButtonElement>('.model-option') ??
      document.querySelector<HTMLButtonElement>('#model-panel .btn');
    target?.focus();
  }, []);

  const groups = providers.map((backend) => {
    const list = models[backend.id];
    const matches = sortModels(list ?? []).filter(
      (model) => !query || `${model.label} ${model.id}`.toLowerCase().includes(query)
    );
    return {
      backend,
      matches,
      loaded: list !== undefined,
      error: modelErrors[backend.id]
    };
  });

  // A filter can only be "no matches" once the available lists have loaded;
  // while rows are still arriving the skeletons, not the empty note, show.
  const hasAvailable = providers.some((backend) => backend.status === 'available');

  // Providers are the panel's major sections. Exactly one is visible at a time,
  // so a long provider list scrolls inside its own tab body instead of stacking
  // every provider vertically. Open on the provider of the model already in
  // use (Codex stays on Codex). If that provider drops out, fall back.
  const [activeProvider, setActiveProvider] = useState(() =>
    defaultProviderTab(
      providers.map((backend) => backend.id),
      selectedBackendId
    )
  );
  const providerIds = groups.map((group) => group.backend.id);
  const visibleProvider = providerIds.includes(activeProvider)
    ? activeProvider
    : defaultProviderTab(providerIds, selectedBackendId);
  const activeGroup = groups.find((group) => group.backend.id === visibleProvider) ?? groups[0];
  const activeMatches = activeGroup?.matches ?? [];
  const noMatches =
    query.length > 0 &&
    activeMatches.length === 0 &&
    Boolean(activeGroup?.loaded) &&
    !activeGroup?.error;
  const providerTabs: TabItem[] = groups.map((group) => ({
    id: group.backend.id,
    label: group.backend.label,
    meta: group.error
      ? 'Unavailable'
      : !group.loaded
        ? 'Loading'
        : `${query.length > 0 ? group.matches.length : (models[group.backend.id]?.length ?? 0)}`
  }));

  const focusOption = (delta: number): void => {
    const options = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[data-model-option]') ?? []
    );
    if (options.length === 0) {
      return;
    }
    const index = options.findIndex((option) => option === document.activeElement);
    const next = Math.min(Math.max(index + delta, 0), options.length - 1);
    options[next === -1 ? options.length - 1 : next]?.focus();
  };

  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      document.querySelector<HTMLButtonElement>('.model-trigger')?.focus();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusOption(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const options = Array.from(
        listRef.current?.querySelectorAll<HTMLButtonElement>('[data-model-option]') ?? []
      );
      (event.key === 'Home' ? options[0] : options[options.length - 1])?.focus();
    }
  };

  const select = (backendId: string, model: string): void => {
    const backendChanged = backendId !== selectedBackendId;
    const modelChanged = model !== selectedModel;
    if (backendChanged) {
      dispatch({ type: 'selectBackend', backendId });
    }
    if (backendChanged || modelChanged) {
      dispatch({ type: 'selectModel', model });
      bridge.post({ type: 'selectModel', backendId, modelId: model });
    }
    onClose();
  };

  // Nothing is available: show one explanatory state with a route forward. Any
  // unauthenticated provider becomes a disabled entry inside it, never an error
  // and never an empty list.
  if (!hasAvailable) {
    return (
      <div className="model-panel" id="model-panel" role="dialog" aria-label="Choose a model" onKeyDown={onPanelKeyDown}>
        <div className="model-panel__head">
          <span id="model-panel-title">Choose a model</span>
          <span className="spacer" />
          <button
            className="icon-btn"
            type="button"
            aria-label="Refresh model list"
            onClick={() => {
              dispatch({ type: 'refresh' });
              bridge.post({ type: 'refresh' });
            }}
          >
            <RefreshIcon />
          </button>
        </div>

        <div className="model-panel__body">
          <div className="model-empty" role="status">
            <span className="empty-icon" aria-hidden="true">
              <SparkIcon />
            </span>
            <p className="empty-title">
              {providers.length > 0 ? 'No provider is ready' : 'No provider is installed'}
            </p>
            <p className="empty-text">
              {providers.length > 0
                ? 'Set up a provider below to list the models on your account.'
                : 'Set an Ollama Cloud token, install the OpenCode CLI under Settings → CLI, or install the Codex CLI and sign in.'}
            </p>
            {providers.length === 0 ? (
              <div className="model-empty__actions">
                <button className="btn" type="button" onClick={() => bridge.post({ type: 'openSettings' })}>
                  Set up provider
                </button>
              </div>
            ) : null}
          </div>

          {providers.map((backend) => {
            const view = backendStatusView(backend);
            return (
              <div className="model-group" role="group" aria-label={`${backend.label} - ${view.label.toLowerCase()}`} key={backend.id}>
                <div className="model-group__head">
                  <ProviderBadge backend={backend} />
                  <span className="provider-count">{view.label}</span>
                </div>
                <div className="model-group-notice" role="note">
                  <AlertIcon className="notice-icon" />
                  <div className="notice-body">
                    <div className="notice-title">
                      {view.tone === 'incompatible'
                        ? `${backend.label} speaks a different protocol`
                        : view.tone === 'auth-mismatch'
                          ? `${backend.label} is signed in with the wrong method`
                          : `${backend.label} needs a token`}
                    </div>
                    <div className="notice-text">{view.detail}</div>
                    <div className="notice-actions">
                      {view.tone === 'incompatible' ? (
                        <>
                          {view.version ? (
                            <span className="status-chip status-chip--warning">v{view.version}</span>
                          ) : null}
                          <button className="btn" type="button" onClick={() => bridge.post({ type: 'showAppSettings', section: 'codex' })}>
                            Open settings
                          </button>
                        </>
                      ) : view.tone === 'auth-mismatch' ? (
                        <>
                          {view.authMode ? (
                            <span className="status-chip status-chip--warning">{view.authMode}</span>
                          ) : null}
                          <button className="btn" type="button" onClick={() => bridge.post({ type: 'openSettings' })}>
                            Open settings
                          </button>
                        </>
                      ) : (
                        <button className="btn" type="button" onClick={() => onSetToken(backend.id)}>
                          Set token
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="model-panel__foot">
          <InfoIcon />
          <span>
            {providers.length > 0
              ? 'Providers without a usable integration are hidden until they are installed.'
              : 'Set up provider opens the SideCode settings.'}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="model-panel" id="model-panel" role="dialog" aria-label="Choose a model" onKeyDown={onPanelKeyDown}>
      <div className="model-panel__head">
        <span id="model-panel-title">Choose a model</span>
        <span className="spacer" />
        <button
          className="icon-btn"
          type="button"
          aria-label="Refresh model list"
          onClick={() => {
            for (const backend of providers) {
              if (backend.status === 'available') {
                onRetry(backend.id);
              }
            }
          }}
        >
          <RefreshIcon />
        </button>
      </div>

      <div className="model-filter-row">
        <SearchIcon className="filter-ico" />
        <input
          className="model-filter"
          type="text"
          ref={filterRef}
          value={filter}
          placeholder="Filter models"
          aria-label="Filter models"
          aria-controls="model-list"
          onChange={(event) => onFilterChange(event.target.value)}
        />
      </div>

      {groups.length > 1 ? (
        <TabList
          className="model-panel__tabs"
          label="Providers"
          tabs={providerTabs}
          active={visibleProvider}
          onChange={setActiveProvider}
        />
      ) : null}

      <div className="model-panel__body">
        {activeGroup ? (
          <div
            className="model-list"
            id="model-list"
            ref={listRef}
            role="listbox"
            aria-labelledby="model-panel-title"
          >
            <div className="model-group" role="group" aria-label={activeGroup.backend.label}>
              <div className="model-group__head">
                <ProviderBadge backend={activeGroup.backend} />
                <span className="provider-count">
                  {activeGroup.error
                    ? 'Unavailable'
                    : !activeGroup.loaded
                      ? 'Loading'
                      : `${activeGroup.matches.length} models`}
                </span>
              </div>

              {activeGroup.error ? (
                <div className="model-group-error" role="alert">
                  <AlertIcon className="error-icon" />
                  <div className="error-body">
                    <div className="error-title">Could not load {activeGroup.backend.label} models</div>
                    <div className="error-text">{activeGroup.error}</div>
                    <div className="error-actions">
                      <button className="btn" type="button" onClick={() => onRetry(activeGroup.backend.id)}>
                        <RefreshIcon />
                        Retry
                      </button>
                    </div>
                  </div>
                </div>
              ) : !activeGroup.loaded ? (
                <div aria-hidden="true">
                  <div className="skeleton-row">
                    <span className="skeleton-bar skeleton-bar--60" />
                  </div>
                  <div className="skeleton-row">
                    <span className="skeleton-bar skeleton-bar--40" />
                  </div>
                </div>
              ) : noMatches ? null : (
                activeGroup.matches.map((model) => {
                  const selected =
                    activeGroup.backend.id === selectedBackendId && model.id === selectedModel;
                  return (
                    <button
                      className="model-option"
                      type="button"
                      role="option"
                      data-model-option
                      aria-selected={selected}
                      key={`${activeGroup.backend.id}-${model.id}`}
                      onClick={() => select(activeGroup.backend.id, model.id)}
                    >
                      <span className="model-option-name">
                        {model.label}
                        {model.free ? (
                          <span className="model-free-chip" title="Free on OpenCode Zen">
                            Free
                          </span>
                        ) : null}
                      </span>
                      {selected ? <CheckIcon className="model-check" /> : null}
                    </button>
                  );
                })
              )}
            </div>

            {noMatches ? (
              <div className="model-empty" role="status">
                <p className="empty-title">No models match</p>
                <p className="empty-text">Try a different filter, or clear it to see every model.</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ProviderBadge({ backend }: { backend: BackendAvailability }): JSX.Element {
  return (
    <span className={`provider-badge provider-badge--${backend.id}`}>
      <span className={`provider-dot provider-dot--${backend.id}`} aria-hidden="true" />
      <span className="provider-name">{backend.label}</span>
    </span>
  );
}

