import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { THINKING_LEVELS, type BackendModel } from '../backends/types';
import type { ConnectionTestResult, SettingsPatch, SettingsSnapshot } from '../protocol';
import { formatDictationTarget } from '../dictation/target';
import { AlertIcon, BackIcon, CheckIcon, CrossIcon, InfoIcon } from './Icons';
import { summarizeOpencodeCliOutput } from '../backends/opencode/upgradeText';
import { opencodeRuntimeView } from './runtimeStatus';
import { contextPatternError } from '../context/contextSettings';
import { TabList, TabPanel, type TabItem } from './Tabs';

/**
 * The settings screen: providers, credentials, and app-level defaults.
 *
 * It mirrors the accepted prototype under `.design/` — a stack of inline panels
 * inside the view (never a floating popover), compact density, one primary
 * action at the foot. Color and type come only from `--vscode-*` and the brand
 * tokens; brand hue is confined to the Ollama provider dot.
 *
 * The stored token is never rendered: the field is masked and empty, and only
 * `hasToken` drives the chip and placeholder. An invalid field shows an inline
 * message and is not persisted.
 */

/**
 * The built-in ignore patterns shown for reference. They mirror the documented
 * default set in `docs/usage.md`; they are not editable, because the built-in
 * secret and key exclusions are always on.
 */
const CONTEXT_BUILTIN_PATTERNS: readonly string[] = [
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  'coverage/',
  '*.min.js',
  '*.map',
  'package-lock.json',
  'yarn.lock',
  '.env',
  '*.pem',
  '*.key',
  'id_rsa'
];

export interface SettingsScreenProps {
  settings?: SettingsSnapshot;
  connectionTest?: { backendId: string; pending: boolean; result?: ConnectionTestResult };
  onBack: () => void;
  onSave: (patch: SettingsPatch) => void;
  onSaveToken: (value: string) => void;
  onClearToken: () => void;
  onTestConnection: (backendId: string) => void;
  opencodeUpgrade?: { pending: boolean; ok?: boolean; message?: string };
  onUpgradeOpencode: () => void;
  opencodeInstall?: { pending: boolean; ok?: boolean; message?: string; path?: string };
  onInstallOpencode: () => void;
  zvecGrep?: { pending: boolean; requested?: boolean; ok?: boolean; message?: string };
  onSetZvecGrep: (enabled: boolean) => void;
}

/** Local draft state; the host snapshot is the source of truth on save. */
interface Draft {
  ollamaBaseUrl: string;
  ollamaDefaultModel: string;
  codexPath: string;
  codexDefaultModel: string;
  permissionLevel: SettingsSnapshot['defaults']['permissionLevel'];
  mode: SettingsSnapshot['defaults']['mode'];
  thinking: SettingsSnapshot['defaults']['thinking'] | '';
  dictationModel: string;
  opencodeEnabled: boolean;
  opencodePath: string;
  contextIncludeInstructions: boolean;
  contextIncludeShape: boolean;
  contextIncludeEditorState: boolean;
  contextIncludeSelection: boolean;
  contextIncludeChangedFiles: boolean;
  /** The overall cap, held as a string so a half-typed value is not coerced. */
  contextMaxKb: string;
  contextExclude: string[];
}

/** Seed the draft from a host snapshot; used on load, echo, and reset. */
function draftFrom(settings: SettingsSnapshot): Draft {
  return {
    ollamaBaseUrl: settings.ollama.baseUrl,
    ollamaDefaultModel: settings.ollama.defaultModel,
    codexPath: settings.codex.path,
    codexDefaultModel: settings.codex.defaultModel,
    permissionLevel: settings.defaults.permissionLevel,
    mode: settings.defaults.mode,
    thinking: settings.defaults.thinking ?? '',
    dictationModel: formatDictationTarget(settings.defaults.dictationModel),
    opencodeEnabled: settings.opencode.enabled,
    opencodePath: settings.opencode.path,
    contextIncludeInstructions: settings.context.includeInstructions,
    contextIncludeShape: settings.context.includeShape,
    contextIncludeEditorState: settings.context.includeEditorState,
    contextIncludeSelection: settings.context.includeSelection,
    contextIncludeChangedFiles: settings.context.includeChangedFiles,
    contextMaxKb: String(Math.round(settings.context.maxBytes / 1024)),
    contextExclude: [...settings.context.exclude]
  };
}

export function SettingsScreen({
  settings,
  connectionTest,
  onBack,
  onSave,
  onSaveToken,
  onClearToken,
  onTestConnection,
  opencodeUpgrade,
  onUpgradeOpencode,
  opencodeInstall,
  onInstallOpencode,
  zvecGrep,
  onSetZvecGrep
}: SettingsScreenProps): JSX.Element {
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [errors, setErrors] = useState<Partial<Record<keyof SettingsPatch, string>>>({});
  const [token, setToken] = useState('');
  const [tokenSaved, setTokenSaved] = useState(false);
  // The pattern being typed; it only joins the draft list on Add or Enter, so a
  // half-typed pattern is never validated or saved mid-keystroke.
  const [patternDraft, setPatternDraft] = useState('');
  // Gates the `unrestricted` default behind a labelled confirmation, so it can
  // never be enabled as a side effect of another change.
  const [permissionConfirm, setPermissionConfirm] = useState(false);
  // The visible settings section. Switching tabs never touches the draft, so an
  // unsaved edit in another section survives.
  const [tab, setTab] = useState<'providers' | 'defaults' | 'context'>('providers');
  // Ollama and Codex are separate pages inside Providers. The choice is view
  // state only; it does not touch the draft.
  const [providerTab, setProviderTab] = useState<'provider-ollama' | 'provider-codex'>('provider-ollama');
  const backRef = useRef<HTMLButtonElement>(null);
  const lastSettingsRef = useRef<SettingsSnapshot | undefined>(undefined);

  // The host is the authority on whether a value was persisted: a refused field
  // is echoed on the snapshot, so the inline message is the host's, not a local
  // guess (e.g. a path that does not exist on disk). An accepted save carries no
  // `saveErrors`, which clears the messages.
  useEffect(() => {
    if (!settings) {
      return;
    }
    setErrors(settings.saveErrors ?? {});
  }, [settings]);

  // A successful install writes a new absolute path on the host. Adopt it in the
  // draft so Save does not put the previous "not found" path back.
  useEffect(() => {
    const installedPath = opencodeInstall?.ok ? opencodeInstall.path : undefined;
    if (!installedPath) {
      return;
    }
    setDraft((current) =>
      current && current.opencodePath !== installedPath ? { ...current, opencodePath: installedPath } : current
    );
  }, [opencodeInstall]);

  useEffect(() => {
    backRef.current?.focus();
  }, []);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  // Add a typed pattern to the draft list. A pattern that is already present is
  // ignored, so the list cannot accumulate accidental duplicates.
  const addPattern = (): void => {
    const value = patternDraft.trim();
    if (!value) {
      return;
    }
    setDraft((current) =>
      current && !current.contextExclude.includes(value)
        ? { ...current, contextExclude: [...current.contextExclude, value] }
        : current
    );
    setPatternDraft('');
  };

  // True when the working copy differs from the stored settings, so the footer
  // can name unsaved changes and gate the single primary action on them.
  const dirty = useMemo(() => {
    if (!draft || !settings) {
      return false;
    }
    const storedKb = String(Math.round(settings.context.maxBytes / 1024));
    const storedExclude = JSON.stringify(settings.context.exclude);
    return (
      draft.ollamaBaseUrl !== settings.ollama.baseUrl ||
      draft.ollamaDefaultModel !== settings.ollama.defaultModel ||
      draft.codexPath !== settings.codex.path ||
      draft.codexDefaultModel !== settings.codex.defaultModel ||
      draft.permissionLevel !== settings.defaults.permissionLevel ||
      draft.mode !== settings.defaults.mode ||
      draft.thinking !== (settings.defaults.thinking ?? '') ||
      draft.dictationModel !== formatDictationTarget(settings.defaults.dictationModel) ||
      draft.opencodeEnabled !== settings.opencode.enabled ||
      draft.opencodePath !== settings.opencode.path ||
      draft.contextIncludeInstructions !== settings.context.includeInstructions ||
      draft.contextIncludeShape !== settings.context.includeShape ||
      draft.contextIncludeEditorState !== settings.context.includeEditorState ||
      draft.contextIncludeSelection !== settings.context.includeSelection ||
      draft.contextIncludeChangedFiles !== settings.context.includeChangedFiles ||
      draft.contextMaxKb !== storedKb ||
      JSON.stringify(draft.contextExclude) !== storedExclude
    );
  }, [draft, settings]);

  // Seed on first load and after the draft is clean. Background snapshot updates
  // must not erase edits currently being made in another settings section.
  useEffect(() => {
    if (!settings || lastSettingsRef.current === settings) {
      return;
    }
    lastSettingsRef.current = settings;
    if (!draft || !dirty) {
      setDraft(draftFrom(settings));
    }
  }, [settings, draft, dirty]);

  const resetDraft = (): void => {
    if (settings) {
      setDraft(draftFrom(settings));
    }
    setErrors({});
    setToken('');
    setTokenSaved(false);
    setPatternDraft('');
  };

  // Validate locally, then hand the host only valid fields. An invalid value is
  // never sent, so it can never be persisted.
  const save = (): void => {
    if (!draft) {
      return;
    }
    const nextErrors: Partial<Record<keyof SettingsPatch, string>> = {};
    if (!isHttpUrl(draft.ollamaBaseUrl)) {
      nextErrors.ollamaBaseUrl = 'Enter a full URL, like https://ollama.com. This value was not saved.';
    }
    if (!draft.codexPath.trim()) {
      nextErrors.codexPath = 'Enter the CLI path or name. This value was not saved.';
    }
    // The path is only meaningful while the runtime is on, so it is validated
    // only then; an invalid value is never sent, so the stored path survives.
    if (draft.opencodeEnabled && !draft.opencodePath.trim()) {
      nextErrors.opencodePath = 'Enter the opencode CLI path or name. This value was not saved.';
    }
    // The cap is entered in kilobytes, so the value the user sees is readable;
    // it is stored as bytes. A non-integer or out-of-range value is refused.
    const maxKb = Number(draft.contextMaxKb.trim());
    if (!Number.isFinite(maxKb) || !Number.isInteger(maxKb) || maxKb < 1 || maxKb > 1024) {
      nextErrors.contextMaxBytes = 'Enter a whole number of kilobytes between 1 and 1024. This value was not saved.';
    }
    const badPattern = draft.contextExclude.find((pattern) => contextPatternError(pattern) !== undefined);
    if (badPattern !== undefined) {
      nextErrors.contextExclude = contextPatternError(badPattern);
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }
    onSave({
      ollamaBaseUrl: draft.ollamaBaseUrl.trim(),
      ollamaDefaultModel: draft.ollamaDefaultModel.trim(),
      codexPath: draft.codexPath.trim(),
      codexDefaultModel: draft.codexDefaultModel.trim(),
      permissionLevel: draft.permissionLevel,
      mode: draft.mode,
      thinking: draft.thinking,
      dictationModel: draft.dictationModel.trim(),
      opencodeEnabled: draft.opencodeEnabled,
      // The path is sent only while the runtime is on: an off runtime must not
      // write an empty path over a previously stored valid one.
      ...(draft.opencodeEnabled ? { opencodePath: draft.opencodePath.trim() } : {}),
      contextIncludeInstructions: draft.contextIncludeInstructions,
      contextIncludeShape: draft.contextIncludeShape,
      contextIncludeEditorState: draft.contextIncludeEditorState,
      contextIncludeSelection: draft.contextIncludeSelection,
      contextIncludeChangedFiles: draft.contextIncludeChangedFiles,
      contextMaxBytes: maxKb * 1024,
      contextExclude: draft.contextExclude.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0)
    });
  };

  const saveToken = (): void => {
    const value = token.trim();
    if (!value) {
      return;
    }
    onSaveToken(value);
    setToken('');
    setTokenSaved(true);
  };

  if (!settings || !draft) {
    return (
      <main className="app">
        <header className="view-title settings-title">
          <button className="icon-btn" type="button" aria-label="Back to chat" onClick={onBack} ref={backRef}>
            <BackIcon />
          </button>
          <span className="settings-title__name">Settings</span>
        </header>
        <div className="settings" aria-label="Agent settings">
          <div className="restoring" role="status">
            <span className="spinner" aria-hidden="true" />
            Loading settings...
          </div>
        </div>
      </main>
    );
  }

  const ollamaStatus = connectionTest?.backendId === 'ollama' ? connectionTest : undefined;
  const codexStatus = connectionTest?.backendId === 'codex' ? connectionTest : undefined;
  const modelOptions = flattenModels(settings.models);
  const runtimeView = opencodeRuntimeView(settings.opencode);
  const zvecChecked = zvecGrep?.pending
    ? zvecGrep.requested === true
    : settings.opencode.zvecGrep.enabled;
  const zvecStatus = zvecGrep?.pending
    ? zvecGrep.requested
      ? 'Installing zvec-grep and connecting it to OpenCode.'
      : 'Disconnecting zvec-grep from OpenCode.'
    : settings.opencode.zvecGrep.enabled
      ? 'Connected. A new OpenCode session uses it.'
      : settings.opencode.zvecGrep.cli === 'installed'
        ? 'Installed. Turning this on connects it to OpenCode.'
        : 'Not installed. Turning this on installs it and connects it to OpenCode.';
  const tabs: readonly TabItem[] = [
    { id: 'providers', label: 'Providers' },
    { id: 'defaults', label: 'Defaults' },
    { id: 'context', label: 'Context' }
  ];

  return (
    <main className="app">
      <header className="view-title settings-title">
        <button className="icon-btn" type="button" aria-label="Back to chat" onClick={onBack} ref={backRef}>
          <BackIcon />
        </button>
        <span className="settings-title__name">Settings</span>
        <span className="settings-title__scope">
          {settings.target === 'workspace' ? 'Workspace settings' : 'User settings'}
        </span>
      </header>

      <div className="settings" aria-label="Agent settings">
        <TabList
          className="settings__tabs"
          label="Settings sections"
          tabs={tabs}
          active={tab}
          onChange={(id) => setTab(id as typeof tab)}
        />

        {/* ---------- Providers ---------- */}
        <TabPanel id="providers" active={tab}>
        <section className="panel panel--fill" aria-labelledby="providers-title">
          <div className="panel__head" id="providers-title">
            <span>Providers</span>
            <span className="spacer" />
            <span className="panel__note">Where the agent sends your prompts</span>
          </div>
          <TabList
            className="tablist--nested"
            label="Provider"
            tabs={[
              { id: 'provider-ollama', label: 'Ollama' },
              { id: 'provider-codex', label: 'Codex' }
            ]}
            active={providerTab}
            onChange={(id) => setProviderTab(id as 'provider-ollama' | 'provider-codex')}
          />
          <TabPanel id="provider-ollama" active={providerTab} className="tabpanel--inline">
            {/* Ollama Cloud */}
            <div className="field">
              <div className="field__head">
                <span className="provider-badge">
                  <span className="provider-dot provider-dot--ollama" aria-hidden="true" />
                  <span className="provider-name">{ollamaLabel(settings)}</span>
                </span>
                <span className="spacer" />
                <span className={`chip ${settings.ollama.hasToken ? 'chip--stored' : 'chip--missing'}`}>
                  {settings.ollama.hasToken ? 'Key stored' : 'No key'}
                </span>
              </div>
              <p className="field-help">The base URL and API key the agent uses for every Ollama Cloud model.</p>

              <label className="field-label" htmlFor="ollama-base-url">
                Base URL
              </label>
              <input
                className="input"
                id="ollama-base-url"
                type="url"
                value={draft.ollamaBaseUrl}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={errors.ollamaBaseUrl ? true : undefined}
                aria-describedby={errors.ollamaBaseUrl ? 'ollama-base-url-error' : 'ollama-base-url-help'}
                onChange={(event) => update('ollamaBaseUrl', event.target.value)}
              />
              {errors.ollamaBaseUrl ? (
                <p className="field-msg field-msg--error" id="ollama-base-url-error">
                  <AlertIcon />
                  <span>{errors.ollamaBaseUrl}</span>
                </p>
              ) : (
                <p className="field-help" id="ollama-base-url-help">
                  Where Ollama Cloud requests are sent. The key below is sent to this host.
                </p>
              )}

              <label className="field-label" htmlFor="ollama-default-model">
                Default model
              </label>
              <select
                className="select"
                id="ollama-default-model"
                value={draft.ollamaDefaultModel}
                onChange={(event) => update('ollamaDefaultModel', event.target.value)}
              >
                <option value="">First model reported by the provider</option>
                {modelOptions
                  .filter((option) => option.backendId === 'ollama')
                  .map((option) => (
                    <option value={option.id} key={option.id}>
                      {option.label}
                    </option>
                  ))}
              </select>
              <p className="field-help">
                Used for a new conversation. Switching the model in the header overrides it for that conversation.
              </p>

              <label className="field-label" htmlFor="ollama-api-key">
                API key
              </label>
              <div className="secret-row">
                <input
                  className="input secret-input"
                  id="ollama-api-key"
                  type="password"
                  value={token}
                  placeholder={settings.ollama.hasToken ? '••••••••••••••••' : ''}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby="ollama-key-state"
                  onChange={(event) => {
                    setToken(event.target.value);
                    setTokenSaved(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      saveToken();
                    }
                  }}
                />
              </div>
              <p className="field-msg" id="ollama-key-state">
                {settings.ollama.hasToken ? (
                  <>
                    <span className="stored-dot" aria-hidden="true" />
                    <span>
                      {tokenSaved
                        ? 'Key saved. The stored value is never shown back.'
                        : 'A key is stored. Enter a new key to replace it, or clear it.'}
                    </span>
                  </>
                ) : (
                  <span>{tokenSaved ? 'Key saved.' : 'No key is stored. Add one to use Ollama Cloud models.'}</span>
                )}
              </p>

              <div className="field-row">
                <button className="btn" type="button" disabled={!token.trim()} onClick={saveToken}>
                  Save key
                </button>
                <button
                  className="btn btn--danger"
                  type="button"
                  disabled={!settings.ollama.hasToken}
                  onClick={() => {
                    onClearToken();
                    setToken('');
                    setTokenSaved(false);
                  }}
                >
                  Clear key
                </button>
                <span className="spacer" />
                <button
                  className="btn"
                  type="button"
                  disabled={connectionTest?.backendId === 'ollama' && connectionTest.pending}
                  onClick={() => onTestConnection('ollama')}
                >
                  <RefreshIconInline />
                  {connectionTest?.backendId === 'ollama' && connectionTest.pending ? 'Testing...' : 'Test connection'}
                </button>
              </div>
              <p className="field-help">
                The key is kept in secret storage only. It is never written to settings or logs.
              </p>

              {ollamaStatus ? <TestResult backendLabel="Ollama Cloud" test={ollamaStatus} onRetry={() => onTestConnection('ollama')} /> : null}
            </div>

            <div className="settings-subs">
              <section className="settings-sub" aria-labelledby="opencode-title">
                <h3 className="settings-sub__title" id="opencode-title">
                  OpenCode
                </h3>
                <p className="field-help">
                  Optional runtime for Ollama Cloud. Turns use the opencode CLI when this is on, and the direct adapter when it is off.
                </p>
                <div className="runtime">
                  <label className="check" htmlFor="opencode-enabled">
                    <input
                      className="check-input"
                      id="opencode-enabled"
                      type="checkbox"
                      checked={draft.opencodeEnabled}
                      onChange={(event) => update('opencodeEnabled', event.target.checked)}
                    />
                    <span className="check-box" aria-hidden="true">
                      <CheckIcon />
                    </span>
                    <span className="check-body">
                      <span className="check-label">Use opencode for Ollama turns</span>
                      <span className="check-text">Applies from the next turn. Save settings before installing or updating.</span>
                    </span>
                  </label>

                  {draft.opencodeEnabled ? (
                    <>
                      <label className="field-label" htmlFor="opencode-path">
                        opencode CLI path
                      </label>
                      <input
                        className="input"
                        id="opencode-path"
                        type="text"
                        value={draft.opencodePath}
                        spellCheck={false}
                        autoComplete="off"
                        aria-invalid={errors.opencodePath ? true : undefined}
                        aria-describedby={errors.opencodePath ? 'opencode-path-error' : 'opencode-status'}
                        onChange={(event) => update('opencodePath', event.target.value)}
                      />
                      {errors.opencodePath ? (
                        <p className="field-msg field-msg--error" id="opencode-path-error" role="alert">
                          <AlertIcon />
                          <span>{errors.opencodePath}</span>
                        </p>
                      ) : null}
                    </>
                  ) : null}

                  <p
                    className={`runtime-status runtime-status--${runtimeView.tone}`}
                    id="opencode-status"
                    role="status"
                  >
                    <span className="runtime-dot" aria-hidden="true" />
                    <span>{runtimeView.label}</span>
                    {runtimeView.version ? <span className="runtime-version">{runtimeView.version}</span> : null}
                  </p>

                  {settings.opencode.enabled ? (
                    <div className="runtime-actions">
                      {settings.opencode.status === 'detected' ? (
                        <>
                          <button
                            className="btn btn--secondary"
                            type="button"
                            disabled={opencodeUpgrade?.pending}
                            onClick={onUpgradeOpencode}
                          >
                            {opencodeUpgrade?.pending ? 'Updating...' : 'Update opencode'}
                          </button>
                          {opencodeUpgrade && !opencodeUpgrade.pending && opencodeUpgrade.message ? (
                            <CliResult ok={opencodeUpgrade.ok} message={opencodeUpgrade.message} />
                          ) : null}
                        </>
                      ) : (
                        <>
                          <button
                            className="btn btn--secondary"
                            type="button"
                            disabled={opencodeInstall?.pending}
                            onClick={onInstallOpencode}
                          >
                            {opencodeInstall?.pending ? 'Installing...' : 'Install opencode'}
                          </button>
                          {opencodeInstall && !opencodeInstall.pending && opencodeInstall.message ? (
                            <CliResult ok={opencodeInstall.ok} message={opencodeInstall.message} />
                          ) : null}
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              </section>

              {settings.opencode.enabled ? (
                <section className="settings-sub" aria-labelledby="semantic-search-title">
                  <h3 className="settings-sub__title" id="semantic-search-title">
                    OpenCode Semantic Search
                  </h3>
                  <p className="field-help">
                    Indexes this workspace locally so OpenCode can search by meaning instead of reading files into the prompt. That reduces token usage on each turn.
                  </p>
                  <div className="runtime">
                    <label className="check" htmlFor="zvec-grep-enabled">
                      <input
                        className="check-input"
                        id="zvec-grep-enabled"
                        type="checkbox"
                        checked={zvecChecked}
                        disabled={zvecGrep?.pending}
                        aria-describedby="zvec-grep-status"
                        onChange={(event) => onSetZvecGrep(event.target.checked)}
                      />
                      <span className="check-box" aria-hidden="true">
                        <CheckIcon />
                      </span>
                      <span className="check-body">
                        <span className="check-label">Use semantic search</span>
                        <span className="check-text">
                          Updates your user OpenCode config. A new session picks it up.
                        </span>
                      </span>
                    </label>
                    <p className="field-help" id="zvec-grep-status">
                      {zvecStatus}
                    </p>
                    {zvecGrep && !zvecGrep.pending && zvecGrep.message ? (
                      <CliResult ok={zvecGrep.ok} message={zvecGrep.message} />
                    ) : null}
                  </div>
                </section>
              ) : null}
            </div>
          </TabPanel>

          <TabPanel id="provider-codex" active={providerTab} className="tabpanel--inline">
            <div className="field">
              <div className="field__head">
                <span className="provider-badge provider-badge--codex">
                  <span className="provider-dot provider-dot--codex" aria-hidden="true" />
                  <span className="provider-name">{codexLabel(settings)}</span>
                </span>
                <span className="spacer" />
                <span className={`chip ${settings.codex.status === 'available' ? 'chip--signedin' : 'chip--signedout'}`}>
                  {codexAuthLabel(settings)}
                </span>
              </div>
              <p className="field-help">The CLI the agent launches for Codex models, and whether it is signed in.</p>

              <label className="field-label" htmlFor="codex-path">
                Codex CLI path
              </label>
              <input
                className="input"
                id="codex-path"
                type="text"
                value={draft.codexPath}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={errors.codexPath ? true : undefined}
                aria-describedby={errors.codexPath ? 'codex-path-error' : 'codex-path-help'}
                onChange={(event) => update('codexPath', event.target.value)}
              />
              {errors.codexPath ? (
                <p className="field-msg field-msg--error" id="codex-path-error">
                  <AlertIcon />
                  <span>{errors.codexPath}</span>
                </p>
              ) : (
                <p className="field-help" id="codex-path-help">
                  Path to the Codex CLI. A bare name is resolved from PATH.
                </p>
              )}

              <label className="field-label" htmlFor="codex-default-model">
                Default model
              </label>
              <select
                className="select"
                id="codex-default-model"
                value={draft.codexDefaultModel}
                onChange={(event) => update('codexDefaultModel', event.target.value)}
              >
                <option value="">The CLI default</option>
                {modelOptions
                  .filter((option) => option.backendId === 'codex')
                  .map((option) => (
                    <option value={option.id} key={option.id}>
                      {option.label}
                    </option>
                  ))}
              </select>
              <p className="field-help">Used for a new conversation. Switching the model in the header overrides it.</p>

              <p className="field-label field-label--row">Login state</p>
              <p className={`field-msg ${settings.codex.status === 'available' ? 'field-msg--ok' : ''}`}>
                {settings.codex.status === 'available' ? <CheckIcon /> : <InfoIcon />}
                <span>{codexAuthDetail(settings)}</span>
              </p>
              {settings.codex.authMode ? (
                <p className="field-help" id="codex-auth-mode">
                  Reported auth method: {settings.codex.authMode}
                </p>
              ) : null}
              <div className="field-row">
                <button
                  className="btn"
                  type="button"
                  disabled={connectionTest?.backendId === 'codex' && connectionTest.pending}
                  onClick={() => onTestConnection('codex')}
                >
                  <RefreshIconInline />
                  {connectionTest?.backendId === 'codex' && connectionTest.pending ? 'Testing...' : 'Test connection'}
                </button>
              </div>

              {codexStatus ? <TestResult backendLabel="Codex" test={codexStatus} onRetry={() => onTestConnection('codex')} /> : null}
            </div>
          </TabPanel>
        </section>
        </TabPanel>

        {/* ---------- Defaults ---------- */}
        <TabPanel id="defaults" active={tab}>
        <section className="panel" aria-labelledby="defaults-title">
          <div className="panel__head" id="defaults-title">
            <span>Defaults</span>
            <span className="spacer" />
            <span className="panel__note">A per-model or per-conversation choice can override these</span>
          </div>
          <div className="panel__body">
            <div className="field">
              <label className="field-label" htmlFor="default-permission">
                Default permission level
              </label>
              <select
                className="select"
                id="default-permission"
                value={draft.permissionLevel}
                onChange={(event) => {
                  const value = event.target.value as Draft['permissionLevel'];
                  // Unrestricted widens permissions for every new conversation,
                  // so selecting it opens the labelled confirmation rather than
                  // applying directly.
                  if (value === 'unrestricted') {
                    setPermissionConfirm(true);
                    return;
                  }
                  update('permissionLevel', value);
                }}
              >
                <option value="read-only">Read-only</option>
                <option value="default">Default (asks outside the sandbox)</option>
                <option value="unrestricted">Unrestricted (no prompts)</option>
              </select>
              <p className="field-help">
                How much the agent may do without asking. A per-conversation choice overrides it.
              </p>
              {permissionConfirm ? (
                <div className="confirm-gate" role="alertdialog" aria-label="Confirm unrestricted default">
                  <div className="confirm-gate__head">
                    <span className="confirm-gate__icon" aria-hidden="true">
                      <AlertIcon />
                    </span>
                    <div>
                      <p className="confirm-gate__title">Make unrestricted the default?</p>
                      <p className="confirm-gate__text">
                        New conversations will run with no sandbox and no prompts until you change the level.
                      </p>
                    </div>
                  </div>
                  <div className="confirm-gate__actions">
                    <button className="btn" type="button" onClick={() => setPermissionConfirm(false)}>
                      Cancel
                    </button>
                    <button
                      className="btn btn--danger"
                      type="button"
                      onClick={() => {
                        update('permissionLevel', 'unrestricted');
                        setPermissionConfirm(false);
                      }}
                    >
                      Use unrestricted
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="field">
              <label className="field-label" htmlFor="default-mode">
                Default mode
              </label>
              <select
                className="select"
                id="default-mode"
                value={draft.mode}
                onChange={(event) => update('mode', event.target.value as Draft['mode'])}
              >
                <option value="agent">Agent</option>
                <option value="plan">Plan</option>
                <option value="ask">Ask</option>
              </select>
              <p className="field-help">The mode a new conversation starts in. It can be changed per conversation.</p>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="default-thinking">
                Default thinking level
              </label>
              <select
                className="select"
                id="default-thinking"
                value={draft.thinking}
                onChange={(event) => update('thinking', event.target.value as Draft['thinking'])}
              >
                <option value="">Use each model’s default</option>
                {THINKING_LEVELS.map((level) => (
                  <option value={level} key={level}>
                    {level[0]?.toUpperCase()}{level.slice(1)}
                  </option>
                ))}
              </select>
              <p className="field-help">
                A model’s reported default and its saved per-model choice take precedence. Otherwise this level
                is used; unsupported levels are reduced to the closest level the model supports.
              </p>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="dictation-model">
                Dictation model
              </label>
              <select
                className="select"
                id="dictation-model"
                value={draft.dictationModel}
                onChange={(event) => update('dictationModel', event.target.value)}
              >
                <option value="">None</option>
                {(['ollama', 'codex'] as const).map((backendId) => {
                  const options = modelOptions.filter((option) => option.backendId === backendId);
                  const savedHere = draft.dictationModel.startsWith(`${backendId}|`);
                  if (options.length === 0 && !savedHere) {
                    return null;
                  }
                  const known = options.some((option) => `${backendId}|${option.id}` === draft.dictationModel);
                  return (
                    <optgroup label={backendId === 'ollama' ? 'Ollama' : 'Codex'} key={backendId}>
                      {!known && draft.dictationModel.startsWith(`${backendId}|`) ? (
                        <option value={draft.dictationModel}>{draft.dictationModel.slice(backendId.length + 1)}</option>
                      ) : null}
                      {options.map((option) => (
                        <option value={`${backendId}|${option.id}`} key={`${backendId}|${option.id}`}>
                          {option.label}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
              <p className="field-help">
                This model only cleans dictated text. It does not answer. Choose an Ollama or Codex model. None disables the microphone.
              </p>
            </div>
          </div>
        </section>
        </TabPanel>

        {/* ---------- Context ---------- */}
        <TabPanel id="context" active={tab}>
        <section className="panel" aria-labelledby="context-title">
          <div className="panel__head" id="context-title">
            <span>Context</span>
            <span className="spacer" />
            <span className="panel__note">What the agent is told about this workspace</span>
          </div>
          <div className="panel__body">
            {/* Included by default */}
            <div className="field">
              <p className="field-label field-label--row">Included by default</p>
              <p className="field-help">
                Sent before your first message, so the agent knows the project without being told. Turn a
                category off and its content is never sent; editor state and selection are not even read.
              </p>
              <ul className="context-list">
                <ContextCategory
                  id="context-include-instructions"
                  name="Instruction documents"
                  description="AGENTS.md, README.md, and .github/copilot-instructions.md, each as a short excerpt."
                  checked={draft.contextIncludeInstructions}
                  onChange={(value) => update('contextIncludeInstructions', value)}
                />
                <ContextCategory
                  id="context-include-shape"
                  name="Project shape"
                  description="Folder name, git branch and remote, language breakdown, and a small directory tree."
                  checked={draft.contextIncludeShape}
                  onChange={(value) => update('contextIncludeShape', value)}
                />
                <ContextCategory
                  name="Editor state"
                  description="Follows the file you are looking at: its path, language, and the open editors. Controlled below."
                  checked={draft.contextIncludeEditorState}
                />
                <ContextCategory
                  name="Current selection"
                  description="The text you have highlighted, quoted verbatim. Controlled below."
                  checked={draft.contextIncludeSelection}
                />
                <ContextCategory
                  id="context-include-changed"
                  name="Changed files"
                  description="A notice of files changed since the last turn, so the agent knows what moved."
                  checked={draft.contextIncludeChangedFiles}
                  onChange={(value) => update('contextIncludeChangedFiles', value)}
                />
              </ul>
            </div>

            {/* Editor state toggle, the per-turn consequence */}
            <div className="field">
              <p className="field-label field-label--row">Editor state</p>
              <label className="check" htmlFor="context-follow-editor">
                <input
                  className="check-input"
                  id="context-follow-editor"
                  type="checkbox"
                  checked={draft.contextIncludeEditorState}
                  onChange={(event) => update('contextIncludeEditorState', event.target.checked)}
                />
                <span className="check-box" aria-hidden="true">
                  <CheckIcon />
                </span>
                <span className="check-body">
                  <span className="check-label">Follow the active file and selection</span>
                  <span className="check-text">
                    With this off the agent knows the project but not the current page.
                  </span>
                </span>
              </label>
              <p className="field-msg">
                <InfoIcon />
                <span>
                  When off, the composer strip shows no current file and no active-file or selection content
                  is sent.
                </span>
              </p>
            </div>

            {/* Selection sharing, its own control and warning */}
            <div className="field">
              <p className="field-label field-label--row">Selection</p>
              <label className="check" htmlFor="context-include-selection">
                <input
                  className="check-input"
                  id="context-include-selection"
                  type="checkbox"
                  checked={draft.contextIncludeSelection}
                  onChange={(event) => update('contextIncludeSelection', event.target.checked)}
                />
                <span className="check-box" aria-hidden="true">
                  <CheckIcon />
                </span>
                <span className="check-body">
                  <span className="check-label">Quote the current selection</span>
                  <span className="check-text">
                    Include the highlighted text so the agent can see exactly what you mean.
                  </span>
                </span>
              </label>
              <p className="field-msg field-msg--warn">
                <AlertIcon />
                <span>Selected text is sent verbatim, including anything sensitive inside it.</span>
              </p>
            </div>

            {/* Size limit */}
            <div className="field">
              <label className="field-label" htmlFor="context-max-kb">
                Maximum context size
              </label>
              <div className="field-row">
                <input
                  className="input context-budget-input"
                  id="context-max-kb"
                  type="text"
                  inputMode="numeric"
                  value={draft.contextMaxKb}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={errors.contextMaxBytes ? true : undefined}
                  aria-describedby={errors.contextMaxBytes ? 'context-max-error' : 'context-max-help'}
                  onChange={(event) => update('contextMaxKb', event.target.value)}
                />
                <span className="context-unit" aria-hidden="true">
                  KB
                </span>
                <span className="spacer" />
                <span className="chip">Resolved default {Math.round(settings.context.defaultMaxBytes / 1024)} KB</span>
              </div>
              {errors.contextMaxBytes ? (
                <p className="field-msg field-msg--error" id="context-max-error" role="alert">
                  <AlertIcon />
                  <span>{errors.contextMaxBytes}</span>
                </p>
              ) : (
                <p className="field-help" id="context-max-help">
                  Applies to the whole context block. When the cap bites, categories trim in order: open
                  editors, then instruction documents, then the tree.
                </p>
              )}
            </div>

            {/* Ignore patterns */}
            <div className="field">
              <p className="field-label field-label--row" id="context-exclude-title">
                Ignore patterns
              </p>
              <p className="field-help">
                Extra glob patterns, additive to the built-in ignore set and Files: Exclude / Search: Exclude.
                An excluded path is never read.
              </p>
              <ul className="context-patterns" aria-labelledby="context-exclude-title">
                {CONTEXT_BUILTIN_PATTERNS.map((pattern) => (
                  <li className="context-pattern context-pattern--builtin" key={pattern}>
                    <span className="context-pattern__text">{pattern}</span>
                    <span className="chip chip--scope">Built-in</span>
                  </li>
                ))}
                {draft.contextExclude.length === 0 ? (
                  <li className="context-pattern context-pattern--empty">
                    <span className="context-pattern__text">
                      No extra patterns. The built-in set above still applies.
                    </span>
                  </li>
                ) : (
                  draft.contextExclude.map((pattern, index) => (
                    <li className="context-pattern" key={`${pattern}-${index}`}>
                      <span className="context-pattern__text">{pattern}</span>
                      <button
                        className="icon-btn"
                        type="button"
                        aria-label={`Remove pattern ${pattern}`}
                        onClick={() =>
                          update(
                            'contextExclude',
                            draft.contextExclude.filter((_entry, position) => position !== index)
                          )
                        }
                      >
                        <CrossIcon />
                      </button>
                    </li>
                  ))
                )}
              </ul>
              <label className="field-label" htmlFor="context-new-pattern">
                Add an extra pattern
              </label>
              <div className="field-row">
                <input
                  className="input context-pattern-input"
                  id="context-new-pattern"
                  type="text"
                  value={patternDraft}
                  placeholder="e.g. **/snapshots/**"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setPatternDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addPattern();
                    }
                  }}
                />
                <span className="spacer" />
                <button className="btn" type="button" disabled={!patternDraft.trim()} onClick={addPattern}>
                  Add
                </button>
              </div>
              {errors.contextExclude ? (
                <p className="field-msg field-msg--error" role="alert">
                  <AlertIcon />
                  <span>{errors.contextExclude}</span>
                </p>
              ) : null}
              <p className="field-help">
                Saved to <code className="key">melink.context.exclude</code>, which the snapshot service
                reads. Also honors Files: Exclude and Search: Exclude.
              </p>
            </div>

            {/* Scope note */}
            <div className="field">
              <p className="field-label field-label--row">Scope</p>
              <p className="field-msg">
                <InfoIcon />
                <span>
                  These settings use the scope shown above. The composer can narrow them for a single turn; it
                  never widens them unless you change a setting here.
                </span>
              </p>
            </div>
          </div>
          <p className="panel__foot">Unsaved changes apply to the next turn.</p>
        </section>
        </TabPanel>
      </div>

      <footer className="settings-foot">
        <span className="dirty-note">
          <span className="dirty-dot" aria-hidden="true" />
          {dirty ? 'Changes apply to your next turn.' : 'No unsaved changes.'}
        </span>
        <span className="spacer" />
        <button className="btn" type="button" disabled={!dirty} onClick={resetDraft}>
          Reset
        </button>
        <button className="btn btn--primary" type="button" disabled={!dirty} onClick={save}>
          Save settings
        </button>
      </footer>
    </main>
  );
}

/**
 * One context category row: a checkbox, a name, and a plain-language sentence
 * about what the category means in practice. Kept as one component so all five
 * rows share the same structure and focus behaviour.
 */
function ContextCategory({
  id,
  name,
  description,
  checked,
  onChange
}: {
  id?: string;
  name: string;
  description: string;
  checked: boolean;
  /** Absent for a category whose control lives in its own region below. */
  onChange?: (value: boolean) => void;
}): JSX.Element {
  // A read-only row states what is sent without offering a second control for a
  // setting that already has one: two checkboxes for one flag could desync.
  if (!onChange || !id) {
    return (
      <li className="context-category context-category--static">
        <span className={`context-mark ${checked ? 'context-mark--on' : 'context-mark--off'}`} aria-hidden="true">
          {checked ? <CheckIcon /> : <CrossIcon />}
        </span>
        <span className="check-body">
          <span className="check-label">{name}</span>
          <span className="check-text">{description}</span>
        </span>
      </li>
    );
  }
  return (
    <li className="context-category">
      <label className="check" htmlFor={id}>
        <input
          className="check-input"
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="check-box" aria-hidden="true">
          <CheckIcon />
        </span>
        <span className="check-body">
          <span className="check-label">{name}</span>
          <span className="check-text">{description}</span>
        </span>
      </label>
    </li>
  );
}

/** One plain sentence for an install or update. Terminal color and progress bars are stripped. */
function CliResult({ ok, message }: { ok?: boolean; message: string }): JSX.Element {
  const text = summarizeOpencodeCliOutput(message, ok === false ? 1 : 0);
  return (
    <p className={`runtime-result ${ok ? 'runtime-result--ok' : 'runtime-result--error'}`} role="status">
      {ok ? <CheckIcon /> : <AlertIcon />}
      <span>{text}</span>
    </p>
  );
}

/** The Test connection result strip; plain language, never a raw error. */
function TestResult({
  backendLabel,
  test,
  onRetry
}: {
  backendLabel: string;
  test: { pending: boolean; result?: ConnectionTestResult };
  onRetry: () => void;
}): JSX.Element | null {
  if (test.pending) {
    return (
      <div className="test-result test-result--pending" role="status">
        <span className="spinner" aria-hidden="true" />
        <div className="test-body">
          <div className="test-title">Testing {backendLabel}</div>
          <div className="test-text">Sending a small authenticated request. This can take a few seconds.</div>
        </div>
      </div>
    );
  }
  const result = test.result;
  if (!result) {
    return null;
  }
  const ok = result.outcome === 'ok';
  return (
    <div
      className={`test-result ${ok ? 'test-result--ok' : 'test-result--error'}`}
      role={ok ? 'status' : 'alert'}
    >
      {ok ? <CheckIcon /> : <AlertIcon />}
      <div className="test-body">
        <div className="test-title">
          {ok ? `Connected to ${backendLabel}` : `Test failed - ${outcomeLabel(result.outcome)}`}
        </div>
        <div className="test-text">{result.message}</div>
        {!ok ? (
          <div className="test-actions">
            <button className="btn" type="button" onClick={onRetry}>
              Test connection
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function outcomeLabel(outcome: ConnectionTestResult['outcome']): string {
  switch (outcome) {
    case 'invalid-key':
      return 'invalid API key';
    case 'host':
      return 'host unreachable';
    case 'network':
      return 'network problem';
    case 'unavailable':
      return 'provider unavailable';
    default:
      return 'request refused';
  }
}

function RefreshIconInline(): JSX.Element {
  return (
    <svg className="ico ico--xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-1.6 5" />
      <path d="M20 5v6h-6" />
    </svg>
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function flattenModels(models: Record<string, BackendModel[]>): Array<BackendModel & { backendId: string }> {
  return Object.entries(models).flatMap(([backendId, list]) =>
    list.map((model) => ({ ...model, backendId }))
  );
}

function ollamaLabel(settings: SettingsSnapshot): string {
  return settings.ollama.status === 'available' ? 'Ollama Cloud' : 'Ollama Cloud';
}

function codexLabel(settings: SettingsSnapshot): string {
  if (settings.codex.status === 'unavailable') {
    return 'Codex (not installed)';
  }
  if (settings.codex.status === 'incompatible') {
    return 'Codex (protocol mismatch)';
  }
  if (settings.codex.status === 'auth-mismatch') {
    return 'Codex (wrong sign-in)';
  }
  return 'Codex';
}

function codexAuthLabel(settings: SettingsSnapshot): string {
  if (settings.codex.status === 'available') {
    return 'Signed in';
  }
  if (settings.codex.status === 'unavailable') {
    return 'Not installed';
  }
  if (settings.codex.status === 'incompatible') {
    return 'Incompatible';
  }
  if (settings.codex.status === 'auth-mismatch') {
    return 'API key, not ChatGPT';
  }
  return 'Signed out';
}

function codexAuthDetail(settings: SettingsSnapshot): string {
  if (settings.codex.status === 'available') {
    return settings.codex.detail ?? 'Signed in. Codex models are ready.';
  }
  if (settings.codex.status === 'unavailable') {
    return 'Not installed or not on PATH. Set the CLI path above, then test again.';
  }
  if (settings.codex.status === 'incompatible') {
    return (
      settings.codex.detail ??
      'The Codex CLI is installed but its protocol version is not supported. Update the CLI, or update the extension (its pinned protocol bindings), then test again.'
    );
  }
  if (settings.codex.status === 'auth-mismatch') {
    return (
      settings.codex.detail ??
      'Codex is signed in with an API key, not the ChatGPT login. Run the Codex CLI sign-in with the ChatGPT option and remove any API-key setting from the environment.'
    );
  }
  return 'Not signed in. Codex models stay hidden until the CLI sign-in succeeds.';
}

