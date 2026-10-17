import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  looksLikeAbsoluteExecutable,
  readSkillCliSource,
  type SkillCliSource,
  type SkillResolveRoots
} from '../skillCli.ts';

/**
 * Where the ast-grep CLI comes from for SideCode skills.
 *
 * `local` uses the configured path (or PATH). `bundled` uses the SideCode-
 * managed download under extension global storage.
 */

export type AstGrepCliSource = SkillCliSource;

export { readSkillCliSource as readAstGrepCliSource };

export function astGrepExecutableName(): string {
  return process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep';
}

export function bundledAstGrepInstallDir(roots: SkillResolveRoots): string {
  const storage = roots.globalStoragePath?.trim();
  if (storage) {
    return join(storage, 'ast-grep', 'bin');
  }
  return join(roots.extensionPath, 'vendor', 'ast-grep', 'bin');
}

export function bundledAstGrepPreferredExecutable(roots: SkillResolveRoots): string {
  return join(bundledAstGrepInstallDir(roots), astGrepExecutableName());
}

export function bundledAstGrepExecutable(roots: SkillResolveRoots): string {
  const preferred = bundledAstGrepPreferredExecutable(roots);
  if (existsSync(preferred)) {
    return preferred;
  }
  const legacy = join(roots.extensionPath, 'vendor', 'ast-grep', 'bin', astGrepExecutableName());
  if (existsSync(legacy)) {
    return legacy;
  }
  return preferred;
}

export function managedAstGrepInstallDir(): string {
  return join(homedir(), '.ast-grep', 'bin');
}

export function resolveAstGrepExecutable(options: {
  source: AstGrepCliSource;
  path: string;
  roots: SkillResolveRoots;
}): string {
  if (options.source === 'bundled') {
    return bundledAstGrepExecutable(options.roots);
  }
  const trimmed = options.path.trim();
  return trimmed.length > 0 ? trimmed : 'ast-grep';
}

export function astGrepInstallDirFor(options: {
  source: AstGrepCliSource;
  path: string;
  roots: SkillResolveRoots;
}): string {
  if (options.source === 'bundled') {
    return bundledAstGrepInstallDir(options.roots);
  }
  const trimmed = options.path.trim();
  if (trimmed.length > 0 && looksLikeAbsoluteExecutable(trimmed)) {
    return dirname(trimmed);
  }
  return managedAstGrepInstallDir();
}

export function bundledAstGrepPresent(roots: SkillResolveRoots): boolean {
  return existsSync(bundledAstGrepExecutable(roots));
}
