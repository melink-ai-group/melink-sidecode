import { resolveExecutableCommand } from '../backends/executables.ts';

/**
 * Which `ast-grep` binary the MCP shim runs.
 *
 * The shim is spawned with the workspace as its working directory, so a
 * configured value that names a *relative* file would run a file from the
 * repository. The same rule the extension applies to every other spawned CLI
 * applies here: a bare command name is left for PATH, an absolute path is
 * used as-is, and anything relative — with a separator or in the Windows
 * drive-relative form (`C:evil.exe`) — is refused.
 *
 * Host-free on purpose: the shim itself is a stdio process with import side
 * effects, so the rule lives here where it can be unit-tested.
 */

/**
 * Resolve a configured `ast-grep` value into a command to spawn.
 *
 * Returns `undefined` when the value may not be spawned (a relative path with
 * a separator, or a Windows drive-relative path), so the caller falls back to
 * a PATH lookup.
 */
export function resolveAstGrepBinValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) {
    return undefined;
  }
  const resolved = resolveExecutableCommand(trimmed, '');
  return resolved.ok && resolved.command.length > 0 ? resolved.command : undefined;
}
