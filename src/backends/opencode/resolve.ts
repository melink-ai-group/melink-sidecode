import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Where the opencode CLI comes from for SideCode turns.
 *
 * `local` uses the configured path (or PATH). `bundled` uses the SideCode-
 * managed download under `vendor/opencode/bin` (gitignored), never the
 * machine's PATH entry.
 */

export type OpencodeCliSource = 'local' | 'bundled';

export const OPENCODE_CLI_SOURCES: readonly OpencodeCliSource[] = ['local', 'bundled'];

export interface OpencodeResolveRoots {
  /** Extension install directory; `vendor/opencode` lives under this. */
  extensionPath: string;
}

/** Platform binary name for the release archive. */
export function opencodeExecutableName(): string {
  return process.platform === 'win32' ? 'opencode.exe' : 'opencode';
}

/**
 * Directory that holds the SideCode-bundled CLI.
 *
 * Kept under the extension tree as `vendor/opencode/bin` so the download is
 * gitignored in the repo and every spawn can point at one absolute path.
 */
export function bundledOpencodeInstallDir(roots: OpencodeResolveRoots): string {
  return join(roots.extensionPath, 'vendor', 'opencode', 'bin');
}

/** Absolute path of the bundled CLI binary (may not exist yet). */
export function bundledOpencodeExecutable(roots: OpencodeResolveRoots): string {
  return join(bundledOpencodeInstallDir(roots), opencodeExecutableName());
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
  return value === 'bundled' ? 'bundled' : 'local';
}

/**
 * The executable every opencode spawn must use.
 *
 * When `bundled`, the path setting is ignored so a machine PATH entry cannot
 * leak into turns. When `local`, a bare name is left for PATH resolution.
 */
export function resolveOpencodeExecutable(options: {
  source: OpencodeCliSource;
  path: string;
  roots: OpencodeResolveRoots;
}): string {
  if (options.source === 'bundled') {
    return bundledOpencodeExecutable(options.roots);
  }
  const trimmed = options.path.trim();
  return trimmed.length > 0 ? trimmed : 'opencode';
}

/**
 * Directory to write into on install/upgrade for the active source.
 *
 * Bundled always targets `vendor/opencode/bin`. Local prefers the directory of
 * an absolute configured path so Update replaces that binary; otherwise the
 * managed `~/.opencode/bin` install.
 */
export function opencodeInstallDirFor(options: {
  source: OpencodeCliSource;
  path: string;
  roots: OpencodeResolveRoots;
}): string {
  if (options.source === 'bundled') {
    return bundledOpencodeInstallDir(options.roots);
  }
  const trimmed = options.path.trim();
  if (trimmed.length > 0 && looksLikeAbsoluteExecutable(trimmed)) {
    return dirname(trimmed);
  }
  return managedOpencodeInstallDir();
}

function looksLikeAbsoluteExecutable(value: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')) {
    return true;
  }
  return false;
}

/** Whether the bundled binary is present on disk. */
export function bundledOpencodePresent(roots: OpencodeResolveRoots): boolean {
  return existsSync(bundledOpencodeExecutable(roots));
}
