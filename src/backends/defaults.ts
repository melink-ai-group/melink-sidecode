import * as vscode from 'vscode';
import { PERMISSION_LEVELS, type DefaultMode, type PermissionLevel, type ThinkingLevel } from './types';
import { isDefaultMode } from './modes';
import { isThinkingLevel } from './capabilities';

/**
 * The single reader for the app-level defaults the settings screen writes.
 *
 * `sidebarView` seeds a new conversation from these and `CodexBackend` falls
 * back to them when no explicit level is supplied, so a saved default is never
 * inert: it changes the next conversation's permission policy and mode.
 */

const DEFAULTS_SECTION = 'melink.defaults';

/** The stored default permission level, degraded to `default` when unreadable. */
export function readDefaultPermissionLevel(): PermissionLevel {
  const value = vscode.workspace.getConfiguration(DEFAULTS_SECTION).get<string>('permissionLevel', 'default');
  return (PERMISSION_LEVELS as readonly string[]).includes(value)
    ? (value as PermissionLevel)
    : 'default';
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
