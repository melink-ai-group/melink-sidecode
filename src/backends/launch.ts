/**
 * How a child process is started, shared by the extension host probes and the
 * stdio MCP shims.
 *
 * The two must agree: a probe that reports "Detected" for a Windows `.cmd`
 * shim, and a shim that then spawns the same name with `shell: false`, is the
 * "Detected, then not found" mismatch this module exists to prevent.
 *
 * Node on Windows rejects a direct spawn of `.cmd` / `.bat` (`EINVAL`, no
 * output). Those files are started through `cmd.exe /d /s /c` with a quoted
 * command built only from our own arguments. Nothing typed by a user is ever
 * passed to a shell as a raw string.
 */

export function commandLaunch(
  platform: string,
  command: string,
  args: readonly string[],
  comSpec = 'cmd.exe'
): { command: string; args: string[]; verbatim: boolean } {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return {
      command: comSpec,
      args: ['/d', '/s', '/c', `"${windowsCommandLine(command, args)}"`],
      verbatim: true
    };
  }
  return { command, args: [...args], verbatim: false };
}

/** One Windows command line. Arguments that need quoting are quoted. */
export function windowsCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteCmdArg).join(' ');
}

function quoteCmdArg(arg: string): string {
  if (arg.length === 0) {
    return '""';
  }
  if (/[\s"&|<>^]/.test(arg)) {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return arg;
}

/** True when the command is absent, including cmd.exe's "not recognized" text. */
export function commandNotFound(result: {
  code?: number | null;
  error?: 'missing' | 'failed' | 'timeout';
  stdout: string;
  stderr: string;
}): boolean {
  if (result.error === 'missing') {
    return true;
  }
  const text = `${result.stdout}\n${result.stderr}`;
  return /not recognized as an internal or external command/i.test(text) || /\bcommand not found\b/i.test(text);
}

/**
 * The file names a bare command may have on Windows.
 *
 * Node's `spawn` with `shell: false` does not apply `PATHEXT`, so a bare
 * `ast-grep` never finds the npm `ast-grep.cmd` shim. Probes and the ast-grep
 * shim try these in order; an explicit path or a name with an extension is
 * used as-is.
 */
export function windowsCommandCandidates(command: string, platform: string): string[] {
  if (platform !== 'win32') {
    return [command];
  }
  if (/\.(exe|cmd|bat|ps1)$/i.test(command) || /[\\/]/.test(command)) {
    return [command];
  }
  return [`${command}.exe`, `${command}.cmd`, command];
}
