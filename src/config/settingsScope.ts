import {
  WORKSPACE_SAVE_REFUSED_MESSAGE,
  controllingScope,
  keyAllowsWorkspaceScope,
  saveScopeForKey,
  type InspectedSetting,
  type SettingsWriteScope
} from './trust.ts';

/**
 * What the settings screen tells the user about a field it saved.
 *
 * A trust-sensitive field cannot live in workspace settings, so a
 * "Save to workspace" action writes it to the user's own settings instead.
 * The value *is* persisted, so this is a notice rather than an error — but
 * the user is told where it went, because a save that lands somewhere else
 * than the button suggests is a lie if it is silent.
 *
 * This module is host-free so the rule is unit-testable without the webview.
 */

/** The outcome of saving one field at a requested scope. */
export interface FieldSaveOutcome {
  /** The scope the value was actually written to. */
  scope: SettingsWriteScope;
  /** True when the requested scope was not the one used. */
  redirected: boolean;
  /** The message to show on the field, when the scope was redirected. */
  notice?: string;
}

/**
 * Where one field's value is written, and what the user is told about it.
 */
export function fieldSaveOutcome(
  key: string,
  requested: SettingsWriteScope
): FieldSaveOutcome {
  if (keyAllowsWorkspaceScope(key)) {
    return { scope: requested, redirected: false };
  }
  const redirected = requested !== 'global';
  return {
    scope: saveScopeForKey(key, requested),
    redirected,
    ...(redirected ? { notice: WORKSPACE_SAVE_REFUSED_MESSAGE } : {})
  };
}

/**
 * The effective scope for the primary save, across the managed keys.
 *
 * Priority follows VS Code's own merge: a folder override anywhere makes the
 * screen a "folder" save, otherwise a workspace override makes it a
 * "workspace" save, otherwise the user settings are in charge. Trust-sensitive
 * keys are skipped because their workspace/folder values are never read.
 */
export function effectiveSettingsTarget(
  entries: Iterable<{ key: string; inspected?: InspectedSetting<unknown> }>
): SettingsWriteScope {
  let workspace = false;
  for (const { key, inspected } of entries) {
    if (!keyAllowsWorkspaceScope(key)) {
      continue;
    }
    const scope = controllingScope(inspected);
    if (scope === 'folder') {
      return 'folder';
    }
    if (scope === 'workspace') {
      workspace = true;
    }
  }
  return workspace ? 'workspace' : 'global';
}
