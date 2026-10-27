import * as vscode from 'vscode';
import { OLLAMA_TOKEN_SECRET_KEY, OPENCODE_ZEN_TOKEN_SECRET_KEY } from './backends/secrets';
import type { BackendRegistry } from './backends/registry';
import type { BackendStatus, ConnectionTestResult, DefaultMode, PermissionLevel } from './backends/types';
import { DEFAULT_MODES } from './backends/modes';
import { SKILLS_SECTION } from './settingsKeys';
import { readDefaultMode, readDefaultPermissionLevel, readDefaultThinking } from './backends/defaults';
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
import {
  npmPrefixInstallArgs,
  probeExecutableVersion,
  runCommand,
  runCommandAt,
  zvecVersionSupported
} from './backends/opencode/zvecGrep.ts';
import {
  buildZvecIndex as runZvecIndexBuild,
  readZvecIndexState,
  zvecIndexGuidance,
  type ZvecIndexBuildResult,
  type ZvecIndexState
} from './backends/opencode/zvecIndex.ts';
import {
  astGrepMcpScriptPath,
  astGrepOpencodeServer,
  zvecGrepOpencodeServer
} from './skills/opencodeMcp.ts';
import { probeOpencodeServer } from './skills/mcpProbe.ts';
import { skillToggleWrites } from './settings/skillWrites.ts';
import { browserLaunchError } from './browser/skill.ts';
import { validateInstalledCodex, type CodexVersionCheckResult } from './backends/codex/versionCheckRun.ts';
import { browserSkillEnabledFor, configuredSettingValue } from './browser/policy.ts';
import type { OpencodeCliProbe, SkillCliSnapshot } from './protocol';
import { skillCliPathError } from './backends/skillCli.ts';
import { resolveProbedExecutable } from './backends/executables.ts';
import { resolveWriteScope, trustedBoolean } from './config/trust.ts';
import {
  readTrustedAstGrepCliSource,
  readTrustedAstGrepPath,
  readTrustedBaseUrl,
  readTrustedCodexExecutable,
  readTrustedCodexPath,
  readTrustedOllamaLocalBaseUrl,
  readTrustedOpencodeCliSource,
  readTrustedOpencodePath,
  readTrustedZvecGrepCliSource,
  readTrustedZvecGrepPath
} from './config/settings.ts';
import { resolveOrchestrationSettings } from './orchestration/settings';
import {
  executeSettingsWrites,
  planSettingsWrites,
  type SettingsSaveTarget
} from './settings/planWrites.ts';
import { effectiveSettingsTarget } from './config/settingsScope.ts';
import {
  CONTEXT_SECTION,
  DEFAULT_CONTEXT_SETTINGS,
  MAX_CONTEXT_BYTES,
  MIN_CONTEXT_BYTES
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
const OLLAMA_LOCAL_SECTION = 'melink.ollamaLocal';
const OLLAMA_OPENCODE_SECTION = 'melink.ollama.opencode';
const OPENCODE_SECTION = 'melink.opencode';
const CODEX_SECTION = 'melink.codex';
const DEFAULTS_SECTION = 'melink.defaults';
const ORCHESTRATION_SECTION = 'melink.orchestration';
const LEGACY_TESTING_KEY = 'melink.review.checks.enabled';
const LEGACY_REVIEWING_KEY = 'melink.review.diffReview';

/**
 * Keys the settings screen reads and writes. Used to detect whether a workspace
 * `.vscode/settings.json` (or folder settings) already overrides any of them.
 */
const SETTINGS_KEYS: readonly string[] = [
  `${OLLAMA_SECTION}.enabled`,
  `${OLLAMA_SECTION}.baseUrl`,
  `${OLLAMA_SECTION}.defaultModel`,
  `${OLLAMA_LOCAL_SECTION}.enabled`,
  `${OLLAMA_LOCAL_SECTION}.baseUrl`,
  `${OLLAMA_LOCAL_SECTION}.defaultModel`,
  `${OPENCODE_SECTION}.enabled`,
  `${OPENCODE_SECTION}.defaultModel`,
  `${OLLAMA_OPENCODE_SECTION}.path`,
  `${OLLAMA_OPENCODE_SECTION}.cliSource`,
  `${OLLAMA_OPENCODE_SECTION}.zvecGrep`,
  `${CODEX_SECTION}.enabled`,
  `${CODEX_SECTION}.path`,
  `${CODEX_SECTION}.defaultModel`,
  `${DEFAULTS_SECTION}.permissionLevel`,
  `${DEFAULTS_SECTION}.mode`,
  `${DEFAULTS_SECTION}.thinking`,
  `${DEFAULTS_SECTION}.dictationModel`,
  `${ORCHESTRATION_SECTION}.testing`,
  `${ORCHESTRATION_SECTION}.reviewing`,
  `${ORCHESTRATION_SECTION}.styling`,
  `${ORCHESTRATION_SECTION}.doubleCheck`,
  `${ORCHESTRATION_SECTION}.quickTask`,
  `${ORCHESTRATION_SECTION}.planning`,
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
   * Effective scope for the header and the primary save: `folder` when any
   * managed key has a folder override, otherwise `workspace` when one has a
   * workspace override, otherwise `global`. Those are the values that win on
   * read, so the primary save writes the same scope instead of a user value
   * that the override would keep hiding.
   *
   * A trust-sensitive key never counts: its workspace/folder value is ignored,
   * so the screen must not claim that scope is in charge of it.
   */
  private targetName(config: vscode.WorkspaceConfiguration): SettingsSaveTarget {
    return effectiveSettingsTarget(
      SETTINGS_KEYS.map((key) => ({ key, inspected: config.inspect(key) }))
    );
  }

  private configurationTarget(scope: SettingsSaveTarget): vscode.ConfigurationTarget {
    if (scope === 'folder') {
      return vscode.ConfigurationTarget.WorkspaceFolder;
    }
    return scope === 'workspace'
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  }

  /** The settings screen's read model. Async because the token check is. */
  async snapshot(): Promise<SettingsSnapshot> {
    const config = vscode.workspace.getConfiguration();
    const [ollamaStatus, ollamaLocalStatus, opencodeStatus, codexStatus] = await Promise.all([
      this.statusOf('ollama'),
      this.statusOf('ollama-local'),
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
        enabled: config.get<boolean>(`${OLLAMA_SECTION}.enabled`, true) !== false,
        status: ollamaStatus.status,
        detail: ollamaStatus.detail
      },
      ollamaLocal: {
        // No credential is sent, but the destination is still user-scoped.
        baseUrl: readTrustedOllamaLocalBaseUrl(),
        defaultModel: config.get<string>(`${OLLAMA_LOCAL_SECTION}.defaultModel`, ''),
        enabled: config.get<boolean>(`${OLLAMA_LOCAL_SECTION}.enabled`, true) !== false,
        status: ollamaLocalStatus.status,
        detail: ollamaLocalStatus.detail
      },
      opencodeZen: {
        defaultModel: config.get<string>(`${OPENCODE_SECTION}.defaultModel`, ''),
        hasToken: hasZenToken,
        enabled: config.get<boolean>(`${OPENCODE_SECTION}.enabled`, true) !== false,
        status: opencodeStatus.status,
        detail: opencodeStatus.detail
      },
      codex: {
        // The CLI path is trust-sensitive: it is the binary that is spawned.
        path: readTrustedCodexPath(),
        defaultModel: config.get<string>(`${CODEX_SECTION}.defaultModel`, ''),
        enabled: config.get<boolean>(`${CODEX_SECTION}.enabled`, true) !== false,
        status: codexStatus.status,
        detail: codexStatus.detail,
        version: codexStatus.version,
        authMode: codexStatus.authMode
      },
      opencode: await this.opencodeSnapshot(),
      defaults: {
        permissionLevel: this.readPermissionLevel(),
        mode: this.readMode(),
        thinking: readDefaultThinking(),
        dictationModel: config.get<string>(`${DEFAULTS_SECTION}.dictationModel`, '')
      },
      context: this.contextSnapshot(config),
      orchestration: this.orchestrationSnapshot(config),
      skills: await this.skillsSnapshot(config),
      models: {}
    };
  }

  /**
   * Validate then persist a patch. An invalid field is reported and skipped, so
   * an invalid value is never written; every control maps to a real write.
   * Defaults to user (global) settings; pass `workspace` or `folder` only when
   * the screen's primary save action asks for the scope that controls the
   * shown values.
   *
   * Each field resolves to the nearest existing override (folder > workspace)
   * so a folder value can no longer keep winning while a workspace write looks
   * like it succeeded. A user-settings save stays global.
   *
   * The decision lives in the host-free `planSettingsWrites`, which also means
   * a test can enumerate every field and prove a control is not inert. Execution
   * is one `config.update` per write, and a rejected write is named on its field
   * rather than aborting the rest of the patch: a partial save is reported
   * honestly instead of looking like success or disappearing.
   *
   * A trust-sensitive key (base URL, CLI path, CLI source, permission level)
   * is always written to the user's own settings: a workspace or folder write
   * would be ignored on the next read, so it would look like it worked and
   * change nothing. The screen learns the outcome from the echoed snapshot.
   */
  async save(patch: SettingsPatch, scope: SettingsSaveTarget = 'global'): Promise<SaveResult> {
    const config = vscode.workspace.getConfiguration();
    const plan = planSettingsWrites(patch, scope, {
      pathExists: (candidate) => existsSync(candidate),
      scopeFor: (key) => resolveWriteScope(scope, config.inspect(key))
    });
    return executeSettingsWrites(plan, async (write) => {
      await config.update(write.key, write.value, this.configurationTarget(write.scope));
    });
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

  /**
   * The effective per-turn orchestration policy.
   *
   * The new `melink.orchestration.*` key wins at the nearest explicit scope;
   * when it is unset, the pre-T106 review key is the fallback (so an existing
   * `melink.review.checks.enabled` / `melink.review.diffReview` choice is not
   * silently discarded). The source flags drive the screen's explanation.
   */
  private orchestrationSnapshot(
    config: vscode.WorkspaceConfiguration
  ): SettingsSnapshot['orchestration'] {
    const inspect = (key: string): ReturnType<vscode.WorkspaceConfiguration['inspect']> =>
      config.inspect<unknown>(key);
    return resolveOrchestrationSettings({
      testing: inspect(`${ORCHESTRATION_SECTION}.testing`),
      reviewing: inspect(`${ORCHESTRATION_SECTION}.reviewing`),
      styling: inspect(`${ORCHESTRATION_SECTION}.styling`),
      doubleCheck: inspect(`${ORCHESTRATION_SECTION}.doubleCheck`),
      quickTask: inspect(`${ORCHESTRATION_SECTION}.quickTask`),
      planning: inspect(`${ORCHESTRATION_SECTION}.planning`),
      legacyTesting: inspect(LEGACY_TESTING_KEY),
      legacyReviewing: inspect(LEGACY_REVIEWING_KEY)
    });
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
   * the CLI tab and OpenCode Zen can report status. A probe never throws; a
   * missing or unrunnable CLI is data, exactly like backend availability.
   */
  private async opencodeSnapshot(): Promise<SettingsSnapshot['opencode']> {
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
    if (inspected?.globalValue !== undefined) {
      return trustedBoolean(inspected, false);
    }
    // Legacy fallback only while the skills key has never been set globally.
    return trustedBoolean(config.inspect<boolean>(`${OLLAMA_OPENCODE_SECTION}.zvecGrep`), false);
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
    const executable = resolveZvecGrepExecutable({
      source: cliSource,
      path: localPath,
      roots: this.skillRoots()
    });
    const workspaceRoot = this.skillWorkspaceRoot();
    let index: ZvecIndexState | undefined;
    if (detected.cli === 'installed' && workspaceRoot) {
      index = await readZvecIndexState(runCommandAt, executable, workspaceRoot).catch(
        () => 'unknown' as const
      );
    }
    return {
      enabled: this.zvecEnabled(config),
      cliSource,
      path: active.path,
      status: active.status,
      ...(active.version ? { version: active.version } : {}),
      local,
      bundled,
      connected: detected.enabled,
      cli: detected.cli,
      ...(index ? { index } : {}),
      ...(detected.message ? { detail: detected.message } : {})
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
      enabled: trustedBoolean(config.inspect<boolean>(`${SKILLS_SECTION}.astGrep`), false),
      cliSource,
      path: active.path,
      status: active.status,
      ...(active.version ? { version: active.version } : {}),
      local,
      bundled,
      connected: detected.enabled,
      cli: detected.cli,
      ...(detected.message ? { detail: detected.message } : {})
    };
  }

  /** The first workspace folder, used as the zvec index root. */
  private skillWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
    const result = await probeExecutableVersion(command);
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
   * Turn zvec-grep's OpenCode integration on or off.
   *
   * Nothing is persisted until the apply succeeded. The enabled boolean is
   * application-scoped (see package.json), so a stale workspace value cannot
   * flip the checkbox back on the next reload. A refused draft path is
   * surfaced on the path field and no source/path/enabled write happens.
   */
  async setZvecGrep(
    enabled: boolean,
    draft?: { cliSource?: ZvecGrepCliSource; path?: string }
  ): Promise<ZvecGrepApplyResult & { fieldError?: SkillFieldError }> {
    const config = vscode.workspace.getConfiguration();
    const source = draft?.cliSource ?? this.zvecCliSource();
    const path = draft?.path ?? this.zvecPathSetting();
    if (draft?.path !== undefined) {
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
    }
    const result = await applyZvecGrep(enabled, {
      source,
      path,
      roots: this.skillRoots()
    });
    await this.persistSkillToggle(config, {
      skill: 'zvecGrep',
      enabled,
      source,
      path,
      applied: result.ok
    });
    return result;
  }

  /** Turn ast-grep's OpenCode integration on or off; same write-after-apply rule. */
  async setAstGrep(
    enabled: boolean,
    draft?: { cliSource?: AstGrepCliSource; path?: string }
  ): Promise<AstGrepApplyResult & { fieldError?: SkillFieldError }> {
    const config = vscode.workspace.getConfiguration();
    const source = draft?.cliSource ?? this.astCliSource();
    const path = draft?.path ?? this.astPathSetting();
    if (draft?.path !== undefined) {
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
    }
    const result = await applyAstGrep({
      enabled,
      source,
      path,
      roots: this.skillRoots()
    });
    await this.persistSkillToggle(config, {
      skill: 'astGrep',
      enabled,
      source,
      path,
      applied: result.ok
    });
    return result;
  }

  /** Write one successful skill toggle's fields, in one place. */
  private async persistSkillToggle(
    config: vscode.WorkspaceConfiguration,
    input: {
      skill: 'zvecGrep' | 'astGrep';
      enabled: boolean;
      source: ZvecGrepCliSource | AstGrepCliSource;
      path: string;
      applied: boolean;
    }
  ): Promise<void> {
    for (const write of skillToggleWrites(input)) {
      await config.update(write.key, write.value, vscode.ConfigurationTarget.Global);
    }
  }

  /**
   * Probe the CLI and its MCP server for the draft (or saved) selection.
   * Read-only: it starts the local CLI/server, never writes config or files.
   */
  async testSkill(
    skill: 'zvecGrep' | 'astGrep',
    draft?: { cliSource?: ZvecGrepCliSource | AstGrepCliSource; path?: string }
  ): Promise<{ ok: boolean; message: string }> {
    const roots = this.skillRoots();
    const workspaceRoot = this.skillWorkspaceRoot() ?? process.cwd();
    if (draft?.path !== undefined) {
      const pathError = skillCliPathError(
        draft.path,
        skill === 'zvecGrep' ? 'zg' : 'ast-grep',
        skill === 'zvecGrep' ? 'zg CLI' : 'ast-grep CLI'
      );
      if (pathError) {
        return { ok: false, message: pathError };
      }
    }

    if (skill === 'zvecGrep') {
      const source = draft?.cliSource ?? this.zvecCliSource();
      const path = draft?.path ?? this.zvecPathSetting();
      const executable = resolveZvecGrepExecutable({ source, path, roots });
      const version = await probeExecutableVersion(executable);
      if (version.status !== 'detected') {
        return { ok: false, message: missingCliMessage(executable, 'zg') };
      }
      if (!zvecVersionSupported(version.version)) {
        return {
          ok: false,
          message: `zvec-grep ${version.version ?? ''} is too old for the \`server\` subcommand. Update it (\`npm install -g @zvec/zvec-grep\`) and press Test again.`
        };
      }
      const probe = await probeOpencodeServer(zvecGrepOpencodeServer(executable), {
        cwd: workspaceRoot,
        timeoutMs: 12_000
      });
      if (!probe.ok) {
        return {
          ok: false,
          message: `The zvec-grep MCP server did not answer: ${probe.message ?? 'unknown error'}. Check the CLI path and try again.`
        };
      }
      const index = await readZvecIndexState(runCommandAt, executable, workspaceRoot, {
        cache: false
      });
      return {
        ok: true,
        message: `zg${version.version ? ` ${version.version}` : ''} answered tools/list. ${zvecIndexGuidance(index)}`
      };
    }

    const source = draft?.cliSource ?? this.astCliSource();
    const path = draft?.path ?? this.astPathSetting();
    const executable = resolveAstGrepExecutable({ source, path, roots });
    const version = await probeExecutableVersion(executable);
    if (version.status !== 'detected') {
      return { ok: false, message: missingCliMessage(executable, 'ast-grep') };
    }
    const mcpScript = astGrepMcpScriptPath(this.context.extensionPath);
    if (!existsSync(mcpScript)) {
      return {
        ok: false,
        message:
          'The ast-grep MCP shim is missing from the extension build. Reinstall sideCode.'
      };
    }
    const probe = await probeOpencodeServer(
      astGrepOpencodeServer({
        mcpScriptPath: mcpScript,
        astGrepExecutable: executable,
        workspaceRoot
      }),
      { cwd: workspaceRoot, timeoutMs: 12_000 }
    );
    if (!probe.ok) {
      return {
        ok: false,
        message: `The ast-grep MCP shim did not answer: ${probe.message ?? 'unknown error'}. Check the CLI path and try again.`
      };
    }
    return {
      ok: true,
      message: `ast-grep${version.version ? ` ${version.version}` : ''} answered tools/list for search and replace.`
    };
  }

  /**
   * Build the zvec-grep workspace index for the draft (or saved) CLI.
   *
   * Explicit only: indexing reads the workspace and writes `.zvec-grep/`, so
   * no turn or settings save triggers it. A missing embedding model, a missing
   * binary and a timeout each return an actionable sentence.
   */
  async buildZvecIndex(
    draft?: { cliSource?: ZvecGrepCliSource; path?: string }
  ): Promise<ZvecIndexBuildResult> {
    const workspaceRoot = this.skillWorkspaceRoot();
    if (!workspaceRoot) {
      return {
        ok: false,
        state: 'unknown',
        message: 'Open a workspace folder before building the zvec-grep index.'
      };
    }
    if (draft?.path !== undefined) {
      const pathError = skillCliPathError(draft.path, 'zg', 'zg CLI');
      if (pathError) {
        return { ok: false, state: 'unknown', message: pathError };
      }
    }
    const source = draft?.cliSource ?? this.zvecCliSource();
    const path = draft?.path ?? this.zvecPathSetting();
    const executable = resolveZvecGrepExecutable({ source, path, roots: this.skillRoots() });
    const version = await probeExecutableVersion(executable);
    if (version.status !== 'detected') {
      return { ok: false, state: 'unknown', message: missingCliMessage(executable, 'zg') };
    }
    return runZvecIndexBuild({
      run: runCommandAt,
      command: executable,
      cwd: workspaceRoot
    });
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
    const probe = await probeExecutableVersion(executable);
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
    const probe = await probeExecutableVersion(executable);
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
      // Bundled stays in extension global storage; do not rewrite the user PATH.
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
    if (after.version !== installed.version) {
      return {
        ok: false,
        message: `Expected opencode ${installed.version}, but the installed executable reports ${after.version ?? 'an unknown version'}. Check the path, then try again.`
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
      executablePath: installed.executablePath,
      version: installed.version
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

/** One actionable sentence for a skill CLI that is missing or does not run. */
function missingCliMessage(executable: string, label: string): string {
  return `${label} was not found or did not run at ${executable}. Install it, or set an absolute path or command name under Settings > Skills, then press Test again.`;
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






