/**
 * The post-turn check settings seam.
 *
 * This module is host-free: it names the setting keys, mirrors the package
 * defaults, and turns VS Code's `inspect()` scopes into the core `CheckSettings`
 * shape. The thin VS Code reader lives in `vscodeCheckSettings.ts`, so the
 * resolution rules are unit-testable without importing the host.
 *
 * `commands` is deliberately resolved through `inspect` rather than the merged
 * value: the package default is `[]`, and an absent user value must mean
 * "auto-detect". Only an explicitly stored array - including an explicit `[]` -
 * turns auto-detection off.
 */

import type { CheckSettings } from './checks.ts';

/** The configuration section the host reads. */
export const CHECK_SECTION = 'melink.review.checks';

/** Default per-check timeout, mirrored in `package.json`. */
export const DEFAULT_CHECK_TIMEOUT_SECONDS = 120;
/** The smallest timeout the host accepts, so a typo cannot kill a real check. */
export const MIN_CHECK_TIMEOUT_SECONDS = 5;
/** The largest timeout the host accepts, so a stuck check cannot run forever. */
export const MAX_CHECK_TIMEOUT_SECONDS = 600;

/** One `inspect()` scope, narrowed to the fields this module needs. */
export interface CheckSettingScope<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

/** The inspected values for the three keys, as returned by the host. */
export interface CheckSettingsInspect {
  enabled?: CheckSettingScope<unknown>;
  commands?: CheckSettingScope<unknown>;
  timeoutSeconds?: CheckSettingScope<unknown>;
}

/** The resolved settings plus the trust state the plan needs. */
export interface ResolvedCheckSettings extends CheckSettings {
  trusted: boolean;
}

/**
 * The raw values accepted by {@link resolveCheckSettingsInput}. `commandsDefault`
 * is the schema default; an empty schema default never means "run nothing".
 */
export interface CheckSettingsInput {
  enabled?: unknown;
  commandsGlobal?: unknown;
  commandsWorkspace?: unknown;
  commandsWorkspaceFolder?: unknown;
  commandsDefault?: unknown;
  timeoutSeconds?: unknown;
  trusted: boolean;
}

/** Clamp a configured timeout to the documented 5-600 second range. */
export function clampCheckTimeoutSeconds(value: unknown): number {
  const numeric =
    typeof value === 'number' && Number.isFinite(value)
      ? value
      : DEFAULT_CHECK_TIMEOUT_SECONDS;
  return Math.min(MAX_CHECK_TIMEOUT_SECONDS, Math.max(MIN_CHECK_TIMEOUT_SECONDS, numeric));
}

/** Resolve inspected or injected values into the core settings shape. */
export function resolveCheckSettingsInput(input: CheckSettingsInput): ResolvedCheckSettings {
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : true;
  const timeoutSeconds = clampCheckTimeoutSeconds(input.timeoutSeconds);

  const explicit = firstDefined(
    input.commandsWorkspaceFolder,
    input.commandsWorkspace,
    input.commandsGlobal
  );
  let commands: string[] | undefined;
  if (explicit !== undefined) {
    commands = commandList(explicit);
  } else {
    const fallback = commandList(input.commandsDefault);
    if (fallback !== undefined && fallback.length > 0) {
      commands = fallback;
    }
  }

  const settings: ResolvedCheckSettings = {
    enabled,
    timeoutMs: Math.round(timeoutSeconds * 1000),
    trusted: input.trusted
  };
  if (commands !== undefined) {
    settings.commands = commands;
  }
  return settings;
}

/** Resolve the three inspect results the VS Code binding returns. */
export function readCheckSettingsFrom(
  inspect: CheckSettingsInspect,
  trusted: boolean
): ResolvedCheckSettings {
  return resolveCheckSettingsInput({
    enabled: effective(inspect.enabled) ?? inspect.enabled?.defaultValue,
    commandsGlobal: inspect.commands?.globalValue,
    commandsWorkspace: inspect.commands?.workspaceValue,
    commandsWorkspaceFolder: inspect.commands?.workspaceFolderValue,
    commandsDefault: inspect.commands?.defaultValue,
    timeoutSeconds: effective(inspect.timeoutSeconds) ?? inspect.timeoutSeconds?.defaultValue,
    trusted
  });
}

function effective<T>(scope: CheckSettingScope<T> | undefined): T | undefined {
  if (!scope) {
    return undefined;
  }
  if (scope.workspaceFolderValue !== undefined) {
    return scope.workspaceFolderValue;
  }
  if (scope.workspaceValue !== undefined) {
    return scope.workspaceValue;
  }
  if (scope.globalValue !== undefined) {
    return scope.globalValue;
  }
  return undefined;
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function commandList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}
