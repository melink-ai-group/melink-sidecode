import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import {
  createOpencodeUserConfigIO,
  firstExisting,
  opencodeConfigCandidates,
  opencodeConfigHasMcpServer,
  removeOpencodeMcpServer,
  stripJsonComments,
  upsertOpencodeMcpServer,
  type OpencodeUserConfigIO
} from './userConfig.ts';
import { zvecGrepOpencodeServer, ZVEC_GREP_MCP_SERVER } from '../../skills/opencodeMcp.ts';
import {
  bundledZvecGrepExecutable,
  bundledZvecGrepPrefix,
  type ZvecGrepCliSource
} from '../zvecGrep/resolve.ts';
import type { SkillResolveRoots } from '../skillCli.ts';

/**
 * Turn zvec-grep's OpenCode integration on or off.
 *
 * Enable installs `@zvec/zvec-grep` when `zg` is missing (npm global for local,
 * or npm `--prefix` under extension global storage for bundled), then writes an
 * absolute-path `zvec_grep` MCP entry into the user OpenCode config. Disable
 * removes that entry (and best-effort runs `zg uninstall` for AGENTS.md cleanup).
 */

/** @deprecated Prefer opencodeConfigHasMcpServer(text, 'zvec_grep'). */
export function opencodeConfigHasZvecGrep(text: string): boolean {
  return opencodeConfigHasMcpServer(text, ZVEC_GREP_MCP_SERVER);
}

export { opencodeConfigCandidates, firstExisting, stripJsonComments };

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

/**
 * Installer arguments.
 *
 * npm's published CLI (0.2.x) uses subcommands: `zg install`. A later CLI that
 * rejects that verb with `Unknown command` is retried as `zg --install`.
 */
export function zgIntegrationArgs(
  action: 'install' | 'uninstall',
  style: 'subcommand' | 'flag' = 'subcommand'
): readonly string[] {
  const verb = style === 'flag' ? `--${action}` : action;
  return [verb, '--target', 'opencode', '--yes'];
}

/** True when this CLI does not recognize the verb we just sent. */
export function rejectsIntegrationVerb(result: SpawnOutcome, action: 'install' | 'uninstall'): boolean {
  const text = `${result.stdout}\n${result.stderr}`;
  return new RegExp(`unknown command:\\s*-*${action}\\b`, 'i').test(text);
}

export function npmGlobalInstallArgs(): readonly string[] {
  return ['install', '-g', ZVEC_GREP_PACKAGE];
}

/** Install into a SideCode-managed prefix (bundled). */
export function npmPrefixInstallArgs(prefix: string): readonly string[] {
  return ['install', '-g', '--prefix', prefix, ZVEC_GREP_PACKAGE];
}

/**
 * The `zg` shim npm writes for a global prefix.
 *
 * On Windows the prefix directory itself holds `zg.cmd`. Elsewhere the shim is
 * `prefix/bin/zg`. This is used when the extension host's PATH does not include
 * that directory, which a new terminal would not fix inside this process.
 */
export function zgGlobalBin(prefix: string, platform: string): string {
  const root = prefix.trim().replace(/[\\/]+$/, '');
  if (platform === 'win32') {
    return win32.join(root, 'zg.cmd');
  }
  return posix.join(root, 'bin', 'zg');
}

/**
 * How to start a command without `shell: true`.
 *
 * Node on Windows rejects a direct spawn of `.cmd` / `.bat` (`EINVAL`, no
 * output). Those files are started through `cmd.exe /d /s /c` with a quoted
 * command built only from our own arguments.
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

/** One Windows command line. Arguments that need quoting are quoted; nothing is passed to a shell string from settings. */
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
export function commandNotFound(result: SpawnOutcome): boolean {
  if (result.error === 'missing') {
    return true;
  }
  const text = `${result.stdout}\n${result.stderr}`;
  return /not recognized as an internal or external command/i.test(text) || /\bcommand not found\b/i.test(text);
}

/** Spawn one command. Output is capped so a long install log stays bounded. */
export function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number
): Promise<SpawnOutcome> {
  const launched = commandLaunch(process.platform, command, args, process.env.ComSpec || 'cmd.exe');
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
      child = spawn(launched.command, launched.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        ...(launched.verbatim ? { windowsVerbatimArguments: true } : {})
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

export interface ZvecGrepApplyContext {
  io?: ZvecGrepIO;
  source?: ZvecGrepCliSource;
  path?: string;
  roots?: SkillResolveRoots;
  userConfig?: OpencodeUserConfigIO;
}

export async function detectZvecGrep(
  ioOrContext: ZvecGrepIO | ZvecGrepApplyContext = createZvecGrepIO()
): Promise<ZvecGrepStatus> {
  const ctx = normalizeContext(ioOrContext);
  const [configured, cli] = await Promise.all([
    configHasZvecGrep(ctx.io, ctx.userConfig),
    probeZg(ctx)
  ]);
  return { enabled: configured && cli === 'installed', cli };
}

/**
 * Apply the user's choice. A failure leaves the previous integration in place
 * and reports `enabled` from a fresh detection.
 */
export async function applyZvecGrep(
  enabled: boolean,
  ioOrContext: ZvecGrepIO | ZvecGrepApplyContext = createZvecGrepIO()
): Promise<ZvecGrepApplyResult> {
  const ctx = normalizeContext(ioOrContext);
  return enabled ? enableZvecGrep(ctx) : disableZvecGrep(ctx);
}

function normalizeContext(ioOrContext: ZvecGrepIO | ZvecGrepApplyContext): Required<
  Pick<ZvecGrepApplyContext, 'io' | 'source' | 'path' | 'userConfig'>
> & { roots?: SkillResolveRoots } {
  if (isZvecGrepIO(ioOrContext)) {
    return {
      io: ioOrContext,
      source: 'local',
      path: '',
      userConfig: createOpencodeUserConfigIO(),
      roots: undefined
    };
  }
  return {
    io: ioOrContext.io ?? createZvecGrepIO(),
    source: ioOrContext.source ?? 'local',
    path: ioOrContext.path ?? '',
    roots: ioOrContext.roots,
    userConfig: ioOrContext.userConfig ?? createOpencodeUserConfigIO()
  };
}

function isZvecGrepIO(value: ZvecGrepIO | ZvecGrepApplyContext): value is ZvecGrepIO {
  return typeof (value as ZvecGrepIO).run === 'function' && typeof (value as ZvecGrepIO).readConfig === 'function';
}

async function enableZvecGrep(
  ctx: ReturnType<typeof normalizeContext>
): Promise<ZvecGrepApplyResult> {
  let command = await locateZg(ctx);
  if (!command) {
    const ready = await ensureZgInstalled(ctx);
    if (!ready.ok) {
      return { ok: false, enabled: false, cli: 'missing', message: ready.message };
    }
    command = await locateZg(ctx);
    if (!command) {
      return {
        ok: false,
        enabled: false,
        cli: 'missing',
        message: await missingZgMessage(ctx.io)
      };
    }
  }

  // Official installer may write AGENTS.md and a bare-name MCP entry; we then
  // overwrite the MCP entry with an absolute path so bundled/local installs work.
  await runIntegration(ctx.io, command, 'install').catch(() => undefined);

  const server = zvecGrepOpencodeServer(command);
  try {
    await upsertOpencodeMcpServer(ZVEC_GREP_MCP_SERVER, server, ctx.userConfig);
  } catch {
    return {
      ok: false,
      enabled: false,
      cli: 'installed',
      message: 'zvec-grep could not be connected to OpenCode. The OpenCode config could not be updated.'
    };
  }

  const status = await detectZvecGrep(ctx);
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

async function disableZvecGrep(
  ctx: ReturnType<typeof normalizeContext>
): Promise<ZvecGrepApplyResult> {
  const configured = await configHasZvecGrep(ctx.io, ctx.userConfig);
  const command = await locateZg(ctx);
  const cli: ZvecGrepCli = command ? 'installed' : 'missing';
  if (!configured) {
    return { ok: true, enabled: false, cli, message: 'zvec-grep is off.' };
  }

  await removeOpencodeMcpServer(ZVEC_GREP_MCP_SERVER, ctx.userConfig);
  if (command) {
    await runIntegration(ctx.io, command, 'uninstall').catch(() => undefined);
  }

  const stillConfigured = await configHasZvecGrep(ctx.io, ctx.userConfig);
  if (stillConfigured) {
    return {
      ok: false,
      enabled: true,
      cli,
      message: 'zvec-grep is still connected to OpenCode.'
    };
  }
  return {
    ok: true,
    enabled: false,
    cli: cli === 'installed' ? 'installed' : 'missing',
    message: 'zvec-grep is off. A new OpenCode session no longer uses it.'
  };
}

/** Run the OpenCode installer. Retry the other verb shape when this CLI rejects the first. */
async function runIntegration(
  io: ZvecGrepIO,
  command: string,
  action: 'install' | 'uninstall'
): Promise<SpawnOutcome> {
  const first = await io.run(command, zgIntegrationArgs(action, 'subcommand'), INSTALL_TIMEOUT_MS);
  if (!rejectsIntegrationVerb(first, action)) {
    return first;
  }
  return io.run(command, zgIntegrationArgs(action, 'flag'), INSTALL_TIMEOUT_MS);
}

async function ensureZgInstalled(
  ctx: ReturnType<typeof normalizeContext>
): Promise<{ ok: true } | { ok: false; message: string }> {
  const io = ctx.io;
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
  const args =
    ctx.source === 'bundled' && ctx.roots
      ? npmPrefixInstallArgs(bundledZvecGrepPrefix(ctx.roots))
      : npmGlobalInstallArgs();
  const installed = await io.run(npm, args, NPM_TIMEOUT_MS);
  if (installed.error === 'missing' || commandNotFound(installed)) {
    return {
      ok: false,
      message:
        'npm was not found, so zvec-grep was not installed. Install Node.js 22 or newer, then run npm install -g @zvec/zvec-grep.'
    };
  }
  if (installed.error || installed.code !== 0) {
    return { ok: false, message: failureMessage(installed, 'zvec-grep could not be installed') };
  }
  return { ok: true };
}

async function probeZg(ctx: ReturnType<typeof normalizeContext>): Promise<ZvecGrepCli> {
  return (await locateZg(ctx)) ? 'installed' : 'missing';
}

/**
 * Find `zg` for the active source.
 *
 * Bundled prefers the SideCode-managed prefix. Local uses the path setting,
 * PATH, then npm's global prefix.
 */
async function locateZg(ctx: ReturnType<typeof normalizeContext>): Promise<string | undefined> {
  const io = ctx.io;
  if (ctx.source === 'bundled' && ctx.roots) {
    const bundled = bundledZvecGrepExecutable(ctx.roots, io.platform);
    if (await zgRuns(io, bundled)) {
      return bundled;
    }
    return undefined;
  }

  const trimmed = ctx.path.trim();
  if (trimmed.length > 0) {
    if (await zgRuns(io, trimmed)) {
      return trimmed;
    }
  }

  const names = io.platform === 'win32' ? ['zg.cmd', 'zg'] : ['zg'];
  for (const name of names) {
    if (await zgRuns(io, name)) {
      return name;
    }
  }
  const prefix = await npmPrefix(io);
  if (!prefix) {
    return undefined;
  }
  const bin = zgGlobalBin(prefix, io.platform);
  return (await zgRuns(io, bin)) ? bin : undefined;
}

async function zgRuns(io: ZvecGrepIO, command: string): Promise<boolean> {
  const result = await io.run(command, ['--version'], PROBE_TIMEOUT_MS);
  return result.error === undefined && result.code === 0;
}

async function npmPrefix(io: ZvecGrepIO): Promise<string | undefined> {
  const npm = io.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = await io.run(npm, ['prefix', '-g'], PROBE_TIMEOUT_MS);
  if (result.error || result.code !== 0) {
    return undefined;
  }
  const line = result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .pop();
  return line;
}

async function missingZgMessage(io: ZvecGrepIO): Promise<string> {
  const prefix = await npmPrefix(io);
  const where = prefix ? ` It was installed under ${prefix}.` : '';
  return `zvec-grep was installed, but zg could not be started.${where} From a terminal, run: zg install --target opencode --yes.`;
}

async function configHasZvecGrep(io: ZvecGrepIO, userConfig?: OpencodeUserConfigIO): Promise<boolean> {
  // When SideCode owns the user-config IO, that file is authoritative (enable
  // upserts / disable removes it). Fall back to the probe readConfig otherwise.
  if (userConfig) {
    try {
      const path = await resolveConfigPath(userConfig);
      if (!userConfig.exists(path)) {
        return false;
      }
      const current = await userConfig.readFile(path);
      return opencodeConfigHasZvecGrep(current);
    } catch {
      return false;
    }
  }
  const text = await io.readConfig();
  return text !== undefined && opencodeConfigHasZvecGrep(text);
}

async function resolveConfigPath(userConfig: OpencodeUserConfigIO): Promise<string> {
  const candidates = opencodeConfigCandidates({
    homedir: userConfig.homedir,
    platform: userConfig.platform,
    xdgConfigHome: userConfig.xdgConfigHome,
    opencodeConfig: userConfig.opencodeConfig
  });
  return firstExisting(candidates, userConfig.exists) ?? candidates[candidates.length - 1]!;
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
    return `${fallback}. It took too long and was stopped. ${MANUAL_OPENCODE}`;
  }
  const line = lastUsefulLine(result.stderr) || lastUsefulLine(result.stdout);
  if (line) {
    return line.length > 240 ? `${line.slice(0, 237)}...` : line;
  }
  if (result.code !== null && result.code !== 0) {
    return `${fallback} (exit ${result.code}). ${MANUAL_OPENCODE}`;
  }
  return `${fallback}. ${MANUAL_OPENCODE}`;
}

const MANUAL_OPENCODE = 'From a terminal, run: zg install --target opencode --yes.';

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
