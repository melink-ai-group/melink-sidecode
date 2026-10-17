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
  readOpencodeCliSource,
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
  readAstGrepCliSource,
  resolveAstGrepExecutable,
  type AstGrepCliSource
} from './backends/astGrep/resolve.ts';
import {
  bundledZvecGrepExecutable,
  bundledZvecGrepPrefix,
  readZvecGrepCliSource,
  resolveZvecGrepExecutable,
  type ZvecGrepCliSource
} from './backends/zvecGrep/resolve.ts';
import { npmPrefixInstallArgs, runCommand } from './backends/opencode/zvecGrep.ts';
import { browserLaunchError } from './browser/skill.ts';
import { validateInstalledCodex, type CodexVersionCheckResult } from './backends/codex/versionCheckRun.ts';
import { browserSkillEnabledFor, configuredSettingValue } from './browser/policy.ts';
import type { OpencodeCliProbe, SkillCliSnapshot } from './protocol';
import { readSkillCliSource } from './backends/skillCli.ts';
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
 * Reads use VS Code's normal merge (workspace overrides user). The primary Save
 * always writes user (global) settings; when any workspace override exists, the
 * screen can also Save to workspace.
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

/** Outcome of validating and writing one patch. */
export interface SaveResult {
  ok: boolean;
  /** Field-keyed messages; a field with a message is never persisted. */
  errors: Partial<Record<keyof SettingsPatch, string>>;
}

export class SettingsService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: BackendRegistry
  ) {}

  /**
   * Effective scope for the header: `workspace` when any SideCode key is set in
   * workspace (or folder) settings — those values win on read — otherwise
   * `global`. Primary Save always writes global regardless.
   */
  private targetName(config: vscode.WorkspaceConfiguration): 'workspace' | 'global' {
    return this.hasWorkspaceSettings(config) ? 'workspace' : 'global';
  }

  /** True when any managed key has a workspace or folder override. */
  private hasWorkspaceSettings(config: vscode.WorkspaceConfiguration): boolean {
    for (const key of SETTINGS_KEYS) {
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
        baseUrl: config.get<string>(`${OLLAMA_SECTION}.baseUrl`, 'https://ollama.com'),
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
        path: config.get<string>(`${CODEX_SECTION}.path`, 'codex'),
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
   */
  async save(patch: SettingsPatch, scope: SettingsSaveTarget = 'global'): Promise<SaveResult> {
    const errors: Partial<Record<keyof SettingsPatch, string>> = {};
    const config = vscode.workspace.getConfiguration();
    const target = this.configurationTarget(scope);

    if (patch.ollamaBaseUrl !== undefined) {
      const value = patch.ollamaBaseUrl.trim();
      if (!isHttpUrl(value)) {
        errors.ollamaBaseUrl = 'Enter a full URL, like https://ollama.com. This value was not saved.';
      } else {
        await config.update(`${OLLAMA_SECTION}.baseUrl`, value, target);
      }
    }

    if (patch.codexPath !== undefined) {
      const value = patch.codexPath.trim();
      if (!value) {
        errors.codexPath = 'Enter the CLI path or name. This value was not saved.';
      } else {
        await config.update(`${CODEX_SECTION}.path`, value, target);
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
        await config.update(`${DEFAULTS_SECTION}.permissionLevel`, patch.permissionLevel, target);
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
        await config.update(`${OLLAMA_OPENCODE_SECTION}.cliSource`, patch.opencodeCliSource, target);
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
        await config.update(`${OLLAMA_OPENCODE_SECTION}.path`, patch.opencodePath.trim(), target);
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
        target
      );
    }
    if (patch.zvecGrepPath !== undefined && (patch.zvecGrepCliSource ?? this.zvecCliSource(config)) === 'local') {
      await config.update(`${SKILLS_SECTION}.zvecGrep.path`, patch.zvecGrepPath.trim() || 'zg', target);
    }
    if (patch.astGrepCliSource !== undefined) {
      await config.update(
        `${SKILLS_SECTION}.astGrep.cliSource`,
        readSkillCliSource(patch.astGrepCliSource),
        target
      );
    }
    if (patch.astGrepPath !== undefined && (patch.astGrepCliSource ?? this.astCliSource(config)) === 'local') {
      await config.update(`${SKILLS_SECTION}.astGrep.path`, patch.astGrepPath.trim() || 'ast-grep', target);
    }

    return { ok: Object.keys(errors).length === 0, errors };
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
  private opencodePathSetting(config: vscode.WorkspaceConfiguration): string {
    return config.get<string>(`${OLLAMA_OPENCODE_SECTION}.path`, 'opencode') || 'opencode';
  }

  private opencodeCliSource(config: vscode.WorkspaceConfiguration): OpencodeCliSource {
    return readOpencodeCliSource(config.get<unknown>(`${OLLAMA_OPENCODE_SECTION}.cliSource`));
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
    const cliSource = this.opencodeCliSource(config);
    const localPath = this.opencodePathSetting(config);
    const bundledPath = bundledOpencodeExecutable(this.opencodeRoots());
    const [local, bundled] = await Promise.all([
      this.probeCli(localPath),
      this.probeCli(bundledPath)
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

  private async probeCli(executable: string): Promise<OpencodeCliProbe> {
    const result = await probeOpencode(executable);
    return result.version !== undefined
      ? { path: executable, status: result.status, version: result.version }
      : { path: executable, status: result.status };
  }

  private skillRoots(): { extensionPath: string; globalStoragePath: string } {
    return {
      extensionPath: this.context.extensionPath,
      globalStoragePath: this.context.globalStorageUri.fsPath
    };
  }

  private zvecCliSource(config: vscode.WorkspaceConfiguration): ZvecGrepCliSource {
    return readZvecGrepCliSource(config.get<unknown>(`${SKILLS_SECTION}.zvecGrep.cliSource`));
  }

  private zvecPathSetting(config: vscode.WorkspaceConfiguration): string {
    return config.get<string>(`${SKILLS_SECTION}.zvecGrep.path`, 'zg') || 'zg';
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

  private astCliSource(config: vscode.WorkspaceConfiguration): AstGrepCliSource {
    return readAstGrepCliSource(config.get<unknown>(`${SKILLS_SECTION}.astGrep.cliSource`));
  }

  private astPathSetting(config: vscode.WorkspaceConfiguration): string {
    return config.get<string>(`${SKILLS_SECTION}.astGrep.path`, 'ast-grep') || 'ast-grep';
  }

  private async zvecSkillSnapshot(config: vscode.WorkspaceConfiguration): Promise<SkillCliSnapshot> {
    const cliSource = this.zvecCliSource(config);
    const localPath = this.zvecPathSetting(config);
    const bundledPath = bundledZvecGrepExecutable(this.skillRoots());
    const [local, bundled, detected] = await Promise.all([
      this.probeSkillCli(localPath),
      this.probeSkillCli(bundledPath),
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
    const cliSource = this.astCliSource(config);
    const localPath = this.astPathSetting(config);
    const bundledPath = bundledAstGrepExecutable(this.skillRoots());
    const [local, bundled, detected] = await Promise.all([
      this.probeSkillCli(localPath),
      this.probeSkillCli(bundledPath),
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

  private async probeSkillCli(executable: string): Promise<OpencodeCliProbe> {
    const result = await probeOpencode(executable);
    return result.version !== undefined
      ? { path: executable, status: result.status, version: result.version }
      : { path: executable, status: result.status };
  }

  private async zvecGrepStatus(): Promise<{ enabled: boolean; cli: 'missing' | 'installed' }> {
    const config = vscode.workspace.getConfiguration();
    return detectZvecGrep({
      source: this.zvecCliSource(config),
      path: this.zvecPathSetting(config),
      roots: this.skillRoots()
    });
  }

  /**
   * Turn zvec-grep's OpenCode integration on or off. The stored flag is global,
   * matching the user OpenCode config the installer edits, and it is written
   * only after the CLI succeeds.
   */
  async setZvecGrep(
    enabled: boolean,
    draft?: { cliSource?: ZvecGrepCliSource; path?: string }
  ): Promise<ZvecGrepApplyResult> {
    const config = vscode.workspace.getConfiguration();
    const source = draft?.cliSource ?? this.zvecCliSource(config);
    const path = draft?.path ?? this.zvecPathSetting(config);
    if (draft?.cliSource !== undefined) {
      await config.update(`${SKILLS_SECTION}.zvecGrep.cliSource`, source, vscode.ConfigurationTarget.Global);
    }
    if (draft?.path !== undefined && source === 'local') {
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

  async setAstGrep(
    enabled: boolean,
    draft?: { cliSource?: AstGrepCliSource; path?: string }
  ): Promise<AstGrepApplyResult> {
    const config = vscode.workspace.getConfiguration();
    const source = draft?.cliSource ?? this.astCliSource(config);
    const path = draft?.path ?? this.astPathSetting(config);
    if (draft?.cliSource !== undefined) {
      await config.update(`${SKILLS_SECTION}.astGrep.cliSource`, source, vscode.ConfigurationTarget.Global);
    }
    if (draft?.path !== undefined && source === 'local') {
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
    const source = draft?.cliSource ?? this.astCliSource(config);
    const path = draft?.path ?? this.astPathSetting(config);
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
    const config = vscode.workspace.getConfiguration();
    const source = draft?.cliSource ?? this.astCliSource(config);
    const path = draft?.path ?? this.astPathSetting(config);
    const installDir = astGrepInstallDirFor({ source, path, roots: this.skillRoots() });
    return installAstGrepRelease({ installDir });
  }

  async installZvecGrep(draft?: {
    cliSource?: ZvecGrepCliSource;
    path?: string;
  }): Promise<{ ok: boolean; message: string; path?: string }> {
    const config = vscode.workspace.getConfiguration();
    const source = draft?.cliSource ?? this.zvecCliSource(config);
    const path = draft?.path ?? this.zvecPathSetting(config);
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
    const target = this.opencodeActionTarget(config, draft);
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
    const target = this.opencodeActionTarget(config, draft);
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
    config: vscode.WorkspaceConfiguration,
    draft?: { cliSource?: OpencodeCliSource; path?: string }
  ): { source: OpencodeCliSource; path: string; executable: string } {
    const source = draft?.cliSource ?? this.opencodeCliSource(config);
    const path =
      draft?.path !== undefined && draft.path.trim().length > 0
        ? draft.path.trim()
        : this.opencodePathSetting(config);
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
    const executable = vscode.workspace.getConfiguration(CODEX_SECTION).get<string>('path', 'codex') || 'codex';
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
