import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { isAbsoluteExecutable, resolveExecutableCommand } from '../executables.ts';

/**
 * Where the opencode CLI comes from for sideCode turns.
 *
 * `local` uses the configured path (or PATH). `bundled` uses the sideCode-
 * managed download under the extension global storage (survives VS Code
 * restarts and extension updates), never the machine's PATH entry.
 */

export type OpencodeCliSource = 'local' | 'bundled' | 'bundled-v2';

export const OPENCODE_CLI_SOURCES: readonly OpencodeCliSource[] = ['local', 'bundled', 'bundled-v2'];

export interface OpencodeResolveRoots {
  /** Extension install directory; used only as a legacy fallback path. */
  extensionPath: string;
  /**
   * Persistent storage that survives VS Code restarts and extension updates.
   * Preferred location for the sideCode-managed (bundled) CLI download.
   */
  globalStoragePath?: string;
}

/** Platform binary name for the release archive. */
export function opencodeExecutableName(): string {
  return process.platform === 'win32' ? 'opencode.exe' : 'opencode';
}

/**
 * Directory that holds the sideCode-bundled CLI.
 *
 * Prefer `globalStoragePath/opencode/bin` so the download survives closing
 * VS Code and extension updates. Fall back to the legacy
 * `extensionPath/vendor/opencode/bin` when global storage is not provided.
 */
export function bundledOpencodeInstallDir(roots: OpencodeResolveRoots, major: 1 | 2 = 1): string {
  const storage = roots.globalStoragePath?.trim();
  if (storage) {
    return join(storage, major === 2 ? 'opencode-v2' : 'opencode', 'bin');
  }
  return join(roots.extensionPath, 'vendor', major === 2 ? 'opencode-v2' : 'opencode', 'bin');
}

/** Absolute path of the preferred bundled CLI binary (may not exist yet). */
export function bundledOpencodePreferredExecutable(roots: OpencodeResolveRoots, major: 1 | 2 = 1): string {
  return join(bundledOpencodeInstallDir(roots, major), opencodeExecutableName());
}

/**
 * Absolute path of the bundled CLI binary.
 *
 * Prefers the global-storage install. If that file is missing, falls back to a
 * legacy binary under `extensionPath/vendor/opencode` so an earlier install is
 * still found until the user reinstalls into global storage.
 */
export function bundledOpencodeExecutable(roots: OpencodeResolveRoots, major: 1 | 2 = 1): string {
  const preferred = bundledOpencodePreferredExecutable(roots, major);
  if (major === 2) return preferred;
  if (existsSync(preferred)) {
    return preferred;
  }
  const legacy = join(roots.extensionPath, 'vendor', 'opencode', 'bin', opencodeExecutableName());
  if (existsSync(legacy)) {
    return legacy;
  }
  return preferred;
}

/** Default managed install for a local-machine install when PATH has no CLI. */
export function managedOpencodeInstallDir(): string {
  return join(homedir(), '.opencode', 'bin');
}

export function managedOpencodeExecutable(): string {
  return join(managedOpencodeInstallDir(), opencodeExecutableName());
}

/** Coerce a stored setting to a known source; unknown values become `local`. */
export function readOpencodeCliSource(value: unknown): OpencodeCliSource {
  return value === 'bundled-v2' ? 'bundled-v2' : value === 'bundled' ? 'bundled' : 'local';
}

/**
 * The executable every opencode spawn must use.
 *
 * When `bundled`, the path setting is ignored so a machine PATH entry cannot
 * leak into turns. When `local`, a bare name is left for PATH resolution and
 * an absolute path is used as-is.
 *
 * A relative path is refused: it would resolve against the workspace working
 * directory, so the bare default is used instead. That covers a relative
 * path with a separator (`./evil`, `..\evil`) and the Windows drive-relative
 * form (`C:evil.exe`), which carries no separator but resolves against the
 * current directory of that drive — the workspace for a spawned child.
 */
export function resolveOpencodeExecutable(options: {
  source: OpencodeCliSource;
  path: string;
  roots: OpencodeResolveRoots;
}): string {
  if (options.source !== 'local') {
    return bundledOpencodeExecutable(options.roots, options.source === 'bundled-v2' ? 2 : 1);
  }
  const resolved = resolveExecutableCommand(options.path, 'opencode');
  return resolved.ok ? resolved.command : 'opencode';
}

/**
 * Directory to write into on install/upgrade for the active source.
 *
 * Bundled always targets the persistent sideCode-managed folder. Local prefers
 * the directory of an absolute configured path so Update replaces that binary;
 * otherwise the managed `~/.opencode/bin` install.
 */
export function opencodeInstallDirFor(options: {
  source: OpencodeCliSource;
  path: string;
  roots: OpencodeResolveRoots;
}): string {
  if (options.source !== 'local') {
    return bundledOpencodeInstallDir(options.roots, options.source === 'bundled-v2' ? 2 : 1);
  }
  const trimmed = options.path.trim();
  if (trimmed.length > 0 && isAbsoluteExecutable(trimmed)) {
    return dirname(trimmed);
  }
  return managedOpencodeInstallDir();
}

/** Whether the bundled binary is present on disk. */
export function bundledOpencodePresent(roots: OpencodeResolveRoots): boolean {
  return existsSync(bundledOpencodeExecutable(roots));
}
