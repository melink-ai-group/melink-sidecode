import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { THINKING_LEVELS } from '../backends/types';
import type { SettingsPatch, SettingsSnapshot } from '../protocol';
import { formatDictationTarget } from '../dictation/target';
import { AlertIcon, BackIcon, CheckIcon, CrossIcon, InfoIcon } from './Icons';
import { opencodeRuntimeView } from './runtimeStatus';
import { contextPatternError } from '../context/contextSettings';
import { executablePathError, resolveExecutableCommand } from '../backends/executables.ts';
import { isSubmitEnter } from './keys';
import { noticeForField } from '../config/fieldNotices.ts';
import { TabList, TabPanel, type TabItem } from './Tabs';
import { CONTEXT_BUILTIN_PATTERNS } from './settings/constants';
import type { SettingsScreenProps } from './settings/types';
import { draftFrom, type Draft } from './settings/draft';
import {
  codexAuthDetail,
  codexAuthLabel,
  codexLabel,
  flattenModels,
  isHttpUrl,
  ollamaLabel
} from './settings/labels';
import {
  CliResult,
  ContextCategory,
  FieldTip,
  RefreshIconInline,
  TestResult
} from './settings/primitives';

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

export function SettingsScreen({
  settings,
  connectionTest,
  onBack,
  onSave,
  onSaveToken,
  onClearToken,
  onSaveZenToken,
  onClearZenToken,
  onTestConnection,
  settingsProvider,
  codexVersionCheck,
  onValidateCodexVersion,
  opencodeUpgrade,
  onUpgradeOpencode,
  opencodeInstall,
  onInstallOpencode,
  zvecGrep,
  onSetZvecGrep,
  astGrep,
  onSetAstGrep,
  astGrepInstall,
  onInstallAstGrep,
  onUpgradeAstGrep,
  zvecGrepInstall,
  onInstallZvecGrep
}: SettingsScreenProps): JSX.Element {
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [errors, setErrors] = useState<Partial<Record<keyof SettingsPatch, string>>>({});
  const [notices, setNotices] = useState<Partial<Record<keyof SettingsPatch, string>>>({});
  const [token, setToken] = useState('');
  const [tokenSaved, setTokenSaved] = useState(false);
  const [zenToken, setZenToken] = useState('');
  const [zenTokenSaved, setZenTokenSaved] = useState(false);
  // The pattern being typed; it only joins the draft list on Add or Enter, so a
  // half-typed pattern is never validated or saved mid-keystroke.
  const [patternDraft, setPatternDraft] = useState('');
  // Gates the `unrestricted` default behind a labelled confirmation, so it can
  // never be enabled as a side effect of another change.
  const [permissionConfirm, setPermissionConfirm] = useState(false);
  // The visible settings section. Switching tabs never touches the draft, so an
  // unsaved edit in another section survives.
  const [tab, setTab] = useState<'cli' | 'providers' | 'defaults' | 'context' | 'skills'>('cli');
  // Ollama, OpenCode Zen, and Codex are separate pages inside Providers. The
  // choice is view state only; it does not touch the draft.
  const [providerTab, setProviderTab] = useState<'provider-ollama' | 'provider-opencode' | 'provider-codex'>(
    settingsProvider === 'codex' ? 'provider-codex' : 'provider-ollama'
  );
  const [skillTab, setSkillTab] = useState<'skill-browser' | 'skill-ast-grep' | 'skill-zvec-grep'>('skill-browser');
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
    setNotices(settings.saveNotices ?? {});
  }, [settings]);

  // A successful local install writes a new absolute path on the host. Adopt it
  // in the draft when the draft source is local.
  useEffect(() => {
    const installedPath = opencodeInstall?.ok ? opencodeInstall.path : undefined;
    if (!installedPath) {
      return;
    }
    setDraft((current) =>
      current &&
      current.opencodeCliSource === 'local' &&
      current.opencodePath !== installedPath
        ? { ...current, opencodePath: installedPath }
        : current
    );
  }, [opencodeInstall]);

  useEffect(() => {
    backRef.current?.focus();
  }, []);

  useEffect(() => {
    if (settingsProvider === 'codex') {
      setProviderTab('provider-codex');
    }
  }, [settingsProvider]);

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
      draft.opencodeDefaultModel !== settings.opencodeZen.defaultModel ||
      draft.codexPath !== settings.codex.path ||
      draft.codexDefaultModel !== settings.codex.defaultModel ||
      draft.permissionLevel !== settings.defaults.permissionLevel ||
      draft.mode !== settings.defaults.mode ||
      draft.thinking !== (settings.defaults.thinking ?? '') ||
      draft.dictationModel !== formatDictationTarget(settings.defaults.dictationModel) ||
      draft.opencodeEnabled !== settings.opencode.enabled ||
      draft.opencodeCliSource !== settings.opencode.cliSource ||
      draft.opencodePath !== settings.opencode.local.path ||
      draft.browserCodex !== settings.skills.browserCodex ||
      draft.browserOpencode !== settings.skills.browserOpencode ||
      draft.zvecGrepCliSource !== settings.skills.zvecGrep.cliSource ||
      draft.zvecGrepPath !== settings.skills.zvecGrep.local.path ||
      draft.astGrepCliSource !== settings.skills.astGrep.cliSource ||
      draft.astGrepPath !== settings.skills.astGrep.local.path ||
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
    setNotices({});
    setToken('');
    setTokenSaved(false);
    setZenToken('');
    setZenTokenSaved(false);
    setPatternDraft('');
  };

  // Validate locally, then hand the host only valid fields. An invalid value is
  // never sent, so it can never be persisted. Primary Save writes user settings;
  // Save to workspace is offered only when workspace overrides already exist.
  const save = (target: 'global' | 'workspace' = 'global'): void => {
    if (!draft) {
      return;
    }
    const nextErrors: Partial<Record<keyof SettingsPatch, string>> = {};
    if (!isHttpUrl(draft.ollamaBaseUrl)) {
      nextErrors.ollamaBaseUrl = 'Enter a full URL, like https://ollama.com. This value was not saved.';
    }
    if (!draft.codexPath.trim()) {
      nextErrors.codexPath = 'Enter the CLI path or name. This value was not saved.';
    } else {
      // A relative path would run a file from the workspace — with a
      // separator, or in the Windows drive-relative form.
      const codexResolved = resolveExecutableCommand(draft.codexPath, 'codex');
      if (!codexResolved.ok) {
        nextErrors.codexPath = executablePathError(codexResolved.reason, 'Codex CLI');
      }
    }
    // The path is only meaningful for a local CLI.
    if (draft.opencodeCliSource === 'local' && !draft.opencodePath.trim()) {
      nextErrors.opencodePath = 'Enter the opencode CLI path or name. This value was not saved.';
    } else if (draft.opencodeCliSource === 'local') {
      const opencodeResolved = resolveExecutableCommand(draft.opencodePath, 'opencode');
      if (!opencodeResolved.ok) {
        nextErrors.opencodePath = executablePathError(opencodeResolved.reason, 'opencode CLI');
      }
    }
    // The skill CLI paths follow the same rule: a relative path would run a
    // file from the workspace.
    if (draft.zvecGrepCliSource === 'local' && draft.zvecGrepPath.trim()) {
      const zvecResolved = resolveExecutableCommand(draft.zvecGrepPath, 'zg');
      if (!zvecResolved.ok) {
        nextErrors.zvecGrepPath = executablePathError(zvecResolved.reason, 'zg CLI');
      }
    }
    if (draft.astGrepCliSource === 'local' && draft.astGrepPath.trim()) {
      const astResolved = resolveExecutableCommand(draft.astGrepPath, 'ast-grep');
      if (!astResolved.ok) {
        nextErrors.astGrepPath = executablePathError(astResolved.reason, 'ast-grep CLI');
      }
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
    onSave(
      {
        ollamaBaseUrl: draft.ollamaBaseUrl.trim(),
        ollamaDefaultModel: draft.ollamaDefaultModel.trim(),
        opencodeDefaultModel: draft.opencodeDefaultModel.trim(),
        codexPath: draft.codexPath.trim(),
        codexDefaultModel: draft.codexDefaultModel.trim(),
        permissionLevel: draft.permissionLevel,
        mode: draft.mode,
        thinking: draft.thinking,
        dictationModel: draft.dictationModel.trim(),
        opencodeEnabled: draft.opencodeEnabled,
        opencodeCliSource: draft.opencodeCliSource,
        // Local path only: bundled ignores it for spawns, so a bundled selection
        // must not write an empty path over a previously stored valid one.
        ...(draft.opencodeCliSource === 'local' ? { opencodePath: draft.opencodePath.trim() } : {}),
        browserCodex: draft.browserCodex,
        browserOpencode: draft.browserOpencode,
        zvecGrepCliSource: draft.zvecGrepCliSource,
        ...(draft.zvecGrepCliSource === 'local' ? { zvecGrepPath: draft.zvecGrepPath.trim() } : {}),
        astGrepCliSource: draft.astGrepCliSource,
        ...(draft.astGrepCliSource === 'local' ? { astGrepPath: draft.astGrepPath.trim() } : {}),
        contextIncludeInstructions: draft.contextIncludeInstructions,
        contextIncludeShape: draft.contextIncludeShape,
        contextIncludeEditorState: draft.contextIncludeEditorState,
        contextIncludeSelection: draft.contextIncludeSelection,
        contextIncludeChangedFiles: draft.contextIncludeChangedFiles,
        contextMaxBytes: maxKb * 1024,
        contextExclude: draft.contextExclude.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0)
      },
      target
    );
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

  const saveZenToken = (): void => {
    const value = zenToken.trim();
    if (!value) {
      return;
    }
    onSaveZenToken(value);
    setZenToken('');
    setZenTokenSaved(true);
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
  const opencodeStatus = connectionTest?.backendId === 'opencode' ? connectionTest : undefined;
  const codexStatus = connectionTest?.backendId === 'codex' ? connectionTest : undefined;
  // The host's notice map, read through one accessor. The host is the
  // authority on which fields were redirected, so the screen adds nothing of
  // its own: it renders the notice the host echoed, or nothing.
  const noticeFor = (field: keyof SettingsPatch): string | undefined => noticeForField(field, notices);
  const modelOptions = flattenModels(settings.models);
  const runtimeView = opencodeRuntimeView(settings.opencode, {
    enabled: draft.opencodeEnabled,
    source: draft.opencodeCliSource
  });
  const draftCliAction = {
    cliSource: draft.opencodeCliSource,
    path: draft.opencodePath
  };
  const draftProbe =
    draft.opencodeCliSource === 'bundled' ? settings.opencode.bundled : settings.opencode.local;
  const zvecChecked = zvecGrep?.pending
    ? zvecGrep.requested === true
    : settings.skills.zvecGrep.connected;
  const zvecStatus = zvecGrep?.pending
    ? zvecGrep.requested
      ? 'Installing zvec-grep and connecting it to OpenCode.'
      : 'Disconnecting zvec-grep from OpenCode.'
    : settings.skills.zvecGrep.connected
      ? 'Connected. A new OpenCode session uses it.'
      : settings.skills.zvecGrep.cli === 'installed'
        ? 'Installed. Turning this on connects it to OpenCode.'
        : 'Not installed. Turning this on installs it and connects it to OpenCode.';
  const astChecked = astGrep?.pending
    ? astGrep.requested === true
    : settings.skills.astGrep.connected;
  const astStatus = astGrep?.pending
    ? astGrep.requested
      ? 'Installing ast-grep and connecting it to OpenCode.'
      : 'Disconnecting ast-grep from OpenCode.'
    : settings.skills.astGrep.connected
      ? 'Connected. A new OpenCode session uses it.'
      : settings.skills.astGrep.cli === 'installed'
        ? 'Installed. Turning this on connects it to OpenCode.'
        : 'Not installed. Install the CLI, then turn this on.';
  const zvecCliDraft = { cliSource: draft.zvecGrepCliSource, path: draft.zvecGrepPath };
  const astCliDraft = { cliSource: draft.astGrepCliSource, path: draft.astGrepPath };
  // A refused skill path is reported by the host on the toggle that carried
  // it, so the message lands on the path field rather than only in the
  // result strip. A save refusal wins over it: the save is the later word.
  const zvecPathError =
    errors.zvecGrepPath ?? (zvecGrep?.field === 'zvecGrepPath' ? zvecGrep.fieldMessage : undefined);
  const astPathError =
    errors.astGrepPath ?? (astGrep?.field === 'astGrepPath' ? astGrep.fieldMessage : undefined);
  const zvecProbe =
    draft.zvecGrepCliSource === 'bundled' ? settings.skills.zvecGrep.bundled : settings.skills.zvecGrep.local;
  const astProbe =
    draft.astGrepCliSource === 'bundled' ? settings.skills.astGrep.bundled : settings.skills.astGrep.local;
  const browserSkillChip = settings.skills.browserError
    ? 'Launch issue'
    : draft.browserCodex || draft.browserOpencode
      ? 'Enabled'
      : 'Off';
  const astSkillChip = astGrep?.pending
    ? 'Working…'
    : settings.skills.astGrep.connected
      ? 'Connected'
      : astProbe.status === 'detected'
        ? 'Installed'
        : astProbe.status === 'not-runnable'
          ? 'Not runnable'
          : 'Not installed';
  const zvecSkillChip = zvecGrep?.pending
    ? 'Working…'
    : settings.skills.zvecGrep.connected
      ? 'Connected'
      : zvecProbe.status === 'detected'
        ? 'Installed'
        : zvecProbe.status === 'not-runnable'
          ? 'Not runnable'
          : 'Not installed';
  const tabs: readonly TabItem[] = [
    { id: 'cli', label: 'CLI' },
    { id: 'providers', label: 'Providers' },
    { id: 'defaults', label: 'Defaults' },
    { id: 'context', label: 'Context' },
    { id: 'skills', label: 'Skills' }
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

        {/* ---------- CLI ---------- */}
        <TabPanel id="cli" active={tab}>
        <section className="panel panel--fill" aria-labelledby="cli-title">
          <div className="panel__head" id="cli-title">
            <span>CLI</span>
            <span className="spacer" />
            <span className="panel__note">Shared OpenCode binary for Ollama turns and OpenCode Zen</span>
          </div>
          <div className="panel__body">
            <div className="field">
              <p className="field-help">
                OpenCode Zen and the optional Ollama agentic runtime both use this CLI. Choose local or
                bundled, then install or update. The selection is what Test connection and model refresh use.
              </p>
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
                  <span className="check-text">
                    Applies from the next turn. OpenCode Zen still uses this CLI when the box is off.
                  </span>
                </span>
              </label>

              <label className="field-label" htmlFor="opencode-cli-source">
                opencode CLI source
              </label>
              <select
                className="select"
                id="opencode-cli-source"
                value={draft.opencodeCliSource}
                aria-describedby="opencode-cli-source-help"
                onChange={(event) =>
                  update('opencodeCliSource', event.target.value === 'bundled' ? 'bundled' : 'local')
                }
              >
                <option value="local">Local machine</option>
                <option value="bundled">Bundled (extension storage)</option>
              </select>
              <p className="field-help" id="opencode-cli-source-help">
                {draft.opencodeCliSource === 'bundled'
                  ? 'Install downloads into extension global storage so the binary survives closing VS Code. Every turn uses that binary, not PATH.'
                  : 'Use the path below or PATH. Install and Update use this selection immediately.'}
              </p>
              <ScopeNotice id="opencode-cli-source-notice" notice={noticeFor('opencodeCliSource')} />

              {draft.opencodeCliSource === 'local' ? (
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
                    aria-describedby={
                      errors.opencodePath ? 'opencode-path-error' : 'opencode-path-help opencode-status'
                    }
                    onChange={(event) => update('opencodePath', event.target.value)}
                  />
                  {errors.opencodePath ? (
                    <p className="field-msg field-msg--error" id="opencode-path-error" role="alert">
                      <AlertIcon />
                      <span>{errors.opencodePath}</span>
                    </p>
                  ) : noticeFor('opencodePath') ? (
                    <p className="field-msg field-msg--notice" id="opencode-path-notice" role="status">
                      <InfoIcon />
                      <span>{noticeFor('opencodePath')}</span>
                    </p>
                  ) : null}
                  <p className="field-help" id="opencode-path-help">
                    Path to the opencode CLI. A bare name is resolved from PATH. This setting is read from your
                    user settings only, so a workspace cannot choose the binary that runs.
                  </p>
                </>
              ) : (
                <p className="field-help" id="opencode-bundled-path">
                  Bundled path: <code>{settings.opencode.bundled.path}</code>
                </p>
              )}

              <p
                className={`runtime-status runtime-status--${runtimeView.tone}`}
                id="opencode-status"
                role="status"
              >
                <span className="runtime-dot" aria-hidden="true" />
                <span>{runtimeView.label}</span>
                {runtimeView.version ? <span className="runtime-version">{runtimeView.version}</span> : null}
              </p>

              <div className="runtime-actions">
                {draftProbe.status === 'detected' ? (
                  <>
                    <button
                      className="btn btn--secondary"
                      type="button"
                      disabled={opencodeUpgrade?.pending}
                      onClick={() => onUpgradeOpencode(draftCliAction)}
                    >
                      {opencodeUpgrade?.pending
                        ? 'Updating...'
                        : draft.opencodeCliSource === 'bundled'
                          ? 'Update bundled opencode'
                          : 'Update opencode'}
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
                      onClick={() => onInstallOpencode(draftCliAction)}
                    >
                      {opencodeInstall?.pending
                        ? 'Installing...'
                        : draft.opencodeCliSource === 'bundled'
                          ? 'Install bundled opencode'
                          : 'Install opencode'}
                    </button>
                    {opencodeInstall && !opencodeInstall.pending && opencodeInstall.message ? (
                      <CliResult ok={opencodeInstall.ok} message={opencodeInstall.message} />
                    ) : null}
                  </>
                )}
              </div>
            </div>
          </div>
          <p className="panel__foot">Save the CLI source so OpenCode Zen model checks use it after a restart.</p>
        </section>
        </TabPanel>

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
              { id: 'provider-opencode', label: 'OpenCode' },
              { id: 'provider-codex', label: 'Codex' }
            ]}
            active={providerTab}
            onChange={(id) =>
              setProviderTab(id as 'provider-ollama' | 'provider-opencode' | 'provider-codex')
            }
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
              ) : noticeFor('ollamaBaseUrl') ? (
                <p className="field-msg field-msg--notice" id="ollama-base-url-notice" role="status">
                  <InfoIcon />
                  <span>{noticeFor('ollamaBaseUrl')}</span>
                </p>
              ) : (
                <p className="field-help" id="ollama-base-url-help">
                  Where Ollama Cloud requests are sent. The key below is sent to this host. This setting is read
                  from your user settings only, so a workspace cannot redirect the key.
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
                    if (isSubmitEnter(event)) {
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
          </TabPanel>

          <TabPanel id="provider-opencode" active={providerTab} className="tabpanel--inline">
            <div className="field">
              <div className="field__head">
                <span className="provider-badge provider-badge--opencode">
                  <span className="provider-dot provider-dot--opencode" aria-hidden="true" />
                  <span className="provider-name">OpenCode Zen</span>
                </span>
                <span className="spacer" />
                <span className={`chip ${settings.opencodeZen.hasToken ? 'chip--stored' : 'chip--missing'}`}>
                  {settings.opencodeZen.hasToken ? 'Key stored' : 'Free models'}
                </span>
              </div>
              <p className="field-help">
                Free OpenCode models work without a key. Add a Zen API key to unlock paid models. Turns and
                connection tests use the CLI selected under Settings → CLI (local or bundled).
              </p>

              <label className="field-label" htmlFor="opencode-default-model">
                Default model
              </label>
              <select
                className="select"
                id="opencode-default-model"
                value={draft.opencodeDefaultModel}
                onChange={(event) => update('opencodeDefaultModel', event.target.value)}
              >
                <option value="">First free model reported by the provider</option>
                {modelOptions
                  .filter((option) => option.backendId === 'opencode')
                  .map((option) => (
                    <option value={option.id} key={option.id}>
                      {option.free ? `${option.label} (Free)` : option.label}
                    </option>
                  ))}
              </select>
              <p className="field-help">
                Used for a new conversation. Switching the model in the header overrides it for that conversation.
              </p>

              <label className="field-label" htmlFor="opencode-zen-api-key">
                Zen API key (optional)
              </label>
              <div className="secret-row">
                <input
                  className="input secret-input"
                  id="opencode-zen-api-key"
                  type="password"
                  value={zenToken}
                  placeholder={settings.opencodeZen.hasToken ? '••••••••••••••••' : ''}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby="opencode-zen-key-state"
                  onChange={(event) => {
                    setZenToken(event.target.value);
                    setZenTokenSaved(false);
                  }}
                  onKeyDown={(event) => {
                    if (isSubmitEnter(event)) {
                      event.preventDefault();
                      saveZenToken();
                    }
                  }}
                />
              </div>
              <p className="field-msg" id="opencode-zen-key-state">
                {settings.opencodeZen.hasToken ? (
                  <>
                    <span className="stored-dot" aria-hidden="true" />
                    <span>
                      {zenTokenSaved
                        ? 'Key saved. The stored value is never shown back.'
                        : 'A key is stored. Enter a new key to replace it, or clear it.'}
                    </span>
                  </>
                ) : (
                  <span>
                    {zenTokenSaved
                      ? 'Key saved.'
                      : 'No key stored. Free models are available; add a key for paid models.'}
                  </span>
                )}
              </p>

              <div className="field-row">
                <button className="btn" type="button" disabled={!zenToken.trim()} onClick={saveZenToken}>
                  Save key
                </button>
                <button
                  className="btn btn--danger"
                  type="button"
                  disabled={!settings.opencodeZen.hasToken}
                  onClick={() => {
                    onClearZenToken();
                    setZenToken('');
                    setZenTokenSaved(false);
                  }}
                >
                  Clear key
                </button>
                <span className="spacer" />
                <button
                  className="btn"
                  type="button"
                  disabled={opencodeStatus?.pending}
                  onClick={() => onTestConnection('opencode', draftCliAction)}
                >
                  <RefreshIconInline />
                  {opencodeStatus?.pending ? 'Checking…' : 'Check models'}
                </button>
              </div>
              <p className="field-help">
                Check models probes the CLI selected under Settings → CLI (
                {draft.opencodeCliSource === 'bundled' ? 'bundled' : 'local'}) and refreshes the Zen catalog.
              </p>
              {opencodeStatus?.result ? (
                <p
                  className={`field-msg ${opencodeStatus.result.outcome === 'ok' ? 'field-msg--ok' : 'field-msg--error'}`}
                  role="status"
                >
                  {opencodeStatus.result.outcome === 'ok' ? <CheckIcon /> : <AlertIcon />}
                  <span>{opencodeStatus.result.message}</span>
                </p>
              ) : settings.opencodeZen.detail ? (
                <p className="field-help">{settings.opencodeZen.detail}</p>
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
              ) : noticeFor('codexPath') ? (
                <p className="field-msg field-msg--notice" id="codex-path-notice" role="status">
                  <InfoIcon />
                  <span>{noticeFor('codexPath')}</span>
                </p>
              ) : (
                <p className="field-help" id="codex-path-help">
                  Path to the Codex CLI. A bare name is resolved from PATH. This setting is read from your user
                  settings only, so a workspace cannot choose the binary that runs.
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
                {settings.codex.status === 'incompatible' ? (
                  <button
                    className="btn"
                    type="button"
                    disabled={codexVersionCheck?.pending}
                    onClick={onValidateCodexVersion}
                  >
                    {codexVersionCheck?.pending ? 'Validating...' : 'Validate version'}
                  </button>
                ) : null}
              </div>
              {settings.codex.status === 'incompatible' ? (
                <p className="field-help">
                  Checks this CLI against the protocol SideCode uses. A version that passes is allowed.
                </p>
              ) : null}
              {codexVersionCheck && !codexVersionCheck.pending && codexVersionCheck.message ? (
                <div
                  className={`test-result ${codexVersionCheck.ok ? 'test-result--ok' : 'test-result--error'}`}
                  role={codexVersionCheck.ok ? 'status' : 'alert'}
                >
                  {codexVersionCheck.ok ? <CheckIcon /> : <AlertIcon />}
                  <div className="test-body">
                    <div className="test-title">
                      {codexVersionCheck.ok ? 'Version allowed' : 'Version still unsupported'}
                    </div>
                    <div className="test-text">{codexVersionCheck.message}</div>
                  </div>
                </div>
              ) : null}

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
                How much the agent may do without asking. A per-conversation choice overrides it. Read from your
                user settings only, so a workspace cannot raise the default.
              </p>
              {noticeFor('permissionLevel') ? (
                <p className="field-msg field-msg--notice" id="default-permission-notice" role="status">
                  <InfoIcon />
                  <span>{noticeFor('permissionLevel')}</span>
                </p>
              ) : null}
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
                    if (isSubmitEnter(event)) {
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

        {/* ---------- Skills ---------- */}
        <TabPanel id="skills" active={tab}>
        <section className="panel panel--fill" aria-labelledby="skills-title">
          <div className="panel__head" id="skills-title">
            <span>Skills</span>
            <span className="spacer" />
            <span className="panel__note">Extra tools the agent can use</span>
          </div>
          <TabList
            className="tablist--nested"
            label="Skill"
            tabs={[
              { id: 'skill-browser', label: 'Browser' },
              { id: 'skill-ast-grep', label: 'ast-grep' },
              { id: 'skill-zvec-grep', label: 'zvec-grep' }
            ]}
            active={skillTab}
            onChange={(id) => setSkillTab(id as typeof skillTab)}
          />

          <TabPanel id="skill-browser" active={skillTab} className="tabpanel--inline">
            <div className="field">
              <div className="field__head">
                <span className="provider-name">Browser control</span>
                <span className="spacer" />
                <span
                  className={`chip ${
                    settings.skills.browserError
                      ? 'chip--missing'
                      : draft.browserCodex || draft.browserOpencode
                        ? 'chip--stored'
                        : 'chip--missing'
                  }`}
                >
                  {browserSkillChip}
                </span>
              </div>
              <p className="field-help">
                Turn on per provider. When off, that provider gets no browser tools and no browser is started.
                Uses installed Edge or Chrome. On by default; a new conversation picks up the change.
              </p>
              <ul className="context-list">
                <ContextCategory
                  id="skill-browser-codex"
                  name="Codex"
                  description="Open the app in an editor tab and check layout."
                  checked={draft.browserCodex}
                  onChange={(value) => update('browserCodex', value)}
                />
                <ContextCategory
                  id="skill-browser-opencode"
                  name="OpenCode"
                  description="Same for Ollama agentic runtime and OpenCode Zen."
                  checked={draft.browserOpencode}
                  onChange={(value) => update('browserOpencode', value)}
                />
              </ul>
              {settings.skills.browserError ? (
                <p className="field-msg field-msg--error" role="alert">
                  <AlertIcon />
                  <span>{settings.skills.browserError}</span>
                </p>
              ) : null}
            </div>
          </TabPanel>

          <TabPanel id="skill-ast-grep" active={skillTab} className="tabpanel--inline">
            <div className="field">
              <div className="field__head">
                <span className="provider-name">ast-grep</span>
                <span className="spacer" />
                <span
                  className={`chip ${
                    settings.skills.astGrep.connected
                      ? 'chip--stored'
                      : astProbe.status === 'detected'
                        ? 'chip--signedin'
                        : 'chip--missing'
                  }`}
                >
                  {astSkillChip}
                </span>
                <FieldTip
                  label="About ast-grep"
                  text="Syntax-aware code search and rewrite, bundled with the app. Agents find and refactor by AST pattern instead of fragile text matching. Enabling updates your user OpenCode config and SideCode turns; a new session picks it up."
                />
              </div>
              <p className="field-help">
                Structural search exposed as an MCP tool. Install or update the CLI, then connect it to OpenCode.
              </p>

              <label className="field-label" htmlFor="ast-grep-cli-source">
                CLI source
              </label>
              <select
                className="select"
                id="ast-grep-cli-source"
                value={draft.astGrepCliSource}
                aria-describedby="ast-grep-cli-source-help"
                onChange={(event) =>
                  update('astGrepCliSource', event.target.value === 'bundled' ? 'bundled' : 'local')
                }
              >
                <option value="local">Local machine</option>
                <option value="bundled">Bundled (extension storage)</option>
              </select>
              <p className="field-help" id="ast-grep-cli-source-help">
                {draft.astGrepCliSource === 'bundled'
                  ? 'Install downloads into extension storage. Turns use that binary, not PATH.'
                  : 'Use the path below or PATH. Install and Update use this selection immediately.'}
              </p>
              <ScopeNotice id="ast-grep-cli-source-notice" notice={noticeFor('astGrepCliSource')} />

              {draft.astGrepCliSource === 'local' ? (
                <>
                  <label className="field-label" htmlFor="ast-grep-path">
                    ast-grep path
                  </label>
                  <input
                    className="input"
                    id="ast-grep-path"
                    type="text"
                    value={draft.astGrepPath}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={astPathError ? true : undefined}
                    aria-describedby={astPathError ? 'ast-grep-path-error' : undefined}
                    onChange={(event) => update('astGrepPath', event.target.value)}
                  />
                  {astPathError ? (
                    <p className="field-msg field-msg--error" id="ast-grep-path-error" role="alert">
                      <AlertIcon />
                      <span>{astPathError}</span>
                    </p>
                  ) : (
                    <ScopeNotice id="ast-grep-path-notice" notice={noticeFor('astGrepPath')} />
                  )}
                </>
              ) : (
                <p className="field-help skill-path" title={settings.skills.astGrep.bundled.path}>
                  Bundled path
                  <FieldTip label="Bundled ast-grep path" text={settings.skills.astGrep.bundled.path} />
                </p>
              )}

              <p
                className={`runtime-status runtime-status--${
                  astProbe.status === 'detected'
                    ? 'detected'
                    : astProbe.status === 'not-runnable'
                      ? 'not-runnable'
                      : 'missing'
                }`}
                role="status"
              >
                <span className="runtime-dot" aria-hidden="true" />
                <span>
                  {astProbe.status === 'detected'
                    ? 'Detected'
                    : astProbe.status === 'not-runnable'
                      ? 'Installed but not runnable'
                      : 'Not installed'}
                </span>
                {astProbe.status === 'detected' && astProbe.version ? (
                  <span className="runtime-version">{astProbe.version}</span>
                ) : null}
              </p>

              <div className="runtime-actions">
                <button
                  className="btn btn--secondary"
                  type="button"
                  disabled={astGrepInstall?.pending}
                  onClick={() =>
                    astProbe.status === 'detected'
                      ? onUpgradeAstGrep(astCliDraft)
                      : onInstallAstGrep(astCliDraft)
                  }
                >
                  {astGrepInstall?.pending
                    ? 'Working…'
                    : astProbe.status === 'detected'
                      ? draft.astGrepCliSource === 'bundled'
                        ? 'Update bundled ast-grep'
                        : 'Update ast-grep'
                      : draft.astGrepCliSource === 'bundled'
                        ? 'Install bundled ast-grep'
                        : 'Install ast-grep'}
                </button>
                {astGrepInstall && !astGrepInstall.pending && astGrepInstall.message ? (
                  <CliResult ok={astGrepInstall.ok} message={astGrepInstall.message} />
                ) : null}
              </div>

              <div className="skill-check-row">
                <label className="check" htmlFor="ast-grep-enabled">
                  <input
                    className="check-input"
                    id="ast-grep-enabled"
                    type="checkbox"
                    checked={astChecked}
                    disabled={astGrep?.pending}
                    aria-describedby="ast-grep-status"
                    onChange={(event) => onSetAstGrep(event.target.checked, astCliDraft)}
                  />
                  <span className="check-box" aria-hidden="true">
                    <CheckIcon />
                  </span>
                  <span className="check-body">
                    <span className="check-label">Use structural search</span>
                  </span>
                </label>
                <FieldTip
                  label="About structural search"
                  text="Updates your user OpenCode config and SideCode turns. A new session picks it up."
                />
              </div>
              <p className="field-help" id="ast-grep-status">
                {astStatus}
              </p>
              {astGrep && !astGrep.pending && astGrep.message ? (
                <CliResult ok={astGrep.ok} message={astGrep.message} />
              ) : null}
            </div>
          </TabPanel>

          <TabPanel id="skill-zvec-grep" active={skillTab} className="tabpanel--inline">
            <div className="field">
              <div className="field__head">
                <span className="provider-name">zvec-grep</span>
                <span className="spacer" />
                <span
                  className={`chip ${
                    settings.skills.zvecGrep.connected
                      ? 'chip--stored'
                      : zvecProbe.status === 'detected'
                        ? 'chip--signedin'
                        : 'chip--missing'
                  }`}
                >
                  {zvecSkillChip}
                </span>
                <FieldTip
                  label="About zvec-grep"
                  text="Local semantic, keyword, and ripgrep search, bundled with the app and exposed as an MCP tool. Returns ranked, source-linked snippets so agents read fewer files. Enabling updates your user OpenCode config and SideCode turns; a new session picks it up."
                />
              </div>
              <p className="field-help">
                Semantic search exposed as an MCP tool. Install or update the CLI, then connect it to OpenCode.
              </p>

              <label className="field-label" htmlFor="zvec-grep-cli-source">
                CLI source
              </label>
              <select
                className="select"
                id="zvec-grep-cli-source"
                value={draft.zvecGrepCliSource}
                aria-describedby="zvec-grep-cli-source-help"
                onChange={(event) =>
                  update('zvecGrepCliSource', event.target.value === 'bundled' ? 'bundled' : 'local')
                }
              >
                <option value="local">Local machine</option>
                <option value="bundled">Bundled (extension storage)</option>
              </select>
              <p className="field-help" id="zvec-grep-cli-source-help">
                {draft.zvecGrepCliSource === 'bundled'
                  ? 'Install downloads into extension storage. Turns use that binary, not PATH.'
                  : 'Use the path below or PATH. Install and Update use this selection immediately.'}
              </p>
              <ScopeNotice id="zvec-grep-cli-source-notice" notice={noticeFor('zvecGrepCliSource')} />

              {draft.zvecGrepCliSource === 'local' ? (
                <>
                  <label className="field-label" htmlFor="zvec-grep-path">
                    zg path
                  </label>
                  <input
                    className="input"
                    id="zvec-grep-path"
                    type="text"
                    value={draft.zvecGrepPath}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={zvecPathError ? true : undefined}
                    aria-describedby={zvecPathError ? 'zvec-grep-path-error' : undefined}
                    onChange={(event) => update('zvecGrepPath', event.target.value)}
                  />
                  {zvecPathError ? (
                    <p className="field-msg field-msg--error" id="zvec-grep-path-error" role="alert">
                      <AlertIcon />
                      <span>{zvecPathError}</span>
                    </p>
                  ) : (
                    <ScopeNotice id="zvec-grep-path-notice" notice={noticeFor('zvecGrepPath')} />
                  )}
                </>
              ) : (
                <p className="field-help skill-path" title={settings.skills.zvecGrep.bundled.path}>
                  Bundled path
                  <FieldTip label="Bundled zvec-grep path" text={settings.skills.zvecGrep.bundled.path} />
                </p>
              )}

              <p
                className={`runtime-status runtime-status--${
                  zvecProbe.status === 'detected'
                    ? 'detected'
                    : zvecProbe.status === 'not-runnable'
                      ? 'not-runnable'
                      : 'missing'
                }`}
                role="status"
              >
                <span className="runtime-dot" aria-hidden="true" />
                <span>
                  {zvecProbe.status === 'detected'
                    ? 'Detected'
                    : zvecProbe.status === 'not-runnable'
                      ? 'Installed but not runnable'
                      : 'Not installed'}
                </span>
                {zvecProbe.status === 'detected' && zvecProbe.version ? (
                  <span className="runtime-version">{zvecProbe.version}</span>
                ) : null}
              </p>

              <div className="runtime-actions">
                <button
                  className="btn btn--secondary"
                  type="button"
                  disabled={zvecGrepInstall?.pending}
                  onClick={() => onInstallZvecGrep(zvecCliDraft)}
                >
                  {zvecGrepInstall?.pending
                    ? 'Working…'
                    : zvecProbe.status === 'detected'
                      ? draft.zvecGrepCliSource === 'bundled'
                        ? 'Update bundled zvec-grep'
                        : 'Update zvec-grep'
                      : draft.zvecGrepCliSource === 'bundled'
                        ? 'Install bundled zvec-grep'
                        : 'Install zvec-grep'}
                </button>
                {zvecGrepInstall && !zvecGrepInstall.pending && zvecGrepInstall.message ? (
                  <CliResult ok={zvecGrepInstall.ok} message={zvecGrepInstall.message} />
                ) : null}
              </div>

              <div className="skill-check-row">
                <label className="check" htmlFor="zvec-grep-enabled">
                  <input
                    className="check-input"
                    id="zvec-grep-enabled"
                    type="checkbox"
                    checked={zvecChecked}
                    disabled={zvecGrep?.pending}
                    aria-describedby="zvec-grep-status"
                    onChange={(event) => onSetZvecGrep(event.target.checked, zvecCliDraft)}
                  />
                  <span className="check-box" aria-hidden="true">
                    <CheckIcon />
                  </span>
                  <span className="check-body">
                    <span className="check-label">Use semantic search</span>
                  </span>
                </label>
                <FieldTip
                  label="About semantic search"
                  text="Updates your user OpenCode config and SideCode turns. A new session picks it up."
                />
              </div>
              <p className="field-help" id="zvec-grep-status">
                {zvecStatus}
              </p>
              {zvecGrep && !zvecGrep.pending && zvecGrep.message ? (
                <CliResult ok={zvecGrep.ok} message={zvecGrep.message} />
              ) : null}
            </div>
          </TabPanel>

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
        {settings.target === 'workspace' ? (
          <button
            className="btn"
            type="button"
            disabled={!dirty}
            onClick={() => save('workspace')}
            title="Saves to this workspace's .vscode/settings.json. The credential host, the CLI paths and the permission default are always saved to your user settings."
          >
            Save to workspace
          </button>
        ) : null}
        <button className="btn btn--primary" type="button" disabled={!dirty} onClick={() => save('global')}>
          {settings.target === 'workspace' ? 'Save user settings' : 'Save settings'}
        </button>
      </footer>
    </main>
  );
}

/**
 * The scope notice for a trust-sensitive field.
 *
 * Nine fields are read from the user's own settings only, so a "Save to
 * workspace" writes them there instead. The value is persisted, so the
 * message is a notice -- but it must be shown on every one of the nine, or the
 * screen would claim a workspace save that never happened.
 */
function ScopeNotice({ id, notice }: { id: string; notice?: string }): JSX.Element | null {
  if (!notice) {
    return null;
  }
  return (
    <p className="field-msg field-msg--notice" id={id} role="status">
      <InfoIcon />
      <span>{notice}</span>
    </p>
  );
}
