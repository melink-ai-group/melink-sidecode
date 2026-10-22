import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  looksLikeAbsoluteExecutable,
  readSkillCliSource,
  type SkillCliSource,
  type SkillResolveRoots
} from '../skillCli.ts';
import { resolveExecutableCommand } from '../executables.ts';

/**
 * Where the ast-grep CLI comes from for sideCode skills.
 *
 * `local` uses the configured path (or PATH). `bundled` uses the sideCode-
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

/**
 * The `ast-grep` executable the ast-grep skill uses.
 *
 * A relative path is refused: it would resolve against the workspace working
 * directory. That covers a relative path with a separator (`./evil`) and the
 * Windows drive-relative form (`C:evil.exe`).
 */
export function resolveAstGrepExecutable(options: {
  source: AstGrepCliSource;
  path: string;
  roots: SkillResolveRoots;
}): string {
  if (options.source === 'bundled') {
    return bundledAstGrepExecutable(options.roots);
  }
  const resolved = resolveExecutableCommand(options.path, 'ast-grep');
  return resolved.ok ? resolved.command : 'ast-grep';
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
