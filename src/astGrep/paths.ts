import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Workspace confinement for the ast-grep MCP shim.
 *
 * A tool call may name files or directories. Those values reach a child
 * process, so they are resolved against the workspace root and refused when
 * they escape it: an absolute path elsewhere, `..`, or the Windows
 * drive-relative form (`C:secret`) would let a turn read or rewrite files the
 * user never opened.
 */

export interface PathCheck {
  ok: boolean;
  paths: string[];
  error?: string;
}

/** The workspace root the shim should confine calls to. */
export function astGrepWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AST_GREP_WORKSPACE?.trim();
  return configured && configured.length > 0 ? configured : process.cwd();
}

/** Whether the value is a Windows drive-relative path (`C:file`). */
export function isDriveRelative(value: string): boolean {
  return /^[A-Za-z]:(?![\\/])/.test(value);
}

/**
 * Resolve one list of `paths` into workspace-relative values.
 *
 * The empty list is left to the caller: search defaults to the workspace,
 * writes require an explicit list. Every returned value is safe to pass to
 * ast-grep running with the workspace as its working directory.
 */
export function resolveWorkspacePaths(paths: readonly string[], root: string): PathCheck {
  const workspace = resolve(root);
  const resolved: string[] = [];
  for (const raw of paths) {
    const value = raw.trim();
    if (value.length === 0) {
      return { ok: false, paths: [], error: 'Paths must not be empty.' };
    }
    if (isDriveRelative(value)) {
      return {
        ok: false,
        paths: [],
        error: `${value} is drive-relative and would resolve outside the workspace.`
      };
    }
    const absolute = isAbsolute(value) ? resolve(value) : resolve(workspace, value);
    const inside = relative(workspace, absolute);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      return {
        ok: false,
        paths: [],
        error: `${value} is outside the workspace. Only the workspace can be searched or rewritten.`
      };
    }
    resolved.push(inside.length === 0 ? '.' : inside);
  }
  return { ok: true, paths: resolved };
}

/** Reject globs that could walk out of the workspace. */
export function validateWorkspaceGlobs(globs: readonly string[]): { ok: boolean; error?: string } {
  for (const raw of globs) {
    const value = raw.trim();
    if (value.length === 0) {
      return { ok: false, error: 'Globs must not be empty.' };
    }
    const target = value.startsWith('!') ? value.slice(1) : value;
    if (
      target.startsWith('/') ||
      target.startsWith('\\\\') ||
      isDriveRelative(target) ||
      /^[A-Za-z]:[\\/]/.test(target)
    ) {
      return { ok: false, error: `${value} must be a workspace-relative glob.` };
    }
    if (target.split(/[\\/]+/).some((segment) => segment === '..')) {
      return { ok: false, error: `${value} must not walk outside the workspace.` };
    }
  }
  return { ok: true };
}
