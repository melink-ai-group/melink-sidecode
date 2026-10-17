import * as vscode from 'vscode';
import { OLLAMA_TOKEN_SECRET_KEY } from './backends/secrets';
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
  opencodeInstallDirFor,
  readOpencodeCliSource,
  resolveOpencodeExecutable,
  type OpencodeCliSource
} from './backends/opencode/resolve';
import {
  opencodePathError,
  probeOpencode,
  type OpencodeProbeResult,
  type OpencodeUpgradeResult
} from './backends/opencode/status';
import { applyZvecGrep, detectZvecGrep, type ZvecGrepApplyResult, type ZvecGrepStatus } from './backends/opencode/zvecGrep';
import { browserLaunchError } from './browser/skill.ts';
import { validateInstalledCodex, type CodexVersionCheckResult } from './backends/codex/versionCheckRun.ts';
import { browserSkillEnabled } from './browser/policy.ts';
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
 */

const OLLAMA_SECTION = 'melink.ollama';
const OLLAMA_OPENCODE_SECTION = 'melink.ollama.opencode';
const CODEX_SECTION = 'melink.codex';
const DEFAULTS_SECTION = 'melink.defaults';
const SKILLS_SECTION = 'melink.skills';

export { PERMISSION_LEVELS } from './backends/types';
export { DEFAULT_MODES };

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
   * Where the screen writes: the workspace when a folder is open, otherwise the
   * user (global) scope. The snapshot reports this same value, so the header
   * label always matches where a Save actually lands.
   */
  private get target(): vscode.ConfigurationTarget {
    return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  }

  /** The scope name matching `target`, shown in the screen's header. */
  private get targetName(): 'workspace' | 'global' {
    return this.target === vscode.ConfigurationTarget.Workspace ? 'workspace' : 'global';
  }

  /** The settings screen's read model. Async because the token check is. */
  async snapshot(): Promise<SettingsSnapshot> {
    const config = vscode.workspace.getConfiguration();
    const [ollamaStatus, codexStatus] = await Promise.all([
      this.statusOf('ollama'),
      this.statusOf('codex')
    ]);
    const hasToken = Boolean(await this.readToken());
    return {
      target: this.targetName,
      ollama: {
        baseUrl: config.get<string>(`${OLLAMA_SECTION}.baseUrl`, 'https://ollama.com'),
        defaultModel: config.get<string>(`${OLLAMA_SECTION}.defaultModel`, ''),
        hasToken,
        status: ollamaStatus.status,
        detail: ollamaStatus.detail
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
      skills: {
        browser: browserSkillEnabled(config.get<unknown>(`${SKILLS_SECTION}.browser`, true)),
        browserError: browserLaunchError()
      },
      models: {}
    };
  }

  /**
   * Validate then persist a patch. An invalid field is reported and skipped, so
   * an invalid value is never written; every control maps to a real write.
   */
  async save(patch: SettingsPatch): Promise<SaveResult> {
    const errors: Partial<Record<keyof SettingsPatch, string>> = {};
    const config = vscode.workspace.getConfiguration();

    if (patch.ollamaBaseUrl !== undefined) {
      const value = patch.ollamaBaseUrl.trim();
      if (!isHttpUrl(value)) {
        errors.ollamaBaseUrl = 'Enter a full URL, like https://ollama.com. This value was not saved.';
      } else {
        await config.update(`${OLLAMA_SECTION}.baseUrl`, value, this.target);
      }
    }

    if (patch.codexPath !== undefined) {
      const value = patch.codexPath.trim();
      if (!value) {
        errors.codexPath = 'Enter the CLI path or name. This value was not saved.';
      } else {
        await config.update(`${CODEX_SECTION}.path`, value, this.target);
      }
    }

    if (patch.ollamaDefaultModel !== undefined) {
      await config.update(
        `${OLLAMA_SECTION}.defaultModel`,
        patch.ollamaDefaultModel.trim(),
        this.target
      );
    }

    if (patch.codexDefaultModel !== undefined) {
      await config.update(
        `${CODEX_SECTION}.defaultModel`,
        patch.codexDefaultModel.trim(),
        this.target
      );
    }

    if (patch.permissionLevel !== undefined) {
      if (!PERMISSION_LEVELS.includes(patch.permissionLevel)) {
        errors.permissionLevel = 'Pick one of the listed permission levels. This value was not saved.';
      } else {
        await config.update(`${DEFAULTS_SECTION}.permissionLevel`, patch.permissionLevel, this.target);
      }
    }

    if (patch.mode !== undefined) {
      if (!DEFAULT_MODES.includes(patch.mode)) {
        errors.mode = 'Pick one of the listed modes. This value was not saved.';
      } else {
        await config.update(`${DEFAULTS_SECTION}.mode`, patch.mode, this.target);
      }
    }

    if (patch.thinking !== undefined) {
      if (patch.thinking !== '' && !isThinkingLevel(patch.thinking)) {
        errors.thinking = 'Pick one of the listed thinking levels. This value was not saved.';
      } else {
        await config.update(`${DEFAULTS_SECTION}.thinking`, patch.thinking || undefined, this.target);
      }
    }

    if (patch.dictationModel !== undefined) {
      await config.update(`${DEFAULTS_SECTION}.dictationModel`, patch.dictationModel.trim(), this.target);
    }

    if (patch.opencodeEnabled !== undefined) {
      await config.update(`${OLLAMA_OPENCODE_SECTION}.enabled`, patch.opencodeEnabled, this.target);
    }

    if (patch.opencodeCliSource !== undefined) {
      if (patch.opencodeCliSource !== 'local' && patch.opencodeCliSource !== 'bundled') {
        errors.opencodeCliSource = 'Pick local machine or bundled. This value was not saved.';
      } else {
        await config.update(`${OLLAMA_OPENCODE_SECTION}.cliSource`, patch.opencodeCliSource, this.target);
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
        await config.update(`${OLLAMA_OPENCODE_SECTION}.path`, patch.opencodePath.trim(), this.target);
      }
    }

    if (patch.contextIncludeInstructions !== undefined) {
      await config.update(`${CONTEXT_SECTION}.includeInstructions`, patch.contextIncludeInstructions, this.target);
    }

    if (patch.contextIncludeShape !== undefined) {
      await config.update(`${CONTEXT_SECTION}.includeShape`, patch.contextIncludeShape, this.target);
    }

    if (patch.contextIncludeEditorState !== undefined) {
      await config.update(`${CONTEXT_SECTION}.includeEditorState`, patch.contextIncludeEditorState, this.target);
    }

    if (patch.contextIncludeSelection !== undefined) {
      await config.update(`${CONTEXT_SECTION}.includeSelection`, patch.contextIncludeSelection, this.target);
    }

    if (patch.contextIncludeChangedFiles !== undefined) {
      await config.update(`${CONTEXT_SECTION}.includeChangedFiles`, patch.contextIncludeChangedFiles, this.target);
    }

    if (patch.contextMaxBytes !== undefined) {
      const value = Math.floor(patch.contextMaxBytes);
      if (!Number.isFinite(value) || value < MIN_CONTEXT_BYTES || value > MAX_CONTEXT_BYTES) {
        errors.contextMaxBytes = `Enter a whole number between ${MIN_CONTEXT_BYTES} and ${MAX_CONTEXT_BYTES}. This value was not saved.`;
      } else {
        await config.update(`${CONTEXT_SECTION}.maxBytes`, value, this.target);
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
        await config.update(`${CONTEXT_SECTION}.exclude`, cleaned, this.target);
      }
    }

    if (patch.browser !== undefined) {
      await config.update(`${SKILLS_SECTION}.browser`, patch.browser === true, this.target);
    }

    return { ok: Object.keys(errors).length === 0, errors };
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

  private opencodeRoots(): { extensionPath: string } {
    return { extensionPath: this.context.extensionPath };
  }

  /** Executable every opencode spawn and probe must use. */
  private resolveOpencode(config: vscode.WorkspaceConfiguration): string {
    return resolveOpencodeExecutable({
      source: this.opencodeCliSource(config),
      path: this.opencodePathSetting(config),
      roots: this.opencodeRoots()
    });
  }

  /**
   * The runtime read model for the settings screen. The CLI is probed only when
   * the setting is on: with it off no process is spawned, and `status` is a
   * placeholder the screen ignores in favour of the `enabled` flag (which drives
   * the disabled state). A probe never throws; a missing or unrunnable CLI is
   * data, exactly like backend availability.
   */
  private async opencodeSnapshot(
    config: vscode.WorkspaceConfiguration
  ): Promise<SettingsSnapshot['opencode']> {
    const enabled = this.opencodeEnabled(config);
    const cliSource = this.opencodeCliSource(config);
    const path = this.resolveOpencode(config);
    if (!enabled) {
      return {
        enabled,
        cliSource,
        path,
        status: 'missing',
        zvecGrep: { enabled: false, cli: 'missing' }
      };
    }
    const result: OpencodeProbeResult = await probeOpencode(path);
    const zvecGrep = await this.zvecGrepStatus();
    return result.version !== undefined
      ? { enabled, cliSource, path, status: result.status, version: result.version, zvecGrep }
      : { enabled, cliSource, path, status: result.status, zvecGrep };
  }

  /**
   * Whether zvec-grep is connected to OpenCode. Probed only while the runtime
   * is on, and never installed or removed from here: a default of off must not
   * uninstall an integration the user created outside the sidebar.
   */
  private async zvecGrepStatus(): Promise<ZvecGrepStatus> {
    const config = vscode.workspace.getConfiguration();
    if (!this.opencodeEnabled(config)) {
      return { enabled: false, cli: 'missing' };
    }
    return detectZvecGrep();
  }

  /**
   * Turn zvec-grep's OpenCode integration on or off. The stored flag is global,
   * matching the user OpenCode config the installer edits, and it is written
   * only after the CLI succeeds.
   */
  async setZvecGrep(enabled: boolean): Promise<ZvecGrepApplyResult> {
    const config = vscode.workspace.getConfiguration();
    if (!this.opencodeEnabled(config)) {
      return { ok: false, enabled: false, cli: 'missing', message: 'Turn on opencode before using zvec-grep.' };
    }
    const result = await applyZvecGrep(enabled);
    if (result.ok) {
      await config.update(`${OLLAMA_OPENCODE_SECTION}.zvecGrep`, enabled, vscode.ConfigurationTarget.Global);
    }
    return result;
  }

  /** Write the Ollama token to secret storage only. Never to settings. */
  async setOllamaToken(value: string): Promise<void> {
    await this.context.secrets.store(OLLAMA_TOKEN_SECRET_KEY, value);
  }

  /** Remove the Ollama token from secret storage only. */
  async clearOllamaToken(): Promise<void> {
    await this.context.secrets.delete(OLLAMA_TOKEN_SECRET_KEY);
  }

  /**
   * Download the official opencode release into the active install directory.
   *
   * Bundled writes under `vendor/opencode/bin`. Local writes beside an absolute
   * path, or into `~/.opencode/bin` for a bare name. The CLI's own `upgrade`
   * command is not used: it can report success without replacing the binary
   * the path setting points at.
   */
  async installOpencode(): Promise<OpencodeInstallResult> {
    const config = vscode.workspace.getConfiguration();
    const enabled = this.opencodeEnabled(config);
    if (!enabled) {
      return { ok: false, message: 'Turn on opencode before installing it.' };
    }
    const source = this.opencodeCliSource(config);
    const executable = this.resolveOpencode(config);
    const probe = await probeOpencode(executable);
    if (probe.status === 'detected') {
      return { ok: true, message: 'opencode is already installed.' };
    }
    return this.downloadOpencodeRelease(config, source, 'installed');
  }

  /**
   * Replace the active CLI with the latest GitHub release in place.
   *
   * Same download path as install. Does not spawn `opencode upgrade`, which
   * often leaves a custom or non-npm install on the previous version.
   */
  async upgradeOpencode(): Promise<OpencodeUpgradeResult> {
    const config = vscode.workspace.getConfiguration();
    const enabled = this.opencodeEnabled(config);
    if (!enabled) {
      return { ok: false, message: 'Turn on opencode before updating it.' };
    }
    const source = this.opencodeCliSource(config);
    const executable = this.resolveOpencode(config);
    const before = await probeOpencode(executable);
    if (before.status !== 'detected') {
      return { ok: false, message: 'opencode is not connected. Check the path, then try again.' };
    }
    const installed = await this.downloadOpencodeRelease(config, source, 'updated');
    if (!installed.ok) {
      return { ok: false, message: installed.message };
    }
    const after = await probeOpencode(installed.executablePath ?? executable);
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

  /**
   * Fetch the latest release into the directory for `source`, then point the
   * local path setting at the binary when the source is local.
   */
  private async downloadOpencodeRelease(
    config: vscode.WorkspaceConfiguration,
    source: OpencodeCliSource,
    verb: 'installed' | 'updated'
  ): Promise<OpencodeInstallResult> {
    const installDir = opencodeInstallDirFor({
      source,
      path: this.opencodePathSetting(config),
      roots: this.opencodeRoots()
    });
    const installed = await installOpencodeRelease({
      installDir,
      // Bundled stays inside the extension tree; do not rewrite the user PATH.
      persistPath: source === 'local'
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
    if (source === 'local') {
      await config.update(`${OLLAMA_OPENCODE_SECTION}.path`, installed.executablePath, this.target);
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

  async testConnection(backendId: string): Promise<ConnectionTestResult> {
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
