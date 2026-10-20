import * as vscode from 'vscode';
import { OLLAMA_TOKEN_SECRET_KEY, OPENCODE_ZEN_TOKEN_SECRET_KEY } from './backends/secrets';
import type { BackendRegistry } from './backends/registry';
import type { BackendStatus, ConnectionTestResult, DefaultMode, PermissionLevel } from './backends/types';
import { PERMISSION_LEVELS } from './backends/types';
import { DEFAULT_MODES } from './backends/modes';
import { readDefaultMode, readDefaultPermissionLevel, readDefaultThinking } from './backends/defaults';
import { isThinkingLevel } from './backends/capabilities';
import type { SettingsPatch, SettingsSnapshot } from './protocol';
import { existsSync } from 'node:fs';
import { installOpencodeRelease, type OpencodeInstallResult } from './backends/opencode/install';
import {
  bundledOpencodeExecutable,
  opencodeInstallDirFor,
  resolveOpencodeExecutable,
  type OpencodeCliSource
} from './backends/opencode/resolve';
import {
  opencodePathError,
  probeOpencode,
  type OpencodeUpgradeResult
} from './backends/opencode/status';
import { applyZvecGrep, detectZvecGrep, type ZvecGrepApplyResult } from './backends/opencode/zvecGrep';
import { applyAstGrep, detectAstGrep, type AstGrepApplyResult } from './backends/astGrep/apply.ts';
import { installAstGrepRelease, type AstGrepInstallResult } from './backends/astGrep/install.ts';
import {
  astGrepInstallDirFor,
  bundledAstGrepExecutable,
  resolveAstGrepExecutable,
  type AstGrepCliSource
} from './backends/astGrep/resolve.ts';
import {
  bundledZvecGrepExecutable,
  bundledZvecGrepPrefix,
  resolveZvecGrepExecutable,
  type ZvecGrepCliSource
} from './backends/zvecGrep/resolve.ts';
import { npmPrefixInstallArgs, runCommand } from './backends/opencode/zvecGrep.ts';
import { browserLaunchError } from './browser/skill.ts';
import { validateInstalledCodex, type CodexVersionCheckResult } from './backends/codex/versionCheckRun.ts';
import { browserSkillEnabledFor, configuredSettingValue } from './browser/policy.ts';
import type { OpencodeCliProbe, SkillCliSnapshot } from './protocol';
import { readSkillCliSource, skillCliPathError } from './backends/skillCli.ts';
import { executablePathError, resolveExecutableCommand, resolveProbedExecutable } from './backends/executables.ts';
import { keyAllowsWorkspaceScope } from './config/trust.ts';
import { fieldSaveOutcome } from './config/settingsScope.ts';
import {
  readTrustedAstGrepCliSource,
  readTrustedAstGrepPath,
  readTrustedBaseUrl,
  readTrustedCodexExecutable,
  readTrustedCodexPath,
  readTrustedOpencodeCliSource,
  readTrustedOpencodePath,
  readTrustedZvecGrepCliSource,
  readTrustedZvecGrepPath
} from './config/settings.ts';
import {
  CONTEXT_SECTION,
  DEFAULT_CONTEXT_SETTINGS,
  MAX_CONTEXT_BYTES,
  MIN_CONTEXT_BYTES,
  contextPatternError
} from './context/contextSettings';

/**
 * Reads and writes the settings the screen exposes, and nothing else.
 *
 * Credentials are the one exception: the token is written through
 * `context.secrets` against the single key in `secrets.ts`, exactly as the
 * contributed commands do. It is never copied into configuration, workspace
 * state, output channels, logs, or error text — `snapshot()` reports only
 * `hasToken`, so a stored value can never be rendered back into the DOM.
 *
 * ## Scope
 *
 * Ordinary settings use VS Code's normal merge (workspace overrides user).
 * The trust-sensitive settings — the ones that decide where a credential is
 * sent, which binary is spawned, and what the permission default is — are
 * read from the user's own settings only and are only ever written to the
 * user's own settings. A workspace override for one of them is ignored, and
 * a workspace save for one of them is refused with a per-key message instead
 * of silently doing nothing.
 */

const OLLAMA_SECTION = 'melink.ollama';
const OLLAMA_OPENCODE_SECTION = 'melink.ollama.opencode';
const OPENCODE_SECTION = 'melink.opencode';
const CODEX_SECTION = 'melink.codex';
const DEFAULTS_SECTION = 'melink.defaults';
const SKILLS_SECTION = 'melink.skills';

/**
 * Keys the settings screen reads and writes. Used to detect whether a workspace
 * `.vscode/settings.json` (or folder settings) already overrides any of them.
 */
const SETTINGS_KEYS: readonly string[] = [
  `${OLLAMA_SECTION}.baseUrl`,
  `${OLLAMA_SECTION}.defaultModel`,
  `${OPENCODE_SECTION}.defaultModel`,
  `${OLLAMA_OPENCODE_SECTION}.enabled`,
  `${OLLAMA_OPENCODE_SECTION}.path`,
  `${OLLAMA_OPENCODE_SECTION}.cliSource`,
  `${OLLAMA_OPENCODE_SECTION}.zvecGrep`,
  `${CODEX_SECTION}.path`,
  `${CODEX_SECTION}.defaultModel`,
  `${DEFAULTS_SECTION}.permissionLevel`,
  `${DEFAULTS_SECTION}.mode`,
  `${DEFAULTS_SECTION}.thinking`,
  `${DEFAULTS_SECTION}.dictationModel`,
  `${CONTEXT_SECTION}.includeInstructions`,
  `${CONTEXT_SECTION}.includeShape`,
  `${CONTEXT_SECTION}.includeEditorState`,
  `${CONTEXT_SECTION}.includeSelection`,
  `${CONTEXT_SECTION}.includeChangedFiles`,
  `${CONTEXT_SECTION}.maxBytes`,
  `${CONTEXT_SECTION}.exclude`,
  `${SKILLS_SECTION}.browserCodex`,
  `${SKILLS_SECTION}.browserOpencode`,
  `${SKILLS_SECTION}.browser`,
  `${SKILLS_SECTION}.zvecGrep`,
  `${SKILLS_SECTION}.zvecGrep.cliSource`,
  `${SKILLS_SECTION}.zvecGrep.path`,
  `${SKILLS_SECTION}.astGrep`,
  `${SKILLS_SECTION}.astGrep.cliSource`,
  `${SKILLS_SECTION}.astGrep.path`
];

export { PERMISSION_LEVELS } from './backends/types';
export { DEFAULT_MODES };

/** Where a settings patch is written. */
export type SettingsSaveTarget = 'global' | 'workspace';

/**
 * A refused field, named by the screen's own field key.
 *
 * The skill toggles (`setZvecGrep` / `setAstGrep`) write outside the settings
 * patch, so a refused path is reported here instead of in `SaveResult.errors`.
 * The screen shows it on the path field, exactly as it shows a refused save.
 */
export interface SkillFieldError {
  /** The `SettingsPatch` field the error belongs to. */
  field: 'zvecGrepPath' | 'astGrepPath';
  /** The message to show on the field. */
  message: string;
}

/** Outcome of validating and writing one patch. */
export interface SaveResult {
  ok: boolean;
  /** Field-keyed messages; a field with a message is never persisted. */
  errors: Partial<Record<keyof SettingsPatch, string>>;
  /**
   * Field-keyed notices: the field was persisted, but somewhere other than the
   * requested scope (a trust-sensitive setting during a workspace save).
   */
  notices?: Partial<Record<keyof SettingsPatch, string>>;
}

export class SettingsService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: BackendRegistry
  ) {}

  /**
   * Effective scope for the header: `workspace` when any SideCode key that
   * honours workspace scope is set in workspace (or folder) settings — those
   * values win on read — otherwise `global`. Primary Save always writes global
   * regardless.
   *
   * A trust-sensitive key never counts: its workspace value is ignored, so
   * the screen must not claim the workspace is in charge of it.
   */
  private targetName(config: vscode.WorkspaceConfiguration): 'workspace' | 'global' {
    return this.hasWorkspaceSettings(config) ? 'workspace' : 'global';
  }

  /** True when any managed key has a workspace or folder override. */
  private hasWorkspaceSettings(config: vscode.WorkspaceConfiguration): boolean {
    for (const key of SETTINGS_KEYS) {
      if (!keyAllowsWorkspaceScope(key)) {
        continue;
      }
      const inspected = config.inspect(key);
      if (inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined) {
        return true;
      }
    }
    return false;
  }

  private configurationTarget(scope: SettingsSaveTarget): vscode.ConfigurationTarget {
    return scope === 'workspace'
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  }

  /**
   * The target one key is written to.
   *
   * A trust-sensitive key is always written to the user's own settings, even
   * when the screen asked for a workspace save: the value would be ignored on
   * the next read, so writing it to the workspace would look like it worked
   * and change nothing.
   */
  private targetForKey(key: string, scope: SettingsSaveTarget): vscode.ConfigurationTarget {
    return fieldSaveOutcome(key, scope).scope === 'global'
      ? vscode.ConfigurationTarget.Global
      : vscode.ConfigurationTarget.Workspace;
  }

  /**
   * Record a notice when a trust-sensitive field was redirected to the user's
   * own settings during a workspace save.
   *
   * The value *was* persisted, so this is a notice rather than an error: the
   * screen tells the user where the value went instead of pretending the
   * workspace write succeeded.
   */
  private noticeForScope(
    field: keyof SettingsPatch,
    key: string,
    scope: SettingsSaveTarget,
    notices: Partial<Record<keyof SettingsPatch, string>>
  ): void {
    const outcome = fieldSaveOutcome(key, scope);
    if (outcome.redirected && outcome.notice) {
      notices[field] = outcome.notice;
    }
  }

  /** The settings screen's read model. Async because the token check is. */
  async snapshot(): Promise<SettingsSnapshot> {
    const config = vscode.workspace.getConfiguration();
    const [ollamaStatus, opencodeStatus, codexStatus] = await Promise.all([
      this.statusOf('ollama'),
      this.statusOf('opencode'),
      this.statusOf('codex')
    ]);
    const hasToken = Boolean(await this.readToken());
    const hasZenToken = Boolean(await this.readZenToken());
    return {
      target: this.targetName(config),
      ollama: {
        // The base URL is trust-sensitive: it is where the bearer token goes,
        // so only the user's own value is shown.
        baseUrl: readTrustedBaseUrl(),
        defaultModel: config.get<string>(`${OLLAMA_SECTION}.defaultModel`, ''),
        hasToken,
        status: ollamaStatus.status,
        detail: ollamaStatus.detail
      },
      opencodeZen: {
        defaultModel: config.get<string>(`${OPENCODE_SECTION}.defaultModel`, ''),
        hasToken: hasZenToken,
        status: opencodeStatus.status,
        detail: opencodeStatus.detail
      },
      codex: {
        // The CLI path is trust-sensitive: it is the binary that is spawned.
        path: readTrustedCodexPath(),
        defaultModel: config.get<string>(`${CODEX_SECTION}.defaultModel`, ''),
        status: codexStatus.status,
        detail: codexStatus.detail,
        version: codexStatus.version,
        authMode: codexStatus.authMode
      },
      opencode: await this.opencodeSnapshot(config),
      defaults: {
        permissionLevel: this.readPermissionLevel(),
        mode: this.readMode(),
        thinking: readDefaultThinking(),
        dictationModel: config.get<string>(`${DEFAULTS_SECTION}.dictationModel`, '')
      },
      context: this.contextSnapshot(config),
      skills: await this.skillsSnapshot(config),
      models: {}
    };
  }

  /**
   * Validate then persist a patch. An invalid field is reported and skipped, so
   * an invalid value is never written; every control maps to a real write.
   * Defaults to user (global) settings; pass `workspace` only when the screen's
   * Save to workspace action runs.
   *
   * A trust-sensitive key (base URL, CLI path, CLI source, permission level)
   * is always written to the user's own settings: a workspace write would be
   * ignored on the next read, so it would look like it worked and change
   * nothing. The screen learns the outcome from the echoed snapshot.
   */
  async save(patch: SettingsPatch, scope: SettingsSaveTarget = 'global'): Promise<SaveResult> {
    const errors: Partial<Record<keyof SettingsPatch, string>> = {};
    const notices: Partial<Record<keyof SettingsPatch, string>> = {};
    const config = vscode.workspace.getConfiguration();
    const target = this.configurationTarget(scope);

    if (patch.ollamaBaseUrl !== undefined) {
      const value = patch.ollamaBaseUrl.trim();
      if (!isHttpUrl(value)) {
        errors.ollamaBaseUrl = 'Enter a full URL, like https://ollama.com. This value was not saved.';
      } else {
        await config.update(
          `${OLLAMA_SECTION}.baseUrl`,
          value,
          this.targetForKey(`${OLLAMA_SECTION}.baseUrl`, scope)
        );
        this.noticeForScope('ollamaBaseUrl', `${OLLAMA_SECTION}.baseUrl`, scope, notices);
      }
    }

    if (patch.codexPath !== undefined) {
      const value = patch.codexPath.trim();
      const pathError = codexPathError(value);
      if (pathError) {
        errors.codexPath = pathError;
      } else {
        await config.update(
          `${CODEX_SECTION}.path`,
          value,
          this.targetForKey(`${CODEX_SECTION}.path`, scope)
        );
        this.noticeForScope('codexPath', `${CODEX_SECTION}.path`, scope, notices);
      }
    }

    if (patch.ollamaDefaultModel !== undefined) {
      await config.update(
        `${OLLAMA_SECTION}.defaultModel`,
        patch.ollamaDefaultModel.trim(),
        target
      );
    }

    if (patch.opencodeDefaultModel !== undefined) {
      await config.update(
        `${OPENCODE_SECTION}.defaultModel`,
        patch.opencodeDefaultModel.trim(),
        target
      );
    }

    if (patch.codexDefaultModel !== undefined) {
      await config.update(
        `${CODEX_SECTION}.defaultModel`,
        patch.codexDefaultModel.trim(),
        target
      );
    }

    if (patch.permissionLevel !== undefined) {
      if (!PERMISSION_LEVELS.includes(patch.permissionLevel)) {
        errors.permissionLevel = 'Pick one of the listed permission levels. This value was not saved.';
      } else {
        await config.update(
          `${DEFAULTS_SECTION}.permissionLevel`,
          patch.permissionLevel,
          this.targetForKey(`${DEFAULTS_SECTION}.permissionLevel`, scope)
        );
        this.noticeForScope('permissionLevel', `${DEFAULTS_SECTION}.permissionLevel`, scope, notices);
      }
    }

    if (patch.mode !== undefined) {
      if (!DEFAULT_MODES.includes(patch.mode)) {
        errors.mode = 'Pick one of the listed modes. This value was not saved.';
      } else {
        await config.update(`${DEFAULTS_SECTION}.mode`, patch.mode, target);
      }
    }

    if (patch.thinking !== undefined) {
      if (patch.thinking !== '' && !isThinkingLevel(patch.thinking)) {
        errors.thinking = 'Pick one of the listed thinking levels. This value was not saved.';
      } else {
        await config.update(`${DEFAULTS_SECTION}.thinking`, patch.thinking || undefined, target);
      }
    }

    if (patch.dictationModel !== undefined) {
      await config.update(`${DEFAULTS_SECTION}.dictationModel`, patch.dictationModel.trim(), target);
    }

    if (patch.opencodeEnabled !== undefined) {
      await config.update(`${OLLAMA_OPENCODE_SECTION}.enabled`, patch.opencodeEnabled, target);
    }

    if (patch.opencodeCliSource !== undefined) {
      if (patch.opencodeCliSource !== 'local' && patch.opencodeCliSource !== 'bundled') {
        errors.opencodeCliSource = 'Pick local machine or bundled. This value was not saved.';
      } else {
        await config.update(
          `${OLLAMA_OPENCODE_SECTION}.cliSource`,
          patch.opencodeCliSource,
          this.targetForKey(`${OLLAMA_OPENCODE_SECTION}.cliSource`, scope)
        );
        this.noticeForScope('opencodeCliSource', `${OLLAMA_OPENCODE_SECTION}.cliSource`, scope, notices);
      }
    }

    if (patch.opencodePath !== undefined) {
      // Path is only meaningful for the local source. Bundled ignores it for
      // spawns, so a bad draft must not overwrite a stored local path while
      // bundled is selected — still validate when the patch asks to write one.
      const pathError = opencodePathError(patch.opencodePath, (candidate) => existsSync(candidate));
      if (pathError) {
        errors.opencodePath = pathError;
      } else {
        await config.update(
          `${OLLAMA_OPENCODE_SECTION}.path`,
          patch.opencodePath.trim(),
          this.targetForKey(`${OLLAMA_OPENCODE_SECTION}.path`, scope)
        );
        this.noticeForScope('opencodePath', `${OLLAMA_OPENCODE_SECTION}.path`, scope, notices);
      }
    }

    if (patch.contextIncludeInstructions !== undefined) {
      await config.update(`${CONTEXT_SECTION}.includeInstructions`, patch.contextIncludeInstructions, target);
    }

    if (patch.contextIncludeShape !== undefined) {
      await config.update(`${CONTEXT_SECTION}.includeShape`, patch.contextIncludeShape, target);
    }

    if (patch.contextIncludeEditorState !== undefined) {
      await config.update(`${CONTEXT_SECTION}.includeEditorState`, patch.contextIncludeEditorState, target);
    }

    if (patch.contextIncludeSelection !== undefined) {
      await config.update(`${CONTEXT_SECTION}.includeSelection`, patch.contextIncludeSelection, target);
    }

    if (patch.contextIncludeChangedFiles !== undefined) {
      await config.update(`${CONTEXT_SECTION}.includeChangedFiles`, patch.contextIncludeChangedFiles, target);
    }

    if (patch.contextMaxBytes !== undefined) {
      const value = Math.floor(patch.contextMaxBytes);
      if (!Number.isFinite(value) || value < MIN_CONTEXT_BYTES || value > MAX_CONTEXT_BYTES) {
        errors.contextMaxBytes = `Enter a whole number between ${MIN_CONTEXT_BYTES} and ${MAX_CONTEXT_BYTES}. This value was not saved.`;
      } else {
        await config.update(`${CONTEXT_SECTION}.maxBytes`, value, target);
      }
    }

    if (patch.contextExclude !== undefined) {
      // Every pattern is validated before anything is written, so a single bad
      // entry never leaves a half-applied list.
      const bad = patch.contextExclude.find((pattern) => contextPatternError(pattern) !== undefined);
      if (bad !== undefined) {
        errors.contextExclude = contextPatternError(bad);
      } else {
        const cleaned = patch.contextExclude.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
        await config.update(`${CONTEXT_SECTION}.exclude`, cleaned, target);
      }
    }

    if (patch.browserCodex !== undefined) {
      await config.update(`${SKILLS_SECTION}.browserCodex`, patch.browserCodex === true, target);
    }

    if (patch.browserOpencode !== undefined) {
      await config.update(`${SKILLS_SECTION}.browserOpencode`, patch.browserOpencode === true, target);
    }

    if (patch.zvecGrepCliSource !== undefined) {
      await config.update(
        `${SKILLS_SECTION}.zvecGrep.cliSource`,
        readSkillCliSource(patch.zvecGrepCliSource),
        this.targetForKey(`${SKILLS_SECTION}.zvecGrep.cliSource`, scope)
      );
      this.noticeForScope('zvecGrepCliSource', `${SKILLS_SECTION}.zvecGrep.cliSource`, scope, notices);
    }
    if (patch.zvecGrepPath !== undefined && (patch.zvecGrepCliSource ?? this.zvecCliSource()) === 'local') {
      // The same rule the codex and opencode paths use: a relative path (with
      // a separator, or in the Windows drive-relative form) would name a file
      // inside the repository, so the value is refused and never persisted.
      const pathError = skillCliPathError(patch.zvecGrepPath, 'zg', 'zg CLI');
      if (pathError) {
        errors.zvecGrepPath = pathError;
      } else {
        await config.update(
          `${SKILLS_SECTION}.zvecGrep.path`,
          patch.zvecGrepPath.trim() || 'zg',
          this.targetForKey(`${SKILLS_SECTION}.zvecGrep.path`, scope)
        );
        this.noticeForScope('zvecGrepPath', `${SKILLS_SECTION}.zvecGrep.path`, scope, notices);
      }
    }
    if (patch.astGrepCliSource !== undefined) {
      await config.update(
        `${SKILLS_SECTION}.astGrep.cliSource`,
        readSkillCliSource(patch.astGrepCliSource),
        this.targetForKey(`${SKILLS_SECTION}.astGrep.cliSource`, scope)
      );
      this.noticeForScope('astGrepCliSource', `${SKILLS_SECTION}.astGrep.cliSource`, scope, notices);
    }
    if (patch.astGrepPath !== undefined && (patch.astGrepCliSource ?? this.astCliSource()) === 'local') {
      const pathError = skillCliPathError(patch.astGrepPath, 'ast-grep', 'ast-grep CLI');
      if (pathError) {
        errors.astGrepPath = pathError;
      } else {
        await config.update(
          `${SKILLS_SECTION}.astGrep.path`,
          patch.astGrepPath.trim() || 'ast-grep',
          this.targetForKey(`${SKILLS_SECTION}.astGrep.path`, scope)
        );
        this.noticeForScope('astGrepPath', `${SKILLS_SECTION}.astGrep.path`, scope, notices);
      }
    }

    return {
      ok: Object.keys(errors).length === 0,
      errors,
      ...(Object.keys(notices).length > 0 ? { notices } : {})
    };
  }

  /** Skills read model. Per-provider browser flags fall back to the legacy key. */
  private async skillsSnapshot(config: vscode.WorkspaceConfiguration): Promise<SettingsSnapshot['skills']> {
    const skillFlags = {
      browser: configuredSettingValue(config.inspect(`${SKILLS_SECTION}.browser`)),
      browserCodex: configuredSettingValue(config.inspect(`${SKILLS_SECTION}.browserCodex`)),
      browserOpencode: configuredSettingValue(config.inspect(`${SKILLS_SECTION}.browserOpencode`))
    };
    const [zvecGrep, astGrep] = await Promise.all([
      this.zvecSkillSnapshot(config),
      this.astSkillSnapshot(config)
    ]);
    return {
      browserCodex: browserSkillEnabledFor('codex', skillFlags),
      browserOpencode: browserSkillEnabledFor('opencode', skillFlags),
      browserError: browserLaunchError(),
      zvecGrep,
      astGrep
    };
  }

  /**
   * The project-context read model. Values come from the same `melink.context`
   * keys the snapshot host reads, with the documented defaults as a fallback, so
   * the screen never shows a value the snapshot path would ignore.
   */
  private contextSnapshot(config: vscode.WorkspaceConfiguration): SettingsSnapshot['context'] {
    return {
      includeInstructions: config.get<boolean>(
        `${CONTEXT_SECTION}.includeInstructions`,
        DEFAULT_CONTEXT_SETTINGS.includeInstructions
      ),
      includeShape: config.get<boolean>(`${CONTEXT_SECTION}.includeShape`, DEFAULT_CONTEXT_SETTINGS.includeShape),
      includeEditorState: config.get<boolean>(
        `${CONTEXT_SECTION}.includeEditorState`,
        DEFAULT_CONTEXT_SETTINGS.includeEditorState
      ),
      includeSelection: config.get<boolean>(
        `${CONTEXT_SECTION}.includeSelection`,
        DEFAULT_CONTEXT_SETTINGS.includeSelection
      ),
      includeChangedFiles: config.get<boolean>(
        `${CONTEXT_SECTION}.includeChangedFiles`,
        DEFAULT_CONTEXT_SETTINGS.includeChangedFiles
      ),
      maxBytes: clampMaxBytes(config.get<unknown>(`${CONTEXT_SECTION}.maxBytes`, DEFAULT_CONTEXT_SETTINGS.maxBytes)),
      defaultMaxBytes: DEFAULT_CONTEXT_SETTINGS.maxBytes,
      minMaxBytes: MIN_CONTEXT_BYTES,
      maxMaxBytes: MAX_CONTEXT_BYTES,
      exclude: readStringArray(config.get<unknown>(`${CONTEXT_SECTION}.exclude`, DEFAULT_CONTEXT_SETTINGS.exclude))
    };
  }

  /** Whether the opencode agentic runtime is enabled. Default on. */
  private opencodeEnabled(config: vscode.WorkspaceConfiguration): boolean {
    return config.get<boolean>(`${OLLAMA_OPENCODE_SECTION}.enabled`, true) !== false;
  }

  /** Stored local path; ignored for spawns when `cliSource` is bundled. */
  private opencodePathSetting(): string {
    return readTrustedOpencodePath();
  }

  private opencodeCliSource(): OpencodeCliSource {
    return readTrustedOpencodeCliSource();
  }

  private opencodeRoots(): { extensionPath: string; globalStoragePath: string } {
    return {
      extensionPath: this.context.extensionPath,
      globalStoragePath: this.context.globalStorageUri.fsPath
    };
  }

  /**
   * The CLI read model for the settings screen. The binary is always probed so
   * the CLI tab and OpenCode Zen can report status even when the Ollama nested
   * runtime (`enabled`) is off. A probe never throws; a missing or unrunnable
   * CLI is data, exactly like backend availability.
   */
  private async opencodeSnapshot(
    config: vscode.WorkspaceConfiguration
  ): Promise<SettingsSnapshot['opencode']> {
    const enabled = this.opencodeEnabled(config);
    const cliSource = this.opencodeCliSource();
    const localPath = this.opencodePathSetting();
    const bundledPath = bundledOpencodeExecutable(this.opencodeRoots());
    const [local, bundled] = await Promise.all([
      this.probeCli(localPath, 'opencode'),
      this.probeCli(bundledPath, 'opencode')
    ]);
    const active = cliSource === 'bundled' ? bundled : local;
    const zvecGrep = await this.zvecGrepStatus();
    return {
      enabled,
      cliSource,
      path: active.path,
      status: active.status,
      ...(active.version ? { version: active.version } : {}),
      local,
      bundled,
      zvecGrep
    };
  }

  /**
   * Probe one CLI path.
   *
   * The value is resolved through the shared executable rules first, so a
   * relative path with a separator — or a Windows drive-relative path — is
   * never spawned from the workspace. The probe reports the bare command name
   * instead, and the screen shows that as the effective path.
   */
  private async probeCli(executable: string, fallback: string): Promise<OpencodeCliProbe> {
    const command = resolveProbedExecutable(executable, fallback);
    const result = await probeOpencode(command);
    return result.version !== undefined
      ? { path: command, status: result.status, version: result.version }
      : { path: command, status: result.status };
  }

  private skillRoots(): { extensionPath: string; globalStoragePath: string } {
    return {
      extensionPath: this.context.extensionPath,
      globalStoragePath: this.context.globalStorageUri.fsPath
    };
  }

  private zvecCliSource(): ZvecGrepCliSource {
    return readTrustedZvecGrepCliSource();
  }

  private zvecPathSetting(): string {
    return readTrustedZvecGrepPath();
  }

  private zvecEnabled(config: vscode.WorkspaceConfiguration): boolean {
    const inspected = config.inspect<boolean>(`${SKILLS_SECTION}.zvecGrep`);
    if (
      inspected?.globalValue !== undefined ||
      inspected?.workspaceValue !== undefined ||
      inspected?.workspaceFolderValue !== undefined
    ) {
      return config.get<boolean>(`${SKILLS_SECTION}.zvecGrep`, false) === true;
    }
    return config.get<boolean>(`${OLLAMA_OPENCODE_SECTION}.zvecGrep`, false) === true;
  }

  private astCliSource(): AstGrepCliSource {
    return readTrustedAstGrepCliSource();
  }

  private astPathSetting(): string {
    return readTrustedAstGrepPath();
  }

  private async zvecSkillSnapshot(config: vscode.WorkspaceConfiguration): Promise<SkillCliSnapshot> {
    const cliSource = this.zvecCliSource();
    const localPath = this.zvecPathSetting();
    const bundledPath = bundledZvecGrepExecutable(this.skillRoots());
    // The `zg` shim is a `.cmd` on Windows, so the fallback the probe uses
    // when a value is refused matches the resolver's own fallback.
    const fallback = process.platform === 'win32' ? 'zg.cmd' : 'zg';
    const [local, bundled, detected] = await Promise.all([
      this.probeSkillCli(localPath, fallback),
      this.probeSkillCli(bundledPath, fallback),
      detectZvecGrep({
        source: cliSource,
        path: localPath,
        roots: this.skillRoots()
      })
    ]);
    const active = cliSource === 'bundled' ? bundled : local;
    return {
      enabled: this.zvecEnabled(config),
      cliSource,
      path: active.path,
      status: active.status,
      ...(active.version ? { version: active.version } : {}),
      local,
      bundled,
      connected: detected.enabled,
      cli: detected.cli
    };
  }

  private async astSkillSnapshot(config: vscode.WorkspaceConfiguration): Promise<SkillCliSnapshot> {
    const cliSource = this.astCliSource();
    const localPath = this.astPathSetting();
    const bundledPath = bundledAstGrepExecutable(this.skillRoots());
    const [local, bundled, detected] = await Promise.all([
      this.probeSkillCli(localPath, 'ast-grep'),
      this.probeSkillCli(bundledPath, 'ast-grep'),
      detectAstGrep({
        source: cliSource,
        path: localPath,
        roots: this.skillRoots()
      })
    ]);
    const active = cliSource === 'bundled' ? bundled : local;
    return {
      enabled: config.get<boolean>(`${SKILLS_SECTION}.astGrep`, false) === true,
      cliSource,
      path: active.path,
      status: active.status,
      ...(active.version ? { version: active.version } : {}),
      local,
      bundled,
      connected: detected.enabled,
      cli: detected.cli
    };
  }

  /**
   * Probe one skill CLI path.
   *
   * The value is resolved through the shared executable rules first, so a
   * relative path with a separator — or a Windows drive-relative path — is
   * never spawned from the workspace.
   */
  private async probeSkillCli(executable: string, fallback: string): Promise<OpencodeCliProbe> {
    const command = resolveProbedExecutable(executable, fallback);
    const result = await probeOpencode(command);
    return result.version !== undefined
      ? { path: command, status: result.status, version: result.version }
      : { path: command, status: result.status };
  }

  private async zvecGrepStatus(): Promise<{ enabled: boolean; cli: 'missing' | 'installed' }> {
    return detectZvecGrep({
      source: this.zvecCliSource(),
      path: this.zvecPathSetting(),
      roots: this.skillRoots()
    });
  }

  /**
   * Turn zvec-grep's OpenCode integration on or off. The stored flag is global,
   * matching the user OpenCode config the installer edits, and it is written
   * only after the CLI succeeds.
   *
   * The draft path is validated with the same rule the save path applies
   * before it is persisted: a relative path — with a separator, or in the
   * Windows drive-relative form — would name a file inside the repository, so
   * the value is refused and never stored. The refusal is surfaced on the
   * path field, not only in the result strip.
   */
  async setZvecGrep(
    enabled: boolean,
    draft?: { cliSource?: ZvecGrepCliSource; path?: string }
  ): Promise<ZvecGrepApplyResult & { fieldError?: SkillFieldError }> {
    const config = vscode.workspace.getConfiguration();
    const source = draft?.cliSource ?? this.zvecCliSource();
    const path = draft?.path ?? this.zvecPathSetting();
    if (draft?.cliSource !== undefined) {
      await config.update(`${SKILLS_SECTION}.zvecGrep.cliSource`, source, vscode.ConfigurationTarget.Global);
    }
    if (draft?.path !== undefined && source === 'local') {
      const pathError = skillCliPathError(draft.path, 'zg', 'zg CLI');
      if (pathError) {
        return {
          ok: false,
          enabled: false,
          cli: 'missing',
          message: pathError,
          fieldError: { field: 'zvecGrepPath', message: pathError }
        };
      }
      await config.update(`${SKILLS_SECTION}.zvecGrep.path`, path.trim() || 'zg', vscode.ConfigurationTarget.Global);
    }
    const result = await applyZvecGrep(enabled, {
      source,
      path,
      roots: this.skillRoots()
    });
    if (result.ok) {
      await config.update(`${SKILLS_SECTION}.zvecGrep`, enabled, vscode.ConfigurationTarget.Global);
      await config.update(`${OLLAMA_OPENCODE_SECTION}.zvecGrep`, enabled, vscode.ConfigurationTarget.Global);
    }
    return result;
  }

  /**
   * Turn ast-grep's OpenCode integration on or off.
   *
   * The draft path is validated with the same rule the save path applies
   * before it is persisted, and a refusal is surfaced on the path field.
   */
  async setAstGrep(
    enabled: boolean,
    draft?: { cliSource?: AstGrepCliSource; path?: string }
  ): Promise<AstGrepApplyResult & { fieldError?: SkillFieldError }> {
    const config = vscode.workspace.getConfiguration();
    const source = draft?.cliSource ?? this.astCliSource();
    const path = draft?.path ?? this.astPathSetting();
    if (draft?.cliSource !== undefined) {
      await config.update(`${SKILLS_SECTION}.astGrep.cliSource`, source, vscode.ConfigurationTarget.Global);
    }
    if (draft?.path !== undefined && source === 'local') {
      const pathError = skillCliPathError(draft.path, 'ast-grep', 'ast-grep CLI');
      if (pathError) {
        return {
          ok: false,
          enabled: false,
          cli: 'missing',
          path,
          message: pathError,
          fieldError: { field: 'astGrepPath', message: pathError }
        };
      }
      await config.update(
        `${SKILLS_SECTION}.astGrep.path`,
        path.trim() || 'ast-grep',
        vscode.ConfigurationTarget.Global
      );
    }
    const result = await applyAstGrep({
      enabled,
      source,
      path,
      roots: this.skillRoots()
    });
    if (result.ok) {
      await config.update(`${SKILLS_SECTION}.astGrep`, enabled, vscode.ConfigurationTarget.Global);
    }
    return result;
  }

  async installAstGrep(draft?: {
    cliSource?: AstGrepCliSource;
    path?: string;
  }): Promise<AstGrepInstallResult> {
    const config = vscode.workspace.getConfiguration();
    const source = draft?.cliSource ?? this.astCliSource();
    const path = draft?.path ?? this.astPathSetting();
    const installDir = astGrepInstallDirFor({ source, path, roots: this.skillRoots() });
    const executable = resolveAstGrepExecutable({ source, path, roots: this.skillRoots() });
    const probe = await probeOpencode(executable);
    if (probe.status === 'detected') {
      return { ok: true, message: 'ast-grep is already installed.', executablePath: executable };
    }
    const installed = await installAstGrepRelease({ installDir });
    if (installed.ok && source === 'local' && installed.executablePath) {
      await config.update(
        `${SKILLS_SECTION}.astGrep.path`,
        installed.executablePath,
        vscode.ConfigurationTarget.Global
      );
    }
    return installed;
  }

  async upgradeAstGrep(draft?: {
    cliSource?: AstGrepCliSource;
    path?: string;
  }): Promise<AstGrepInstallResult> {
    const source = draft?.cliSource ?? this.astCliSource();
    const path = draft?.path ?? this.astPathSetting();
    const installDir = astGrepInstallDirFor({ source, path, roots: this.skillRoots() });
    return installAstGrepRelease({ installDir });
  }

  async installZvecGrep(draft?: {
    cliSource?: ZvecGrepCliSource;
    path?: string;
  }): Promise<{ ok: boolean; message: string; path?: string }> {
    const source = draft?.cliSource ?? this.zvecCliSource();
    const path = draft?.path ?? this.zvecPathSetting();
    const roots = this.skillRoots();
    const executable = resolveZvecGrepExecutable({ source, path, roots });
    const probe = await probeOpencode(executable);
    if (probe.status === 'detected') {
      return { ok: true, message: 'zvec-grep is already installed.', path: executable };
    }
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const args =
      source === 'bundled'
        ? npmPrefixInstallArgs(bundledZvecGrepPrefix(roots))
        : ['install', '-g', '@zvec/zvec-grep'];
    const installed = await runCommand(npm, args, 180_000);
    if (installed.error || installed.code !== 0) {
      return {
        ok: false,
        message: installed.stderr.trim() || installed.stdout.trim() || 'zvec-grep could not be installed.'
      };
    }
    const resolved = resolveZvecGrepExecutable({ source, path, roots });
    return { ok: true, message: 'zvec-grep installed.', path: resolved };
  }

  /** Write the Ollama token to secret storage only. Never to settings. */
  async setOllamaToken(value: string): Promise<void> {
    await this.context.secrets.store(OLLAMA_TOKEN_SECRET_KEY, value);
  }

  /** Remove the Ollama token from secret storage only. */
  async clearOllamaToken(): Promise<void> {
    await this.context.secrets.delete(OLLAMA_TOKEN_SECRET_KEY);
  }

  /** Write the OpenCode Zen API key to secret storage only. */
  async setOpencodeZenToken(value: string): Promise<void> {
    await this.context.secrets.store(OPENCODE_ZEN_TOKEN_SECRET_KEY, value);
  }

  /** Remove the OpenCode Zen API key from secret storage only. */
  async clearOpencodeZenToken(): Promise<void> {
    await this.context.secrets.delete(OPENCODE_ZEN_TOKEN_SECRET_KEY);
  }

  /**
   * Download the official opencode release into the active install directory.
   *
   * Bundled writes under extension global storage (`opencode/bin`). Local writes
   * beside an absolute path, or into `~/.opencode/bin` for a bare name. The
   * CLI's own `upgrade` command is not used: it can report success without
   * replacing the binary the path setting points at.
   *
   * Optional draft overrides so Install/Update follow the settings dropdown
   * before Save. When omitted, the saved configuration is used.
   */
  async installOpencode(draft?: {
    cliSource?: OpencodeCliSource;
    path?: string;
  }): Promise<OpencodeInstallResult> {
    const config = vscode.workspace.getConfiguration();
    const target = this.opencodeActionTarget(draft);
    const probe = await probeOpencode(target.executable);
    if (probe.status === 'detected') {
      return { ok: true, message: 'opencode is already installed.' };
    }
    return this.downloadOpencodeRelease(config, target, 'installed');
  }

  /**
   * Replace the CLI for the draft (or saved) source with the latest GitHub release.
   *
   * Does not spawn `opencode upgrade`, which often leaves a custom install stale.
   */
  async upgradeOpencode(draft?: {
    cliSource?: OpencodeCliSource;
    path?: string;
  }): Promise<OpencodeUpgradeResult> {
    const config = vscode.workspace.getConfiguration();
    const target = this.opencodeActionTarget(draft);
    const before = await probeOpencode(target.executable);
    if (before.status !== 'detected') {
      return { ok: false, message: 'opencode is not connected. Check the path, then try again.' };
    }
    const installed = await this.downloadOpencodeRelease(config, target, 'updated');
    if (!installed.ok) {
      return { ok: false, message: installed.message };
    }
    const after = await probeOpencode(installed.executablePath ?? target.executable);
    if (after.status !== 'detected') {
      return {
        ok: false,
        message: 'opencode was downloaded, but it did not start. Check the path, then try again.'
      };
    }
    if (before.version && after.version && before.version === after.version) {
      return { ok: true, message: `Already up to date (${after.version}).` };
    }
    if (after.version) {
      return { ok: true, message: `Updated to ${after.version}.` };
    }
    return { ok: true, message: installed.message };
  }

  /** Resolve which CLI location Install/Update should write. */
  private opencodeActionTarget(
    draft?: { cliSource?: OpencodeCliSource; path?: string }
  ): { source: OpencodeCliSource; path: string; executable: string } {
    const source = draft?.cliSource ?? this.opencodeCliSource();
    const path =
      draft?.path !== undefined && draft.path.trim().length > 0
        ? draft.path.trim()
        : this.opencodePathSetting();
    const executable = resolveOpencodeExecutable({
      source,
      path,
      roots: this.opencodeRoots()
    });
    return { source, path, executable };
  }

  /**
   * Fetch the latest release into the directory for `source`, then point the
   * local path setting at the binary when the source is local. Also persists
   * the draft `cliSource` so the next turn uses what was just installed.
   */
  private async downloadOpencodeRelease(
    config: vscode.WorkspaceConfiguration,
    target: { source: OpencodeCliSource; path: string },
    verb: 'installed' | 'updated'
  ): Promise<OpencodeInstallResult> {
    const installDir = opencodeInstallDirFor({
      source: target.source,
      path: target.path,
      roots: this.opencodeRoots()
    });
    const installed = await installOpencodeRelease({
      installDir,
      // Bundled stays inside the extension tree; do not rewrite the user PATH.
      persistPath: target.source === 'local'
    });
    if (!installed.ok || !installed.executablePath) {
      return installed;
    }
    const after = await probeOpencode(installed.executablePath);
    if (after.status !== 'detected') {
      return {
        ok: false,
        message: 'opencode was downloaded, but it did not start. Check the path, then try again.'
      };
    }
    await config.update(
      `${OLLAMA_OPENCODE_SECTION}.cliSource`,
      target.source,
      vscode.ConfigurationTarget.Global
    );
    if (target.source === 'local') {
      await config.update(
        `${OLLAMA_OPENCODE_SECTION}.path`,
        installed.executablePath,
        vscode.ConfigurationTarget.Global
      );
    }
    const version = after.version ? ` ${after.version}` : '';
    return {
      ok: true,
      message: `opencode${version} ${verb}.`,
      executablePath: installed.executablePath
    };
  }

  /**
   * Run the Codex protocol checks against the configured CLI. A passing version
   * outside the built-in window is stored so the next connection allows it.
   * Never throws, and never returns a credential.
   */
  async validateCodexVersion(): Promise<CodexVersionCheckResult> {
    // The CLI path is trust-sensitive: it is the binary that is spawned, so
    // only the user's own value is used.
    const executable = readTrustedCodexExecutable();
    const folder = vscode.workspace.workspaceFolders?.[0];
    try {
      const result = await validateInstalledCodex({
        executable,
        cwd: folder ? folder.uri.fsPath : process.cwd()
      });
      if (result.ok && result.version) {
        await this.registry.allowCodexVersion(result.version);
      }
      return result;
    } catch {
      return {
        ok: false,
        message: 'The Codex version check did not finish. Try again.'
      };
    }
  }

  async testConnection(
    backendId: string,
    draft?: { cliSource?: OpencodeCliSource; path?: string }
  ): Promise<ConnectionTestResult> {
    // Persist draft CLI selection before probing OpenCode Zen so Check models
    // uses the CLI tab choice (local vs bundled) even before Save settings.
    if (backendId === 'opencode' && draft) {
      const config = vscode.workspace.getConfiguration();
      if (draft.cliSource === 'local' || draft.cliSource === 'bundled') {
        await config.update(
          `${OLLAMA_OPENCODE_SECTION}.cliSource`,
          draft.cliSource,
          vscode.ConfigurationTarget.Global
        );
      }
      if (draft.cliSource === 'local' && draft.path !== undefined && draft.path.trim()) {
        const pathError = opencodePathError(draft.path, (candidate) => existsSync(candidate));
        if (!pathError) {
          await config.update(
            `${OLLAMA_OPENCODE_SECTION}.path`,
            draft.path.trim(),
            vscode.ConfigurationTarget.Global
          );
        }
      }
    }
    const backend = this.registry.get(backendId);
    if (!backend) {
      return {
        backendId,
        outcome: 'unavailable',
        message: 'That provider is not available in this workspace.'
      };
    }
    if (backend.testConnection) {
      return backend.testConnection();
    }
    const status = await this.statusOf(backendId);
    return {
      backendId,
      outcome: status.status === 'available' ? 'ok' : 'invalid-key',
      message:
        status.status === 'available'
          ? 'The provider is reachable and ready.'
          : status.detail ?? 'The provider is not ready. Check its settings, then test again.'
    };
  }

  private readPermissionLevel(): PermissionLevel {
    return readDefaultPermissionLevel();
  }

  private readMode(): DefaultMode {
    return readDefaultMode();
  }

  private async readToken(): Promise<string | undefined> {
    return this.context.secrets.get(OLLAMA_TOKEN_SECRET_KEY);
  }

  private async readZenToken(): Promise<string | undefined> {
    return this.context.secrets.get(OPENCODE_ZEN_TOKEN_SECRET_KEY);
  }

  private async statusOf(
    backendId: string
  ): Promise<{ status: BackendStatus; detail?: string; version?: string; authMode?: string }> {
    const probe = this.registry.snapshot().find((entry) => entry.id === backendId);
    if (probe) {
      return { status: probe.status, detail: probe.detail, version: probe.version, authMode: probe.authMode };
    }

    const refreshed = await this.registry.refresh();
    const found = refreshed.find((entry) => entry.id === backendId);
    return found
      ? { status: found.status, detail: found.detail, version: found.version, authMode: found.authMode }
      : { status: 'unavailable' };
  }
}

/** A finite byte cap inside the documented range, or the default otherwise. */
function clampMaxBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CONTEXT_SETTINGS.maxBytes;
  }
  return Math.min(MAX_CONTEXT_BYTES, Math.max(MIN_CONTEXT_BYTES, Math.floor(value)));
}

/** The string entries of a configured array, ignoring anything else. */
function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The inline message for a refused Codex CLI path, or `undefined` when the
 * value may be stored.
 *
 * A relative path with a separator is refused: the child process runs with
 * the workspace as its working directory, so such a value would name a file
 * inside the repository. A Windows drive-relative value (`C:evil.exe`) is
 * refused for the same reason: Windows resolves it against the current
 * directory of that drive.
 */
function codexPathError(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Enter the CLI path or name. This value was not saved.';
  }
  const resolved = resolveExecutableCommand(trimmed, 'codex');
  return resolved.ok ? undefined : executablePathError(resolved.reason, 'Codex CLI');
}
