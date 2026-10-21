import { PERMISSION_LEVELS, type PermissionLevel } from '../backends/types.ts';
import { trustedSetting, type InspectedSetting } from './trust.ts';

/**
 * The effective permission default.
 *
 * A new conversation starts at this level, and the Codex adapter falls back to
 * it when no explicit level was supplied — so it decides whether a turn runs
 * with a sandbox and prompts, or without either.
 *
 * The value is read from the user's own setting (`globalValue`) or the
 * contributed default. A workspace `.vscode/settings.json` is never read, so
 * a repository cannot raise the default to `unrestricted`: opening a
 * repository must not be enough to remove the sandbox and the prompts.
 *
 * The explicit, labelled confirmation the UI requires before `unrestricted`
 * is applied is a separate gate and is unchanged by this rule — this only
 * decides where the *default* comes from.
 */

/** The contributed default level. */
export const DEFAULT_PERMISSION_LEVEL_VALUE: PermissionLevel = 'default';

/**
 * The stored default permission level, degraded to `default` when unreadable
 * or when it names a level the extension does not know.
 */
export function resolveDefaultPermissionLevel(
  inspected: InspectedSetting<string> | undefined
): PermissionLevel {
  const value = trustedSetting(inspected, DEFAULT_PERMISSION_LEVEL_VALUE);
  return (PERMISSION_LEVELS as readonly string[]).includes(value)
    ? (value as PermissionLevel)
    : DEFAULT_PERMISSION_LEVEL_VALUE;
}
