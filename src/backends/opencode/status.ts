import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Probe for the optional opencode CLI, backing the settings screen's status line.
 *
 * This module answers exactly one question: is the configured executable
 * resolvable, and what version does it report? It never runs a turn, never
 * writes a file, and never logs. The child is short-lived and killed at the
 * timeout. The caller passes the configured path in, so no configuration is read
 * here and the module stays host-light.
 */

export type OpencodeProbeStatus = 'detected' | 'missing' | 'not-runnable';

export interface OpencodeProbeResult {
  status: OpencodeProbeStatus;
  /** Version parsed from `--version`; present only when `status` is detected. */
  version?: string;
}

/**
 * Whether a value names a concrete filesystem location rather than a bare
 * command name. A bare name is resolved from PATH, so its absence is a status
 * ("missing"), never a refused value; a path that does not exist is a value the
 * screen marks not saved.
 */
export function looksLikePath(value: string): boolean {
  const trimmed = value.trim();
  return /[\/]/.test(trimmed) || /^[A-Za-z]:[^\/]/.test(trimmed);
}

/**
 * The inline message for a refused opencode CLI path, or `undefined` when the
 * value may be stored. `exists` is the caller's filesystem answer for a
 * path-shaped value, so this stays pure and testable.
 */
export function opencodePathError(value: string, exists: (path: string) => boolean): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Enter the opencode CLI path or name. This value was not saved.';
  }
  if (looksLikePath(trimmed) && !exists(trimmed)) {
    return 'No file found at this path, so this value was not saved and the previously stored path stays in use.';
  }
  return undefined;
}

/** The first semantic version token in a `--version` line, if any. */
export function parseOpencodeVersion(output: string): string | undefined {
  const match = output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : undefined;
}

export interface OpencodeProbeOptions {
  cwd?: string;
  /** Hard cap on the probe; a wedged CLI must never block the settings screen. */
  timeoutMs?: number;
}

export function probeOpencode(
  executable: string,
  options: OpencodeProbeOptions = {}
): Promise<OpencodeProbeResult> {
  const exe = executable.trim() || 'opencode';
  const timeoutMs = options.timeoutMs ?? 4_000;

  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let stdout = '';
    let stderr = '';
    let child: ChildProcess | undefined;

    const finish = (result: OpencodeProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      try {
        child?.kill();
      } catch {
        // The child already exited; there is nothing to kill.
      }
      resolve(result);
    };

    try {
      child = spawn(exe, ['--version'], {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Direct spawn, no shell: the value is a path or a bare name only.
        shell: false
      });
    } catch {
      resolve({ status: 'not-runnable' });
      return;
    }

    timer = setTimeout(() => finish({ status: 'not-runnable' }), timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ENOENT' ? { status: 'missing' } : { status: 'not-runnable' });
    });
    child.on('close', () => {
      // A version is accepted even on a non-zero exit: some CLIs print the
      // version and exit non-zero for an unrelated flag warning.
      const version = parseOpencodeVersion(stdout) ?? parseOpencodeVersion(stderr);
      finish(version ? { status: 'detected', version } : { status: 'not-runnable' });
    });
  });
}
