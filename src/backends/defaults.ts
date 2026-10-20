import * as vscode from 'vscode';
import { type DefaultMode, type PermissionLevel, type ThinkingLevel } from './types';
import { isDefaultMode } from './modes';
import { isThinkingLevel } from './capabilities';
import { resolveDefaultPermissionLevel } from '../config/permissionDefault.ts';

/**
 * The single reader for the app-level defaults the settings screen writes.
 *
 * `sidebarView` seeds a new conversation from these and `CodexBackend` falls
 * back to them when no explicit level is supplied, so a saved default is never
 * inert: it changes the next conversation's permission policy and mode.
 *
 * ## Trust boundary
 *
 * The permission level is read through `inspect()` and only the user's own
 * value (`globalValue`) or the contributed default is used. A workspace
 * `.vscode/settings.json` cannot raise the default to `unrestricted`: opening
 * a repository must not be enough to remove the sandbox and the prompts.
 * The explicit, labelled confirmation the UI requires before `unrestricted`
 * is applied is unchanged — this only decides where the *default* comes from.
 *
 * The mode and the thinking level are ordinary preferences and keep their
 * normal (workspace-overridable) behaviour.
 */

const DEFAULTS_SECTION = 'melink.defaults';

/** The stored default permission level, degraded to `default` when unreadable. */
export function readDefaultPermissionLevel(): PermissionLevel {
  return resolveDefaultPermissionLevel(
    vscode.workspace.getConfiguration().inspect<string>(`${DEFAULTS_SECTION}.permissionLevel`)
  );
}

/** The stored default mode, degraded to `agent` when unreadable. */
export function readDefaultMode(): DefaultMode {
  const value = vscode.workspace.getConfiguration(DEFAULTS_SECTION).get<unknown>('mode', 'agent');
  return isDefaultMode(value) ? value : 'agent';
}

/**
 * The stored app-level thinking default, or `undefined` when none is set.
 *
 * Unlike the permission level and mode, there is no safe universal fallback: a
 * model either reasons or it does not, so an absent app default leaves the
 * provider's own default in charge rather than inventing a level.
 */
export function readDefaultThinking(): ThinkingLevel | undefined {
  const value = vscode.workspace.getConfiguration(DEFAULTS_SECTION).get<unknown>('thinking', '');
  return isThinkingLevel(value) ? value : undefined;
}
