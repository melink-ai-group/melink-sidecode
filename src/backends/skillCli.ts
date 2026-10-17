/**
 * Shared local/bundled CLI source for SideCode-managed skill binaries.
 * Same vocabulary as the opencode CLI source setting.
 */

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

export function looksLikeAbsoluteExecutable(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\');
}
