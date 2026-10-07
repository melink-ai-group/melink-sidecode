import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Turn zvec-grep's official OpenCode integration on or off.
 *
 * Enable installs `@zvec/zvec-grep` when `zg` is missing, then runs
 * `zg --install --target opencode --yes`. Disable runs the matching uninstall
 * and leaves the npm package in place. This module never writes the OpenCode
 * config itself and never passes `--force`.
 */

export const ZVEC_GREP_PACKAGE = '@zvec/zvec-grep';

/** zvec-grep requires Node.js 22 or newer. */
export const ZVEC_GREP_MIN_NODE_MAJOR = 22;

const PROBE_TIMEOUT_MS = 8_000;
const INSTALL_TIMEOUT_MS = 90_000;
const NPM_TIMEOUT_MS = 180_000;
const MAX_OUTPUT = 64_000;

export type ZvecGrepCli = 'missing' | 'installed';

export interface ZvecGrepStatus {
  /** True when `zg` runs and the OpenCode config has a `zvec_grep` server. */
  enabled: boolean;
  cli: ZvecGrepCli;
}

export interface ZvecGrepApplyResult extends ZvecGrepStatus {
  ok: boolean;
  message: string;
}

export interface SpawnOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: 'missing' | 'failed' | 'timeout';
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number
) => Promise<SpawnOutcome>;

export interface ZvecGrepIO {
  run: CommandRunner;
  /** The selected OpenCode config text, or undefined when no file exists. */
  readConfig(): Promise<string | undefined>;
  platform: NodeJS.Platform;
}

/** The first `major.minor.patch` token in a `node --version` line. */
export function nodeMajor(output: string): number | undefined {
  const match = output.match(/v?(\d+)\.\d+\.\d+/);
  if (!match?.[1]) {
    return undefined;
  }
  const major = Number(match[1]);
  return Number.isInteger(major) ? major : undefined;
}

/** Official installer flags. The old `zg install` form is a search, not a command. */
export function zgIntegrationArgs(action: 'install' | 'uninstall'): readonly string[] {
  return [action === 'install' ? '--install' : '--uninstall', '--target', 'opencode', '--yes'];
}

export function npmGlobalInstallArgs(): readonly string[] {
  return ['install', '-g', ZVEC_GREP_PACKAGE];
}

/**
 * Config files `zg --install --target opencode` would read.
 *
 * `OPENCODE_CONFIG` is the exact file. Otherwise `opencode.jsonc` is preferred
 * over `opencode.json`. Windows uses `~/.config`; other platforms honor
 * `XDG_CONFIG_HOME`.
 */
export function opencodeConfigCandidates(input: {
  homedir: string;
  platform: string;
  xdgConfigHome?: string;
  opencodeConfig?: string;
}): string[] {
  const selected = input.opencodeConfig?.trim();
  if (selected) {
    return [selected];
  }
  const root =
    input.platform === 'win32'
      ? join(input.homedir, '.config')
      : input.xdgConfigHome?.trim() || join(input.homedir, '.config');
  const dir = join(root, 'opencode');
  return [join(dir, 'opencode.jsonc'), join(dir, 'opencode.json')];
}

export function firstExisting(
  candidates: readonly string[],
  exists: (path: string) => boolean
): string | undefined {
  return candidates.find((candidate) => exists(candidate));
}

/**
 * True when the config names a `zvec_grep` server.
 *
 * Comments are ignored so a commented example does not count. The search is
 * the server key, not a mention of the name in a string.
 */
export function opencodeConfigHasZvecGrep(text: string): boolean {
  return /(?:^|[{,])\s*["']zvec_grep["']\s*:/m.test(stripJsonComments(text));
}

/** Drop `//` and block comments, leaving string contents in place. */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const current = text[i] ?? '';
    const next = text[i + 1] ?? '';
    if (current === '"' || current === "'") {
      const quote = current;
      out += current;
      i += 1;
      while (i < text.length) {
        const ch = text[i] ?? '';
        out += ch;
        if (ch === '\\') {
          const escaped = text[i + 1];
          if (escaped !== undefined) {
            out += escaped;
          }
          i += 2;
          continue;
        }
        i += 1;
        if (ch === quote) {
          break;
        }
      }
      continue;
    }
    if (current === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (current === '/' && next === '*') {
      i += 2;
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i += 1;
      }
      i = Math.min(text.length, i + 2);
      continue;
    }
    out += current;
    i += 1;
  }
  return out;
}

/** Spawn one command. No shell. Output is capped so a long install log stays bounded. */
export function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let stdout = '';
    let stderr = '';
    let child: ChildProcess | undefined;

    const finish = (result: SpawnOutcome): void => {
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
      child = spawn(command, [...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      });
    } catch {
      resolve({ code: null, stdout: '', stderr: '', error: 'failed' });
      return;
    }

    timer = setTimeout(() => finish({ code: null, stdout, stderr, error: 'timeout' }), timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk.toString());
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        code: null,
        stdout,
        stderr,
        error: error.code === 'ENOENT' ? 'missing' : 'failed'
      });
    });
    child.on('close', (code) => {
      finish({ code, stdout, stderr });
    });
  });
}

export function createZvecGrepIO(): ZvecGrepIO {
  return {
    platform: process.platform,
    run: runCommand,
    readConfig: readOpencodeConfig
  };
}

export async function detectZvecGrep(io: ZvecGrepIO = createZvecGrepIO()): Promise<ZvecGrepStatus> {
  const [configured, cli] = await Promise.all([configHasZvecGrep(io), probeZg(io)]);
  return { enabled: configured && cli === 'installed', cli };
}

/**
 * Apply the user's choice. A failure leaves the previous integration in place
 * and reports `enabled` from a fresh detection.
 */
export async function applyZvecGrep(
  enabled: boolean,
  io: ZvecGrepIO = createZvecGrepIO()
): Promise<ZvecGrepApplyResult> {
  return enabled ? enableZvecGrep(io) : disableZvecGrep(io);
}

async function enableZvecGrep(io: ZvecGrepIO): Promise<ZvecGrepApplyResult> {
  let cli = await probeZg(io);
  if (cli === 'missing') {
    const ready = await ensureZgInstalled(io);
    if (!ready.ok) {
      return { ok: false, enabled: false, cli: 'missing', message: ready.message };
    }
    cli = await probeZg(io);
    if (cli === 'missing') {
      return {
        ok: false,
        enabled: false,
        cli: 'missing',
        message: 'zvec-grep was installed, but the zg command was not found. Open a new terminal, then try again.'
      };
    }
  }

  const installed = await runZg(io, zgIntegrationArgs('install'), INSTALL_TIMEOUT_MS);
  const status = await detectZvecGrep(io);
  if (installed.error || installed.code !== 0) {
    return {
      ok: false,
      enabled: status.enabled,
      cli: status.cli,
      message: failureMessage(installed, 'zvec-grep could not be connected to OpenCode')
    };
  }
  if (!status.enabled) {
    return {
      ok: false,
      enabled: false,
      cli: status.cli,
      message: 'zvec-grep finished installing, but OpenCode is not configured to use it.'
    };
  }
  return {
    ok: true,
    enabled: true,
    cli: 'installed',
    message: 'zvec-grep is connected to OpenCode. A new session uses it.'
  };
}

async function disableZvecGrep(io: ZvecGrepIO): Promise<ZvecGrepApplyResult> {
  const configured = await configHasZvecGrep(io);
  const cli = await probeZg(io);
  if (!configured) {
    return { ok: true, enabled: false, cli, message: 'zvec-grep is off.' };
  }
  if (cli === 'missing') {
    return {
      ok: false,
      enabled: false,
      cli: 'missing',
      message: 'zvec-grep is listed in the OpenCode config, but zg was not found, so it could not be removed.'
    };
  }

  const removed = await runZg(io, zgIntegrationArgs('uninstall'), INSTALL_TIMEOUT_MS);
  const stillConfigured = await configHasZvecGrep(io);
  if (removed.error || removed.code !== 0 || stillConfigured) {
    return {
      ok: false,
      enabled: stillConfigured,
      cli,
      message: stillConfigured && !removed.error && removed.code === 0
        ? 'zvec-grep is still connected to OpenCode.'
        : failureMessage(removed, 'zvec-grep could not be disconnected from OpenCode')
    };
  }
  return {
    ok: true,
    enabled: false,
    cli: 'installed',
    message: 'zvec-grep is off. A new OpenCode session no longer uses it.'
  };
}

async function ensureZgInstalled(io: ZvecGrepIO): Promise<{ ok: true } | { ok: false; message: string }> {
  const node = await io.run('node', ['--version'], PROBE_TIMEOUT_MS);
  if (node.error === 'missing') {
    return { ok: false, message: 'Node.js 22 or newer is required to install zvec-grep.' };
  }
  const major = nodeMajor(`${node.stdout}\n${node.stderr}`);
  if (node.error || node.code !== 0 || major === undefined) {
    return { ok: false, message: 'Node.js 22 or newer is required to install zvec-grep.' };
  }
  if (major < ZVEC_GREP_MIN_NODE_MAJOR) {
    return {
      ok: false,
      message: `zvec-grep needs Node.js 22 or newer. This machine has Node.js ${major}.`
    };
  }

  const npm = io.platform === 'win32' ? 'npm.cmd' : 'npm';
  const installed = await io.run(npm, npmGlobalInstallArgs(), NPM_TIMEOUT_MS);
  if (installed.error === 'missing') {
    return { ok: false, message: 'npm was not found, so zvec-grep was not installed.' };
  }
  if (installed.error || installed.code !== 0) {
    return { ok: false, message: failureMessage(installed, 'zvec-grep could not be installed') };
  }
  return { ok: true };
}

async function probeZg(io: ZvecGrepIO): Promise<ZvecGrepCli> {
  const result = await runZg(io, ['--version'], PROBE_TIMEOUT_MS);
  return result.error === 'missing' ? 'missing' : 'installed';
}

async function configHasZvecGrep(io: ZvecGrepIO): Promise<boolean> {
  const text = await io.readConfig();
  return text !== undefined && opencodeConfigHasZvecGrep(text);
}

/** On Windows, npm's shim is `zg.cmd`. A native `zg` is tried when that shim is absent. */
async function runZg(io: ZvecGrepIO, args: readonly string[], timeoutMs: number): Promise<SpawnOutcome> {
  if (io.platform !== 'win32') {
    return io.run('zg', args, timeoutMs);
  }
  const shim = await io.run('zg.cmd', args, timeoutMs);
  if (shim.error === 'missing') {
    return io.run('zg', args, timeoutMs);
  }
  return shim;
}

async function readOpencodeConfig(): Promise<string | undefined> {
  const path = firstExisting(
    opencodeConfigCandidates({
      homedir: homedir(),
      platform: process.platform,
      xdgConfigHome: process.env.XDG_CONFIG_HOME,
      opencodeConfig: process.env.OPENCODE_CONFIG
    }),
    existsSync
  );
  if (!path) {
    return undefined;
  }
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

function appendOutput(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_OUTPUT ? next.slice(next.length - MAX_OUTPUT) : next;
}

function failureMessage(result: SpawnOutcome, fallback: string): string {
  if (result.error === 'timeout') {
    return `${fallback}. It took too long and was stopped.`;
  }
  const line = lastUsefulLine(result.stderr) || lastUsefulLine(result.stdout);
  if (line) {
    return line.length > 240 ? `${line.slice(0, 237)}...` : line;
  }
  if (result.code !== null && result.code !== 0) {
    return `${fallback} (exit ${result.code}).`;
  }
  return `${fallback}.`;
}

function lastUsefulLine(value: string): string {
  const lines = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r\n|\n|\r/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
  const line = lines[lines.length - 1] ?? '';
  if (!line) {
    return '';
  }
  return /[.!?]$/.test(line) ? line : `${line}.`;
}
