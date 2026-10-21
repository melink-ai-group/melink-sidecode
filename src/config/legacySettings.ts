/**
 * One-time cleanup for settings that T106 removed.
 *
 * `melink.ollama.opencode.enabled` used to choose between the direct adapter and
 * the OpenCode runtime. Every Ollama turn now uses OpenCode, so the key is gone
 * from the manifest. VS Code leaves an old user value in `settings.json`;
 * activation removes that stale *global* value once.
 *
 * The rule is deliberately narrow: only a user (global) value is touched. A
 * workspace or folder value is never read into behaviour and never deleted —
 * those files belong to the repository, and deleting from them silently would be
 * a destructive edit the user did not ask for. The helper is pure so the rule is
 * testable without an extension host, and it is idempotent: once the global
 * value is gone it reports nothing to clean.
 */

export const LEGACY_OPENCODE_ENABLED_KEY = 'melink.ollama.opencode.enabled';

/** The subset of `ConfigurationInspect` this rule reads. */
export interface LegacyOpencodeEnabledInspect {
  globalValue?: boolean;
  workspaceValue?: boolean;
  workspaceFolderValue?: boolean;
}

/**
 * True only when the stale key has a user (global) value.
 *
 * `workspaceValue` / `workspaceFolderValue` are named so the shape is explicit,
 * but they can never make this return true.
 */
export function shouldCleanLegacyOpencodeEnabled(
  inspect: LegacyOpencodeEnabledInspect | undefined
): boolean {
  return inspect?.globalValue !== undefined;
}

/** The subset of `WorkspaceConfiguration` the cleanup calls. */
export interface LegacyCleanupConfiguration {
  inspect(section: string): LegacyOpencodeEnabledInspect | undefined;
  update(section: string, value: undefined, configurationTarget: unknown): PromiseLike<void>;
}

/**
 * The one-time host cleanup activation runs: inspect the unregistered key, and
 * only when a *global* value exists, remove it from the global target. Returns
 * whether an update was attempted, so a host test can prove the call shape and
 * that a second run is a no-op.
 */
export async function cleanLegacyOpencodeEnabled(
  configuration: LegacyCleanupConfiguration,
  configurationTarget: unknown
): Promise<boolean> {
  const inspected = configuration.inspect(LEGACY_OPENCODE_ENABLED_KEY);
  if (!shouldCleanLegacyOpencodeEnabled(inspected)) {
    return false;
  }
  await configuration.update(LEGACY_OPENCODE_ENABLED_KEY, undefined, configurationTarget);
  return true;
}
