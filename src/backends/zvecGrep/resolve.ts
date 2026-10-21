import { existsSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import {
  looksLikeAbsoluteExecutable,
  readSkillCliSource,
  type SkillCliSource,
  type SkillResolveRoots
} from '../skillCli.ts';
import { resolveExecutableCommand } from '../executables.ts';

/**
 * Where the zvec-grep (`zg`) CLI comes from.
 *
 * `local` uses the path setting / PATH / npm global. `bundled` uses an npm
 * prefix install under extension global storage.
 */

export type ZvecGrepCliSource = SkillCliSource;

export { readSkillCliSource as readZvecGrepCliSource };

/** npm `--prefix` root for the SideCode-bundled install. */
export function bundledZvecGrepPrefix(roots: SkillResolveRoots): string {
  const storage = roots.globalStoragePath?.trim();
  if (storage) {
    return join(storage, 'zvec-grep');
  }
  return join(roots.extensionPath, 'vendor', 'zvec-grep');
}

/**
 * The `zg` shim under an npm prefix (global-style layout).
 * Windows: `prefix/zg.cmd`. Elsewhere: `prefix/bin/zg`.
 */
export function zgPrefixBin(prefix: string, platform: string): string {
  const root = prefix.trim().replace(/[\\/]+$/, '');
  if (platform === 'win32') {
    return win32.join(root, 'zg.cmd');
  }
  return posix.join(root, 'bin', 'zg');
}

export function bundledZvecGrepExecutable(
  roots: SkillResolveRoots,
  platform: NodeJS.Platform = process.platform
): string {
  const preferred = zgPrefixBin(bundledZvecGrepPrefix(roots), platform);
  if (existsSync(preferred)) {
    return preferred;
  }
  const legacyPrefix = join(roots.extensionPath, 'vendor', 'zvec-grep');
  const legacy = zgPrefixBin(legacyPrefix, platform);
  if (existsSync(legacy)) {
    return legacy;
  }
  return preferred;
}

/**
 * The `zg` executable the zvec-grep skill uses.
 *
 * A relative path is refused: it would resolve against the workspace working
 * directory. That covers a relative path with a separator (`./evil`) and the
 * Windows drive-relative form (`C:evil.exe`).
 */
export function resolveZvecGrepExecutable(options: {
  source: ZvecGrepCliSource;
  path: string;
  roots: SkillResolveRoots;
  platform?: NodeJS.Platform;
}): string {
  const platform = options.platform ?? process.platform;
  if (options.source === 'bundled') {
    return bundledZvecGrepExecutable(options.roots, platform);
  }
  const fallback = platform === 'win32' ? 'zg.cmd' : 'zg';
  const resolved = resolveExecutableCommand(options.path, fallback);
  const command = resolved.ok ? resolved.command : fallback;
  // npm installs `zg` as a `.cmd` shim on Windows. Node's spawn does not apply
  // PATHEXT, and OpenCode spawns this exact argv, so a bare name must become
  // `zg.cmd` here rather than fail at tool time.
  return platform === 'win32' && command === 'zg' ? 'zg.cmd' : command;
}

export function bundledZvecGrepPresent(
  roots: SkillResolveRoots,
  platform: NodeJS.Platform = process.platform
): boolean {
  return existsSync(bundledZvecGrepExecutable(roots, platform));
}

export function isAbsoluteZvecPath(path: string): boolean {
  return looksLikeAbsoluteExecutable(path);
}
