import { spawn, type ChildProcess } from 'node:child_process';
import { summarizeOpencodeCliOutput } from './upgradeText.ts';
import { executablePathError, resolveExecutableCommand, resolveProbedExecutable } from '../executables.ts';

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

/** Outcome of `opencode upgrade`. The message is one plain sentence, never raw CLI chrome. */
export interface OpencodeUpgradeResult {
  ok: boolean;
  message: string;
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
 *
 * A relative path is refused: the child process runs with the workspace as
 * its working directory, so such a value would name a file inside the
 * repository. That covers a relative path with a separator (`./evil`,
 * `..\evil`) and the Windows drive-relative form (`C:evil.exe`), which
 * carries no separator but resolves against the workspace anyway.
 */
export function opencodePathError(value: string, exists: (path: string) => boolean): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Enter the opencode CLI path or name. This value was not saved.';
  }
  const resolved = resolveExecutableCommand(trimmed, 'opencode');
  if (!resolved.ok) {
    return executablePathError(resolved.reason, 'opencode CLI');
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
  /**
   * The spawn seam. A test can record the command that was launched instead
   * of running a real binary.
   */
  spawnImpl?: typeof spawn;
}

/**
 * Probe the configured executable.
 *
 * The value is resolved through the shared executable rules first, so a
 * relative path with a separator — or a Windows drive-relative path such as
 * `C:evil.exe` — is never spawned. The probe runs the bare command name
 * instead, and reports it as missing when no such binary is on PATH.
 */
export function probeOpencode(
  executable: string,
  options: OpencodeProbeOptions = {}
): Promise<OpencodeProbeResult> {
  const exe = resolveProbedExecutable(executable, 'opencode');
  const timeoutMs = options.timeoutMs ?? 4_000;
  const launch = options.spawnImpl ?? spawn;

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
      child = launch(exe, ['--version'], {
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

/** How long `opencode upgrade` may run before it is stopped. Downloads can be slow. */
const UPGRADE_TIMEOUT_MS = 120_000;

export interface OpencodeUpgradeOptions {
  timeoutMs?: number;
  cwd?: string;
  /**
   * The spawn seam. A test can record the command that was launched instead
   * of running a real binary.
   */
  spawnImpl?: typeof spawn;
}

/**
 * Run `opencode upgrade` against the configured executable.
 *
 * Prefer `installOpencodeRelease` from settings for Update: the CLI's own
 * upgrade can exit 0 without replacing a custom or non-npm binary. Kept for
 * direct probing of the CLI command itself. Direct spawn, no shell. Output is
 * reduced to one sentence so color codes and progress bars stay out of the UI.
 *
 * The value goes through the shared executable rules first, exactly like the
 * probe does: a relative path with a separator — or a Windows drive-relative
 * path such as `C:evil.exe` — would name a file inside the workspace, so it is
 * refused and the bare command name is used instead.
 */
export function upgradeOpencode(
  executable: string,
  options: OpencodeUpgradeOptions = {}
): Promise<OpencodeUpgradeResult> {
  const exe = resolveProbedExecutable(executable, 'opencode');
  const timeoutMs = options.timeoutMs ?? UPGRADE_TIMEOUT_MS;
  const launch = options.spawnImpl ?? spawn;

  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let stdout = '';
    let stderr = '';
    let child: ChildProcess | undefined;

    const finish = (result: OpencodeUpgradeResult): void => {
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
        // The child already exited.
      }
      resolve(result);
    };

    try {
      child = launch(exe, ['upgrade'], {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      });
    } catch {
      resolve({ ok: false, message: 'The opencode CLI could not be started.' });
      return;
    }

    timer = setTimeout(() => finish({ ok: false, message: 'The opencode update timed out.' }), timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        message: error.code === 'ENOENT' ? 'The opencode CLI was not found.' : 'The opencode CLI could not be started.'
      });
    });
    child.on('close', (code) => {
      finish({
        ok: code === 0,
        message: summarizeOpencodeCliOutput(`${stdout}\n${stderr}`, code)
      });
    });
  });
}
