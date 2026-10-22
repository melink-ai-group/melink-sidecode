import * as vscode from 'vscode';
import {
  trustedBoolean,
  trustedOptionalSetting,
  trustedSetting,
  trustedString,
  type InspectedSetting
} from '../config/trust.ts';
import { readOpencodeCliSource } from '../backends/opencode/resolve.ts';
import { readSkillCliSource } from '../backends/skillCli.ts';
import { resolveTrustedExecutable } from '../backends/executables.ts';

/**
 * The single reader for the settings that decide where a credential goes,
 * which binary is spawned, and how much permission a turn runs with.
 *
 * Every read goes through `inspect()` and keeps only `globalValue` (the
 * user's own setting) or `defaultValue` (the contributed default). A workspace
 * or workspace-folder override is never read, so opening a repository cannot
 * redirect the Ollama bearer token, swap the spawned executable, or raise the
 * permission default.
 *
 * The rules themselves live in `src/config/trust.ts`, which is host-free and
 * unit-tested; this module is only the thin VS Code binding.
 */

/** The setting keys this module owns, named once so no call site can drift. */
export const TRUSTED_KEYS = {
  ollamaBaseUrl: 'melink.ollama.baseUrl',
  ollamaLocalBaseUrl: 'melink.ollamaLocal.baseUrl',
  opencodePath: 'melink.ollama.opencode.path',
  opencodeCliSource: 'melink.ollama.opencode.cliSource',
  codexPath: 'melink.codex.path',
  zvecGrepPath: 'melink.skills.zvecGrep.path',
  zvecGrepCliSource: 'melink.skills.zvecGrep.cliSource',
  astGrepPath: 'melink.skills.astGrep.path',
  astGrepCliSource: 'melink.skills.astGrep.cliSource',
  permissionLevel: 'melink.defaults.permissionLevel'
} as const;

/** The inspected shape of one setting, as VS Code reports it. */
function inspect<T>(key: string): InspectedSetting<T> | undefined {
  return vscode.workspace.getConfiguration().inspect<T>(key);
}

/**
 * The trusted value of a setting, given the inspected shape.
 *
 * Exported so the read sites and the tests use exactly one rule.
 */
export function readTrusted<T>(key: string, fallback: T): T {
  return trustedSetting(inspect<T>(key), fallback);
}

/** The trusted string value, trimmed, with the fallback for an empty value. */
export function readTrustedString(key: string, fallback: string): string {
  return trustedString(inspect<string>(key), fallback);
}

/** The trusted boolean value. */
export function readTrustedBoolean(key: string, fallback: boolean): boolean {
  return trustedBoolean(inspect<boolean>(key), fallback);
}

/** The trusted value, or `undefined` when neither the user nor the default set it. */
export function readTrustedOptional<T>(key: string): T | undefined {
  return trustedOptionalSetting(inspect<T>(key));
}

/**
 * The Ollama Cloud base URL — the host the bearer token is sent to.
 *
 * Read from the user's own settings only.
 */
export function readTrustedBaseUrl(fallback = 'https://ollama.com'): string {
  return readTrustedString(TRUSTED_KEYS.ollamaBaseUrl, fallback);
}

/**
 * The local Ollama server address. Read from the user's own settings only, so
 * a workspace cannot redirect local prompts to another host.
 */
export function readTrustedOllamaLocalBaseUrl(fallback = 'http://localhost:11434'): string {
  return readTrustedString(TRUSTED_KEYS.ollamaLocalBaseUrl, fallback);
}

/** The Codex CLI executable the app-server is spawned from. */
export function readTrustedCodexPath(fallback = 'codex'): string {
  return readTrustedString(TRUSTED_KEYS.codexPath, fallback);
}

/**
 * The Codex CLI executable the app-server is spawned from, with the
 * executable rules applied.
 *
 * A workspace override is ignored (the value comes from the user's own
 * setting), and a relative path is refused, because the child runs with the
 * workspace as its working directory. That covers a relative path with a
 * separator and the Windows drive-relative form (`C:evil.exe`).
 */
export function readTrustedCodexExecutable(fallback = 'codex'): string {
  return resolveTrustedExecutable(inspect<string>(TRUSTED_KEYS.codexPath), fallback);
}

/** The opencode CLI executable every opencode spawn uses. */
export function readTrustedOpencodePath(fallback = 'opencode'): string {
  return readTrustedString(TRUSTED_KEYS.opencodePath, fallback);
}

/**
 * The opencode CLI executable every opencode spawn uses, with the executable
 * rules applied.
 *
 * A workspace override is ignored (the value comes from the user's own
 * setting), and a relative path with a separator — or a Windows drive-relative
 * path — is refused, because the child runs with the workspace as its working
 * directory.
 */
export function readTrustedOpencodeExecutable(fallback = 'opencode'): string {
  return resolveTrustedExecutable(inspect<string>(TRUSTED_KEYS.opencodePath), fallback);
}

/** The `zg` executable the zvec-grep skill uses. */
export function readTrustedZvecGrepPath(fallback = 'zg'): string {
  return readTrustedString(TRUSTED_KEYS.zvecGrepPath, fallback);
}

/**
 * The `zg` executable the zvec-grep skill uses, with the executable rules
 * applied: a relative path with a separator, or a Windows drive-relative
 * path, is refused.
 */
export function readTrustedZvecGrepExecutable(fallback = 'zg'): string {
  return resolveTrustedExecutable(inspect<string>(TRUSTED_KEYS.zvecGrepPath), fallback);
}

/** The `ast-grep` executable the ast-grep skill uses. */
export function readTrustedAstGrepPath(fallback = 'ast-grep'): string {
  return readTrustedString(TRUSTED_KEYS.astGrepPath, fallback);
}

/**
 * The `ast-grep` executable the ast-grep skill uses, with the executable
 * rules applied: a relative path with a separator, or a Windows drive-relative
 * path, is refused.
 */
export function readTrustedAstGrepExecutable(fallback = 'ast-grep'): string {
  return resolveTrustedExecutable(inspect<string>(TRUSTED_KEYS.astGrepPath), fallback);
}

/**
 * Where the opencode CLI comes from: `local` (the user's own path or PATH) or
 * `bundled` (the sideCode-managed download).
 *
 * Read from the user's own settings only, so a workspace cannot push the
 * runtime back onto a machine-local binary.
 */
export function readTrustedOpencodeCliSource(): 'local' | 'bundled' {
  return readOpencodeCliSource(readTrustedOptional<string>(TRUSTED_KEYS.opencodeCliSource));
}

/** Where the `zg` CLI comes from: `local` or `bundled`. */
export function readTrustedZvecGrepCliSource(): 'local' | 'bundled' {
  return readSkillCliSource(readTrustedOptional<string>(TRUSTED_KEYS.zvecGrepCliSource));
}

/** Where the `ast-grep` CLI comes from: `local` or `bundled`. */
export function readTrustedAstGrepCliSource(): 'local' | 'bundled' {
  return readSkillCliSource(readTrustedOptional<string>(TRUSTED_KEYS.astGrepCliSource));
}
