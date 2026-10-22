/**
 * Shared local/bundled CLI source for sideCode-managed skill binaries.
 * Same vocabulary as the opencode CLI source setting.
 */

import { executablePathError, isAbsoluteExecutable, resolveExecutableCommand } from './executables.ts';

export type SkillCliSource = 'local' | 'bundled';

export const SKILL_CLI_SOURCES: readonly SkillCliSource[] = ['local', 'bundled'];

/** Coerce a stored setting; unknown values become `local`. */
export function readSkillCliSource(value: unknown): SkillCliSource {
  return value === 'bundled' ? 'bundled' : 'local';
}

export interface SkillResolveRoots {
  extensionPath: string;
  globalStoragePath?: string;
}

/**
 * Whether the value names an absolute location on disk.
 *
 * The rule lives in `executables.ts`, so a Windows drive-relative value
 * (`C:evil.exe`) is never mistaken for an absolute path.
 */
export function looksLikeAbsoluteExecutable(value: string): boolean {
  return isAbsoluteExecutable(value.trim());
}

/**
 * The inline message for a refused skill CLI path (the `zg` and `ast-grep`
 * binaries), or `undefined` when the value may be stored.
 *
 * The same rule the codex and opencode paths use: a relative path with a
 * separator, or a Windows drive-relative path, would name a file inside the
 * repository, because the child runs with the workspace as its working
 * directory.
 *
 * Host-free, so the rule is unit-testable without an extension host, and
 * every write of a skill path — the settings save and the skill toggle —
 * can use the one rule.
 */
export function skillCliPathError(value: string, fallback: string, label: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return `Enter the ${label} path or name. This value was not saved.`;
  }
  const resolved = resolveExecutableCommand(trimmed, fallback);
  return resolved.ok ? undefined : executablePathError(resolved.reason, label);
}
