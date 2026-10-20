/**
 * The one rule for "which binary does this turn run".
 *
 * A spawned executable is the sharpest edge in the extension: the child runs
 * with the workspace as its working directory, so a value that can be chosen
 * by the repository could run a program the repository ships. Two rules keep
 * that from happening:
 *
 * 1. The value is read from the user's own settings only (see
 *    `src/config/trust.ts`), never from workspace or workspace-folder scope.
 * 2. Even a trusted value may not be a *relative* path. `./evil` and `..\evil`
 *    would resolve against the workspace working directory, which is exactly
 *    the case rule 1 cannot cover (the user themselves configured it, but a
 *    repository-provided relative path is still the wrong thing to run). The
 *    Windows drive-relative form (`C:evil.exe`) is refused for the same
 *    reason — see the section below.
 *
 * Accepted forms:
 *
 * - a bare command name (`codex`, `opencode`, `zg`) — resolved from PATH;
 * - an absolute path (`/usr/local/bin/codex`, `C:\Tools\codex.exe`) — used
 *   as-is.
 *
 * Everything else is refused with a plain-language message the settings
 * screen can show.
 *
 * ## The Windows drive-relative form
 *
 * `C:evil.exe` looks like a path but is *drive-relative*: Windows resolves it
 * against the current directory **of that drive**, so a child spawned with the
 * workspace as its working directory runs `workspace\evil.exe`. It carries no
 * separator, so a "relative path with a separator" rule alone does not catch
 * it. Every drive-relative form is therefore refused: `C:evil.exe`, `C:` and
 * `C:..\evil` are all rejected, while true absolutes (`C:\evil.exe`,
 * `C:/evil.exe`, UNC `\\server\share\evil.exe`) stay allowed.
 */

import { trustedSetting } from '../config/trust.ts';

/**
 * Whether the value is a Windows drive-relative path.
 *
 * `C:evil.exe`, `C:` and `C:..\evil` all qualify: the drive letter is there
 * but no separator follows, so the value is resolved against the current
 * directory of that drive rather than the drive's root.
 */
export function isDriveRelativeExecutable(value: string): boolean {
  return /^[A-Za-z]:(?![\\/])/.test(value);
}

/** Whether the value names an absolute location rather than a PATH command. */
export function isAbsoluteExecutable(value: string): boolean {
  if (isDriveRelativeExecutable(value)) {
    return false;
  }
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\');
}

/**
 * Whether the value carries a path separator, so it names a *file* rather
 * than a bare command. `./evil`, `..\evil`, `bin/codex` and `sub\codex.exe`
 * all qualify.
 */
export function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

/** The outcome of resolving one executable setting. */
export type ExecutableResolution =
  | { ok: true; command: string }
  | { ok: false; reason: 'empty' | 'relative-with-separator' | 'drive-relative' };

/**
 * Resolve one executable setting into the command a child process should run.
 *
 * A relative path with a separator is refused: it would resolve against the
 * workspace working directory. A Windows drive-relative value (`C:evil.exe`)
 * is refused for the same reason: Windows resolves it against the current
 * directory of that drive, which is the workspace for a spawned child.
 */
export function resolveExecutableCommand(
  value: string,
  fallback: string
): ExecutableResolution {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: true, command: fallback };
  }
  if (isDriveRelativeExecutable(trimmed)) {
    return { ok: false, reason: 'drive-relative' };
  }
  if (isAbsoluteExecutable(trimmed)) {
    return { ok: true, command: trimmed };
  }
  if (hasPathSeparator(trimmed)) {
    return { ok: false, reason: 'relative-with-separator' };
  }
  return { ok: true, command: trimmed };
}

/**
 * The plain-language message for a refused executable value.
 *
 * One sentence, no path echo of the offending value beyond what the user
 * typed, so the screen can mark the field "not saved".
 */
export function executablePathError(
  reason: 'empty' | 'relative-with-separator' | 'drive-relative',
  label: string
): string {
  if (reason === 'empty') {
    return `Enter the ${label} path or name. This value was not saved.`;
  }
  if (reason === 'drive-relative') {
    return `Enter an absolute path or a command name for the ${label}. A drive-relative path would run a file from the workspace, so this value was not saved.`;
  }
  return `Enter an absolute path or a command name for the ${label}. A relative path would run a file from the workspace, so this value was not saved.`;
}

/**
 * The command a child process should run, from one setting.
 *
 * The value is read from the user's own setting only (the inspected shape is
 * the input, and its workspace fields are ignored), and a relative path with a
 * separator — or a Windows drive-relative path — is refused. A refused value
 * falls back to the bare command name, so a turn still starts — with the
 * binary the user trusts — instead of failing on a path that would have run a
 * file from the repository.
 */
export function resolveTrustedExecutable(
  inspected: { defaultValue?: string; globalValue?: string; workspaceValue?: string; workspaceFolderValue?: string } | undefined,
  fallback: string
): string {
  const value = trustedSetting(inspected, fallback);
  const resolved = resolveExecutableCommand(typeof value === 'string' ? value : fallback, fallback);
  return resolved.ok ? resolved.command : fallback;
}

/**
 * The command a *probe* should run for a configured path.
 *
 * The same rules as `resolveExecutableCommand`, with one difference: the
 * fallback is the bare command name the CLI is known by, so a refused value
 * still yields a runnable (if absent) command rather than an empty string.
 *
 * The settings screen probes the configured path to show a status line. The
 * probe runs with the extension's working directory, so it must never run a
 * value the turn itself would refuse.
 */
export function resolveProbedExecutable(value: string, fallback: string): string {
  const resolved = resolveExecutableCommand(value, fallback);
  return resolved.ok ? resolved.command : fallback;
}
