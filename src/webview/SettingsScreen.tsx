import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { THINKING_LEVELS } from '../backends/types';
import type { SettingsPatch, SettingsSnapshot } from '../protocol';
import { AlertIcon, BackIcon, CheckIcon, CrossIcon, InfoIcon } from './Icons';
import { opencodeRuntimeView } from './runtimeStatus';
import { contextPatternError } from '../context/contextSettings';
import { executablePathError, resolveExecutableCommand } from '../backends/executables.ts';
import { isSubmitEnter } from './keys';
import { noticeForField } from '../config/fieldNotices.ts';
import { TabList, TabPanel, type TabItem } from './Tabs';
import { CONTEXT_BUILTIN_PATTERNS } from './settings/constants';
import type { ProviderTab, SettingsScreenProps } from './settings/types';
import { providerTabForSection } from './settings/types';
import { draftFrom, isDraftDirty, patchFrom, type Draft } from './settings/draft';
import { SaveFooter } from './settings/SaveFooter';
import { SkillPanel } from './settings/SkillPanel';
import { skillChecked, skillChip, skillStatusText } from './settings/skillState';
import { OrchestrationFields } from './settings/OrchestrationFields';
import type { OrchestrationFieldKey } from './settings/orchestrationCopy';
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
  settingsSave,
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
  onInstallZvecGrep,
  skillAction,
  onSkillAction
}: SettingsScreenProps): JSX.Element {
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  // Local validation errors are derived from the current draft after the first
  // save attempt, so fixing a field clears its message without a second click.
  const [showValidation, setShowValidation] = useState(false);
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
  const [tab, setTab] = useState<'cli' | 'providers' | 'defaults' | 'orchestration' | 'context' | 'skills'>('cli');
  // Ollama Cloud, Ollama Local, OpenCode Zen, and Codex are separate pages
  // inside Providers. The choice is view state only; it does not touch the
  // draft.
  const [providerTab, setProviderTab] = useState<ProviderTab>(() => providerTabForSection(settingsProvider));
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
    setNotices(settings.saveNotices ?? {});
  }, [settings]);

  // The host's refusals are echoed on the snapshot; local validation is shown
  // once Save has been pressed. For the same field the host's message wins: it
  // is the later authority on what was actually written. Local messages clear
  // as soon as the draft value becomes valid.
  const localErrors = useMemo(
    () => (showValidation && draft ? draftErrors(draft) : {}),
    [draft, showValidation]
  );
  const errors = useMemo(
    () => ({ ...localErrors, ...(settings?.saveErrors ?? {}) }),
    [settings?.saveErrors, localErrors]
  );

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

  // ast-grep's installer persists an absolute path on the host. Adopt it like
  // the opencode installer, or the next Save writes the stale bare name back
  // over the path the install just stored.
  useEffect(() => {
    const installedPath = astGrepInstall?.ok ? astGrepInstall.path : undefined;
    if (!installedPath) {
      return;
    }
    setDraft((current) =>
      current && current.astGrepPath !== installedPath
        ? { ...current, astGrepPath: installedPath }
        : current
    );
  }, [astGrepInstall]);

  useEffect(() => {
    backRef.current?.focus();
  }, []);

  useEffect(() => {
    if (settingsProvider) {
      setProviderTab(providerTabForSection(settingsProvider));
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
  // True when the normalised draft the save would write differs from the stored
  // values. Sharing that comparison with the patch means a dirty field is always
  // one the save includes, and the echo always clears it.
  const dirty = isDraftDirty(draft, settings);

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
    setShowValidation(false);
    setNotices({});
    setToken('');
    setTokenSaved(false);
    setZenToken('');
    setZenTokenSaved(false);
    setPatternDraft('');
  };

  // Move the screen to the section that owns a refused field, so the inline
  // message is never on a hidden tab.
  const jumpToProblem = (field: keyof SettingsPatch): void => {
    const destination = fieldDestination(field);
    if (destination.providerTab) {
      setProviderTab(destination.providerTab);
    }
    if (destination.skillTab) {
      setSkillTab(destination.skillTab);
    }
    setTab(destination.tab);
  };
  // When the host refuses a field (for example a path that does not exist), the
  // inline message can otherwise sit on a hidden tab. Bring that tab forward
  // once the save has settled, without stealing focus mid-edit.
  useEffect(() => {
    if (!settingsSave || settingsSave.pending || settingsSave.ok !== false) {
      return;
    }
    const firstHostProblem = (Object.keys(settings?.saveErrors ?? {}) as Array<keyof SettingsPatch>)[0];
    if (firstHostProblem) {
      jumpToProblem(firstHostProblem);
    }
    // jumpToProblem only calls stable setters; the save result is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsSave]);

  const firstLocalProblem = (Object.keys(localErrors) as Array<keyof SettingsPatch>)[0];
  const blockedSave =
    firstLocalProblem === undefined
      ? undefined
      : {
          message: localErrors[firstLocalProblem] ?? 'This value was not saved.',
          actionLabel: `Go to ${fieldDestination(firstLocalProblem).label}`
        };

  // Validate locally, then send every field that is valid. A refused field is
  // kept in the draft and marked inline/footer; the rest of the patch still
  // saves, so one bad cap or URL cannot silently drop unrelated edits. The host
  // repeats the same per-field validation and echoes what it actually stored.
  // The primary action writes the effective scope (folder when a folder
  // override controls the shown value, otherwise workspace, otherwise user);
  // "Save user settings" remains available beside a scoped save.
  const save = (target: 'global' | 'workspace' | 'folder'): void => {
    if (!draft || settingsSave?.pending) {
      return;
    }
    const nextErrors = draftErrors(draft);
    setShowValidation(true);
    const invalidFields = Object.keys(nextErrors) as Array<keyof SettingsPatch>;
    if (invalidFields.length > 0) {
      jumpToProblem(invalidFields[0]);
    }
    const patch: SettingsPatch = patchFrom(draft);
    for (const field of invalidFields) {
      delete patch[field];
    }
    if (Object.keys(patch).length === 0) {
      return;
    }
    onSave(patch, target);
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
  const localStatus = connectionTest?.backendId === 'ollama-local' ? connectionTest : undefined;
  const opencodeStatus = connectionTest?.backendId === 'opencode' ? connectionTest : undefined;
  const codexStatus = connectionTest?.backendId === 'codex' ? connectionTest : undefined;
  // The host's notice map, read through one accessor. The host is the
  // authority on which fields were redirected, so the screen adds nothing of
  // its own: it renders the notice the host echoed, or nothing.
  const noticeFor = (field: keyof SettingsPatch): string | undefined => noticeForField(field, notices);
  const modelOptions = flattenModels(settings.models);
  const runtimeView = opencodeRuntimeView(settings.opencode, {
    source: draft.opencodeCliSource
  });
  const draftCliAction = {
    cliSource: draft.opencodeCliSource,
    path: draft.opencodePath
  };
  const draftProbe =
    draft.opencodeCliSource === 'bundled' ? settings.opencode.bundled : settings.opencode.local;
  const zvecSnapshot = settings.skills.zvecGrep;
  const astSnapshot = settings.skills.astGrep;
  const zvecChecked = skillChecked({
    pending: zvecGrep?.pending === true,
    requested: zvecGrep?.requested,
    snapshot: zvecSnapshot
  });
  const astChecked = skillChecked({
    pending: astGrep?.pending === true,
    requested: astGrep?.requested,
    snapshot: astSnapshot
  });
  const zvecChip = skillChip({
    skill: 'zvecGrep',
    pending: zvecGrep?.pending === true,
    snapshot: zvecSnapshot
  });
  const astChip = skillChip({
    skill: 'astGrep',
    pending: astGrep?.pending === true,
    snapshot: astSnapshot
  });
  const zvecStatus = skillStatusText({
    skill: 'zvecGrep',
    pending: zvecGrep?.pending === true,
    requested: zvecGrep?.requested,
    snapshot: zvecSnapshot
  });
  const astStatus = skillStatusText({
    skill: 'astGrep',
    pending: astGrep?.pending === true,
    requested: astGrep?.requested,
    snapshot: astSnapshot
  });
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
  const zvecTest =
    skillAction?.skill === 'zvecGrep' && skillAction.action === 'test' ? skillAction : undefined;
  const zvecIndex =
    skillAction?.skill === 'zvecGrep' && skillAction.action === 'index' ? skillAction : undefined;
  const astTest =
    skillAction?.skill === 'astGrep' && skillAction.action === 'test' ? skillAction : undefined;
  const browserSkillChip = settings.skills.browserError
    ? 'Launch issue'
    : draft.browserCodex || draft.browserOpencode
      ? 'Enabled'
      : 'Off';
  const zvecInstallLabel =
    zvecProbe.status === 'detected'
      ? draft.zvecGrepCliSource === 'bundled'
        ? 'Update bundled zvec-grep'
        : 'Update zvec-grep'
      : draft.zvecGrepCliSource === 'bundled'
        ? 'Install bundled zvec-grep'
        : 'Install zvec-grep';
  const astInstallLabel =
    astProbe.status === 'detected'
      ? draft.astGrepCliSource === 'bundled'
        ? 'Update bundled ast-grep'
        : 'Update ast-grep'
      : draft.astGrepCliSource === 'bundled'
        ? 'Install bundled ast-grep'
        : 'Install ast-grep';
  const sourceHelp = (source: 'local' | 'bundled'): string =>
    source === 'bundled'
      ? 'Install downloads into extension storage. Turns use that binary, not PATH.'
      : 'Use the path below or PATH. Install and Test use this selection immediately.';
  const tabs: readonly TabItem[] = [
    { id: 'cli', label: 'CLI' },
    { id: 'providers', label: 'Providers' },
    { id: 'defaults', label: 'Defaults' },
    { id: 'orchestration', label: 'Orchestration' },
    { id: 'context', label: 'Context' },
    { id: 'skills', label: 'Skills' }
  ];

  const orchestrationDraftKeys: Record<OrchestrationFieldKey, keyof Draft> = {
    testing: 'orchestrationTesting',
    reviewing: 'orchestrationReviewing',
    styling: 'orchestrationStyling',
    doubleCheck: 'orchestrationDoubleCheck',
    quickTask: 'orchestrationQuickTask',
    planning: 'orchestrationPlanning'
  };
  const changeOrchestration = (key: OrchestrationFieldKey, value: boolean): void => {
    const draftKey = orchestrationDraftKeys[key] as
      | 'orchestrationTesting'
      | 'orchestrationReviewing'
      | 'orchestrationStyling'
      | 'orchestrationDoubleCheck'
      | 'orchestrationQuickTask'
      | 'orchestrationPlanning';
    update(draftKey, value);
  };

  return (
    <main className="app">
      <header className="view-title settings-title">
        <button className="icon-btn" type="button" aria-label="Back to chat" onClick={onBack} ref={backRef}>
          <BackIcon />
        </button>
        <span className="settings-title__name">Settings</span>
        <span className="settings-title__scope">
          {settings.target === 'folder'
            ? 'Folder settings'
            : settings.target === 'workspace'
              ? 'Workspace settings'
              : 'User settings'}
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
            <span className="panel__note">Shared OpenCode binary for every Ollama and OpenCode Zen turn</span>
          </div>
          <div className="panel__body">
            <div className="field">
              <p className="field-help">
                Ollama Cloud, Ollama Local, and OpenCode Zen all send turns through this CLI. Choose local
                or bundled, then install or update. The selection is what Test connection and model refresh
                use.
              </p>

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
              { id: 'provider-local', label: 'Ollama Local' },
              { id: 'provider-opencode', label: 'OpenCode' },
              { id: 'provider-codex', label: 'Codex' }
            ]}
            active={providerTab}
            onChange={(id) =>
              setProviderTab(
                id as 'provider-ollama' | 'provider-local' | 'provider-opencode' | 'provider-codex'
              )
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

          <TabPanel id="provider-local" active={providerTab} className="tabpanel--inline">
            {/* Ollama Local */}
            <div className="field">
              <div className="field__head">
                <span className="provider-badge">
                  <span className="provider-dot provider-dot--ollama-local" aria-hidden="true" />
                  <span className="provider-name">Ollama Local</span>
                </span>
                <span className="spacer" />
                <span
                  className={`chip ${
                    settings.ollamaLocal.status === 'available' ? 'chip--stored' : 'chip--missing'
                  }`}
                >
                  {settings.ollamaLocal.status === 'available' ? 'Running' : 'Not reachable'}
                </span>
              </div>
              <p className="field-help">
                A local Ollama server. No API key is used; turns run through the shared OpenCode binary.
              </p>

              <label className="field-label" htmlFor="ollama-local-base-url">
                Base URL
              </label>
              <input
                className="input"
                id="ollama-local-base-url"
                type="url"
                value={draft.ollamaLocalBaseUrl}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={errors.ollamaLocalBaseUrl ? true : undefined}
                aria-describedby={
                  errors.ollamaLocalBaseUrl ? 'ollama-local-base-url-error' : 'ollama-local-base-url-help'
                }
                onChange={(event) => update('ollamaLocalBaseUrl', event.target.value)}
              />
              {errors.ollamaLocalBaseUrl ? (
                <p className="field-msg field-msg--error" id="ollama-local-base-url-error">
                  <AlertIcon />
                  <span>{errors.ollamaLocalBaseUrl}</span>
                </p>
              ) : noticeFor('ollamaLocalBaseUrl') ? (
                <p className="field-msg field-msg--notice" id="ollama-local-base-url-notice" role="status">
                  <InfoIcon />
                  <span>{noticeFor('ollamaLocalBaseUrl')}</span>
                </p>
              ) : (
                <p className="field-help" id="ollama-local-base-url-help">
                  Where local requests are sent. This setting is read from your user settings only, so a
                  workspace cannot redirect local prompts.
                </p>
              )}

              <label className="field-label" htmlFor="ollama-local-default-model">
                Default model
              </label>
              <select
                className="select"
                id="ollama-local-default-model"
                value={draft.ollamaLocalDefaultModel}
                onChange={(event) => update('ollamaLocalDefaultModel', event.target.value)}
              >
                <option value="">First model reported by the provider</option>
                {modelOptions
                  .filter((option) => option.backendId === 'ollama-local')
                  .map((option) => (
                    <option value={option.id} key={option.id}>
                      {option.label}
                    </option>
                  ))}
              </select>
              <p className="field-help">
                Used for a new conversation. Switching the model in the header overrides it for that conversation.
              </p>

              <div className="field-row">
                <span className="spacer" />
                <button
                  className="btn"
                  type="button"
                  disabled={connectionTest?.backendId === 'ollama-local' && connectionTest.pending}
                  onClick={() => onTestConnection('ollama-local')}
                >
                  <RefreshIconInline />
                  {connectionTest?.backendId === 'ollama-local' && connectionTest.pending
                    ? 'Testing...'
                    : 'Test connection'}
                </button>
              </div>
              {settings.ollamaLocal.detail ? (
                <p className="field-help">{settings.ollamaLocal.detail}</p>
              ) : null}

              {localStatus ? (
                <TestResult
                  backendLabel="Ollama Local"
                  test={localStatus}
                  onRetry={() => onTestConnection('ollama-local')}
                />
              ) : null}
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
                <option value="">First model in the catalog</option>
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
                  Checks this CLI against the protocol sideCode uses. A version that passes is allowed.
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

        {/* ---------- Orchestration ---------- */}
        <TabPanel id="orchestration" active={tab}>
        <section className="panel" aria-labelledby="orchestration-title">
          <div className="panel__head" id="orchestration-title">
            <span>Orchestration</span>
            <span className="spacer" />
            <span className="panel__note">Per-turn helpers that run after the agent replies</span>
          </div>
          <div className="panel__body">
            <OrchestrationFields
              values={{
                testing: draft.orchestrationTesting,
                reviewing: draft.orchestrationReviewing,
                styling: draft.orchestrationStyling,
                doubleCheck: draft.orchestrationDoubleCheck,
                quickTask: draft.orchestrationQuickTask,
                planning: draft.orchestrationPlanning
              }}
              legacyTesting={settings.orchestration.legacyTesting}
              legacyReviewing={settings.orchestration.legacyReviewing}
              onChange={changeOrchestration}
            />
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
            <SkillPanel
              id="ast-grep"
              title="ast-grep"
              about="Syntax-aware code search and rewrite, bundled with the app. Agents find and refactor by AST pattern instead of fragile text matching. Enabling updates your user OpenCode config and sideCode turns; a new session picks it up."
              oneLineHelp="Structural search and rewrite by AST pattern."
              checked={astChecked}
              toggleLabel="Use structural search"
              toggleTip="Updates your user OpenCode config and sideCode turns. A new session picks it up."
              togglePending={astGrep?.pending === true}
              onToggle={(value) => onSetAstGrep(value, astCliDraft)}
              chip={astChip}
              statusText={astStatus}
              detail={astSnapshot.detail}
              cliSource={draft.astGrepCliSource}
              onCliSource={(value) => update('astGrepCliSource', value)}
              sourceHelp={sourceHelp(draft.astGrepCliSource)}
              sourceNotice={noticeFor('astGrepCliSource')}
              pathLabel="ast-grep path"
              pathValue={draft.astGrepPath}
              onPath={(value) => update('astGrepPath', value)}
              pathError={astPathError}
              pathNotice={noticeFor('astGrepPath')}
              bundledPath={settings.skills.astGrep.bundled.path}
              probeStatus={astProbe.status}
              probeVersion={astProbe.version}
              installLabel={astInstallLabel}
              installPending={astGrepInstall?.pending === true}
              onInstall={() =>
                astProbe.status === 'detected'
                  ? onUpgradeAstGrep(astCliDraft)
                  : onInstallAstGrep(astCliDraft)
              }
              installResult={astGrepInstall && !astGrepInstall.pending ? astGrepInstall : undefined}
              testPending={astTest?.pending === true}
              testResult={astTest && !astTest.pending ? astTest : undefined}
              onTest={() => onSkillAction('astGrep', 'test', astCliDraft)}
            />
          </TabPanel>

          <TabPanel id="skill-zvec-grep" active={skillTab} className="tabpanel--inline">
            <SkillPanel
              id="zvec-grep"
              title="zvec-grep"
              about="Local semantic, keyword, and ripgrep search, bundled with the app and exposed as an MCP tool. Returns ranked, source-linked snippets so agents read fewer files. Enabling updates your user OpenCode config and sideCode turns; a new session picks it up. A workspace index is required."
              oneLineHelp="Semantic search over a workspace index."
              checked={zvecChecked}
              toggleLabel="Use semantic search"
              toggleTip="Updates your user OpenCode config and sideCode turns. A new session picks it up."
              togglePending={zvecGrep?.pending === true}
              onToggle={(value) => onSetZvecGrep(value, zvecCliDraft)}
              chip={zvecChip}
              statusText={zvecStatus}
              detail={zvecSnapshot.detail}
              cliSource={draft.zvecGrepCliSource}
              onCliSource={(value) => update('zvecGrepCliSource', value)}
              sourceHelp={sourceHelp(draft.zvecGrepCliSource)}
              sourceNotice={noticeFor('zvecGrepCliSource')}
              pathLabel="zg path"
              pathValue={draft.zvecGrepPath}
              onPath={(value) => update('zvecGrepPath', value)}
              pathError={zvecPathError}
              pathNotice={noticeFor('zvecGrepPath')}
              bundledPath={settings.skills.zvecGrep.bundled.path}
              probeStatus={zvecProbe.status}
              probeVersion={zvecProbe.version}
              installLabel={zvecInstallLabel}
              installPending={zvecGrepInstall?.pending === true}
              onInstall={() => onInstallZvecGrep(zvecCliDraft)}
              installResult={zvecGrepInstall && !zvecGrepInstall.pending ? zvecGrepInstall : undefined}
              testPending={zvecTest?.pending === true}
              testResult={zvecTest && !zvecTest.pending ? zvecTest : undefined}
              onTest={() => onSkillAction('zvecGrep', 'test', zvecCliDraft)}
              indexState={zvecSnapshot.index}
              indexPending={zvecIndex?.pending === true}
              onBuildIndex={() => onSkillAction('zvecGrep', 'index', zvecCliDraft)}
              indexResult={zvecIndex && !zvecIndex.pending ? zvecIndex : undefined}
            />
          </TabPanel>

          <p className="panel__foot">Unsaved changes apply to the next turn.</p>
        </section>
        </TabPanel>
      </div>

      <SaveFooter
        dirty={dirty}
        target={settings.target}
        save={settingsSave}
        blocked={blockedSave}
        onSave={save}
        onReset={resetDraft}
        onJumpToProblem={firstLocalProblem ? () => jumpToProblem(firstLocalProblem) : undefined}
      />
    </main>
  );
}

/**
 * The scope notice for a trust-sensitive field.
 *
 * Ten fields are read from the user's own settings only, so a "Save to
 * workspace" writes them there instead. The value is persisted, so the
 * message is a notice -- but it must be shown on every one of the ten, or the
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



type SettingsTabId = 'cli' | 'providers' | 'defaults' | 'orchestration' | 'context' | 'skills';
type SkillTabId = 'skill-browser' | 'skill-ast-grep' | 'skill-zvec-grep';

interface FieldDestination {
  tab: SettingsTabId;
  label: string;
  providerTab?: ProviderTab;
  skillTab?: SkillTabId;
}

/** The section and nested page that owns one settings field. */
function fieldDestination(field: keyof SettingsPatch): FieldDestination {
  switch (field) {
    case 'ollamaBaseUrl':
    case 'ollamaDefaultModel':
      return { tab: 'providers', label: 'Providers', providerTab: 'provider-ollama' };
    case 'ollamaLocalBaseUrl':
    case 'ollamaLocalDefaultModel':
      return { tab: 'providers', label: 'Providers', providerTab: 'provider-local' };
    case 'opencodeDefaultModel':
      return { tab: 'providers', label: 'Providers', providerTab: 'provider-opencode' };
    case 'codexPath':
    case 'codexDefaultModel':
      return { tab: 'providers', label: 'Providers', providerTab: 'provider-codex' };
    case 'permissionLevel':
    case 'mode':
    case 'thinking':
    case 'dictationModel':
      return { tab: 'defaults', label: 'Defaults' };
    case 'orchestrationTesting':
    case 'orchestrationReviewing':
    case 'orchestrationStyling':
    case 'orchestrationDoubleCheck':
    case 'orchestrationQuickTask':
    case 'orchestrationPlanning':
      return { tab: 'orchestration', label: 'Orchestration' };
    case 'contextIncludeInstructions':
    case 'contextIncludeShape':
    case 'contextIncludeEditorState':
    case 'contextIncludeSelection':
    case 'contextIncludeChangedFiles':
    case 'contextMaxBytes':
    case 'contextExclude':
      return { tab: 'context', label: 'Context' };
    case 'browserCodex':
    case 'browserOpencode':
      return { tab: 'skills', label: 'Skills', skillTab: 'skill-browser' };
    case 'zvecGrepPath':
    case 'zvecGrepCliSource':
      return { tab: 'skills', label: 'Skills', skillTab: 'skill-zvec-grep' };
    case 'astGrepPath':
    case 'astGrepCliSource':
      return { tab: 'skills', label: 'Skills', skillTab: 'skill-ast-grep' };
    case 'opencodeCliSource':
    case 'opencodePath':
      return { tab: 'cli', label: 'CLI' };
    default:
      return { tab: 'cli', label: 'CLI' };
  }
}

/**
 * The same per-field validation the host applies, run locally for immediate
 * feedback. A refused field is excluded from the patch, but every other valid
 * field is still sent; the draft keeps the bad value so the user can fix it.
 */
function draftErrors(draft: Draft): Partial<Record<keyof SettingsPatch, string>> {
  const errors: Partial<Record<keyof SettingsPatch, string>> = {};
  if (!isHttpUrl(draft.ollamaBaseUrl)) {
    errors.ollamaBaseUrl = 'Enter a full URL, like https://ollama.com. This value was not saved.';
  }
  if (!isHttpUrl(draft.ollamaLocalBaseUrl)) {
    errors.ollamaLocalBaseUrl =
      'Enter a full URL, like http://localhost:11434. This value was not saved.';
  }
  if (!draft.codexPath.trim()) {
    errors.codexPath = 'Enter the CLI path or name. This value was not saved.';
  } else {
    const codexResolved = resolveExecutableCommand(draft.codexPath, 'codex');
    if (!codexResolved.ok) {
      errors.codexPath = executablePathError(codexResolved.reason, 'Codex CLI');
    }
  }
  // Paths are persisted regardless of the active source, so they are validated
  // regardless too. A bundled selection still owns the stored local path.
  if (!draft.opencodePath.trim()) {
    errors.opencodePath = 'Enter the opencode CLI path or name. This value was not saved.';
  } else {
    const opencodeResolved = resolveExecutableCommand(draft.opencodePath, 'opencode');
    if (!opencodeResolved.ok) {
      errors.opencodePath = executablePathError(opencodeResolved.reason, 'opencode CLI');
    }
  }
  if (!draft.zvecGrepPath.trim()) {
    errors.zvecGrepPath = 'Enter the zg CLI path or name. This value was not saved.';
  } else {
    const zvecResolved = resolveExecutableCommand(draft.zvecGrepPath, 'zg');
    if (!zvecResolved.ok) {
      errors.zvecGrepPath = executablePathError(zvecResolved.reason, 'zg CLI');
    }
  }
  if (!draft.astGrepPath.trim()) {
    errors.astGrepPath = 'Enter the ast-grep CLI path or name. This value was not saved.';
  } else {
    const astResolved = resolveExecutableCommand(draft.astGrepPath, 'ast-grep');
    if (!astResolved.ok) {
      errors.astGrepPath = executablePathError(astResolved.reason, 'ast-grep CLI');
    }
  }
  const maxKb = Number(draft.contextMaxKb.trim());
  if (!Number.isFinite(maxKb) || !Number.isInteger(maxKb) || maxKb < 1 || maxKb > 1024) {
    errors.contextMaxBytes =
      'Enter a whole number of kilobytes between 1 and 1024. This value was not saved.';
  }
  const badPattern = draft.contextExclude.find((pattern) => contextPatternError(pattern) !== undefined);
  if (badPattern !== undefined) {
    errors.contextExclude = contextPatternError(badPattern);
  }
  return errors;
}


