/**
 * The trust boundary between a workspace and the extension's own settings.
 *
 * A repository can ship a `.vscode/settings.json`. When a value read from
 * there can decide **where a credential is sent**, **which binary is
 * spawned**, or **how much permission a turn runs with**, the workspace must
 * not be able to choose it: opening a repository would then be enough to
 * redirect a bearer token to a host the user never configured, to run a binary
 * from the repository, or to widen the permission default.
 *
 * Two independent layers enforce that:
 *
 * 1. `package.json` declares those keys `"scope": "application"`, so VS Code
 *    does not offer them in workspace settings at all.
 * 2. This module reads them through `inspect()` and keeps only
 *    `globalValue ?? defaultValue`. A workspace override is ignored even if it
 *    was written before the scope was tightened, or by a hand-edited
 *    `settings.json`.
 *
 * The module is host-free: it takes the inspected shape as data, so every rule
 * below is unit-testable without a VS Code extension host.
 */

/** The subset of `vscode.ConfigurationInspect` this module depends on. */
export interface InspectedSetting<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

/**
 * The trusted value of one setting: the user's own (global) value, else the
 * contributed default.
 *
 * `workspaceValue` and `workspaceFolderValue` are read but never used, and the
 * effective merged value (`get()`) is never consulted. A workspace that sets
 * the key cannot influence the result.
 */
export function trustedSetting<T>(
  inspected: InspectedSetting<T> | undefined,
  fallback: T
): T {
  if (!inspected) {
    return fallback;
  }
  if (inspected.globalValue !== undefined) {
    return inspected.globalValue;
  }
  if (inspected.defaultValue !== undefined) {
    return inspected.defaultValue;
  }
  return fallback;
}

/**
 * The trusted value of one setting, or `undefined` when neither the user nor
 * the contributed default set it.
 *
 * Used for settings whose default is "absent" (no app default thinking level,
 * no stored credential): the difference between "unset" and "set to the
 * default" matters there.
 */
export function trustedOptionalSetting<T>(
  inspected: InspectedSetting<T> | undefined
): T | undefined {
  if (!inspected) {
    return undefined;
  }
  if (inspected.globalValue !== undefined) {
    return inspected.globalValue;
  }
  return inspected.defaultValue;
}

/** The trusted string value, trimmed, with the fallback for an empty string. */
export function trustedString(
  inspected: InspectedSetting<string> | undefined,
  fallback: string
): string {
  const value = trustedSetting(inspected, fallback);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/** The trusted boolean value; only an explicit `true` enables a flag. */
export function trustedBoolean(
  inspected: InspectedSetting<boolean> | undefined,
  fallback: boolean
): boolean {
  const value = trustedSetting(inspected, fallback);
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * The keys whose workspace value must never take effect.
 *
 * The list is the contract between `package.json` (the `scope` declarations
 * and the `untrustedWorkspaces` description) and this module, and the package
 * contract test asserts the two agree.
 */
export const TRUST_SCOPED_KEYS: readonly string[] = [
  // Where the Ollama Cloud bearer token is sent.
  'melink.ollama.baseUrl',
  // Which binary is spawned for a turn.
  'melink.ollama.opencode.path',
  'melink.ollama.opencode.cliSource',
  'melink.codex.path',
  'melink.skills.zvecGrep.path',
  'melink.skills.zvecGrep.cliSource',
  'melink.skills.astGrep.path',
  'melink.skills.astGrep.cliSource',
  // The effective permission default.
  'melink.defaults.permissionLevel'
];

/**
 * The keys the settings screen may only ever write to the user's own
 * (global) settings.
 *
 * A workspace-save for one of these would look like it worked and be ignored
 * on the next read, so the screen refuses it with a per-key message instead of
 * silently dropping the write.
 */
export const GLOBAL_ONLY_KEYS: readonly string[] = [...TRUST_SCOPED_KEYS];

/**
 * The plain-language notice shown when a trust-sensitive key is saved to the
 * workspace. One sentence, no key list, no jargon.
 */
export const WORKSPACE_SAVE_REFUSED_MESSAGE =
  'This setting is only read from your user settings, so it was saved there instead of the workspace.';

/**
 * Whether a settings key may be written to workspace settings.
 *
 * Only the trust-sensitive keys are refused; every other SideCode setting
 * (model names, context toggles, skill flags) keeps its existing
 * workspace-scope behaviour.
 */
export function keyAllowsWorkspaceScope(key: string): boolean {
  return !GLOBAL_ONLY_KEYS.includes(key);
}

/** Where a settings key is written. */
export type SettingsWriteScope = 'global' | 'workspace';

/**
 * The scope one key is written to.
 *
 * A trust-sensitive key is always written to the user's own settings, even
 * when a workspace save was asked for: the value would be ignored on the next
 * read, so a workspace write would look like it worked and change nothing.
 */
export function saveScopeForKey(key: string, requested: SettingsWriteScope): SettingsWriteScope {
  return keyAllowsWorkspaceScope(key) ? requested : 'global';
}
