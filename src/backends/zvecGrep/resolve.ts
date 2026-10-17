import { existsSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import {
  looksLikeAbsoluteExecutable,
  readSkillCliSource,
  type SkillCliSource,
  type SkillResolveRoots
} from '../skillCli.ts';

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

export function resolveZvecGrepExecutable(options: {
  source: ZvecGrepCliSource;
  path: string;
  roots: SkillResolveRoots;
  platform?: NodeJS.Platform;
}): string {
  if (options.source === 'bundled') {
    return bundledZvecGrepExecutable(options.roots, options.platform);
  }
  const trimmed = options.path.trim();
  return trimmed.length > 0 ? trimmed : options.platform === 'win32' ? 'zg.cmd' : 'zg';
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
