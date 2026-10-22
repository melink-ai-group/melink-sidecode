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
  readOpencodeUserConfig,
  removeOpencodeMcpServer,
  replaceOpencodeConfigText,
  stripJsonComments,
  upsertOpencodeMcpServer,
  type OpencodeUserConfigIO
} from './userConfig.ts';
import { rewriteLegacyZvecCommand } from './opencodeConfigText.ts';
import {
  zvecGrepOpencodeServer,
  ZVEC_GREP_MCP_SERVER,
  type OpencodeLocalMcpServer
} from '../../skills/opencodeMcp.ts';
import {
  bundledZvecGrepExecutable,
  bundledZvecGrepPrefix,
  type ZvecGrepCliSource
} from '../zvecGrep/resolve.ts';
import { resolveExecutableCommand } from '../executables.ts';
import {
  commandLaunch,
  commandNotFound,
  windowsCommandCandidates,
  windowsCommandLine
} from '../launch.ts';
import { probeOpencodeServer, type McpProbeResult } from '../../skills/mcpProbe.ts';
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
  /** True when `zg` runs, the MCP server answers, and OpenCode has the entry. */
  enabled: boolean;
  cli: ZvecGrepCli;
  /**
   * The MCP handshake outcome. `undefined` when the caller injected a runner
   * without a handshake seam (unit tests use that to keep the probe host-free).
   */
  server?: 'ready' | 'failed';
  /** Plain-language reason when the server is not ready. */
  message?: string;
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

/**
 * Optional MCP handshake seam.
 *
 * The production IO runs the server entry (`zg server --stdio`) and asks for
 * `tools/list`; tests inject a fake so detection stays host-free.
 */
export type ServerProbe = (server: OpencodeLocalMcpServer) => Promise<McpProbeResult>;

export interface ZvecGrepIO {
  run: CommandRunner;
  /** The selected OpenCode config text, or undefined when no file exists. */
  readConfig(): Promise<string | undefined>;
  platform: NodeJS.Platform;
  probeServer?: ServerProbe;
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
 * Whether a zg version supports the `server` subcommand the MCP entry uses.
 * Unknown version strings pass; the handshake then decides.
 */
export function zvecVersionSupported(version: string | undefined): boolean {
  const match = /(\d+)\.(\d+)/.exec(version ?? '');
  if (!match?.[1] || !match[2]) {
    return true;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) {
    return true;
  }
  return major > 0 || (major === 0 && minor >= 2);
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

/** Install into a sideCode-managed prefix (bundled). */
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

export { commandLaunch, commandNotFound, windowsCommandLine };

/** Spawn one command. Output is capped so a long install log stays bounded. */
export function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number
): Promise<SpawnOutcome> {
  return runCommandAt(command, args, timeoutMs);
}

/** Spawn one command with an explicit working directory (indexing and status). */
export function runCommandAt(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  cwd?: string
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
        ...(cwd ? { cwd } : {}),
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

/**
 * Keep the handshake cheap: one probe per binary per minute. The settings
 * snapshot runs on every save echo, and each probe starts `zg server --stdio`.
 */
const SERVER_PROBE_TTL_MS = 60_000;
const serverProbeCache = new Map<string, { at: number; result: McpProbeResult }>();

async function probeServerOnce(server: OpencodeLocalMcpServer): Promise<McpProbeResult> {
  const key = server.command.join('\u0000');
  const cached = serverProbeCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < SERVER_PROBE_TTL_MS) {
    return cached.result;
  }
  const result = await probeOpencodeServer(server);
  serverProbeCache.set(key, { at: now, result });
  return result;
}

/**
 * Run `<cli> --version` with the same Windows `.cmd` launch rule the turns and
 * the MCP shim use. `probeOpencode` spawns directly, which reports a `.cmd`
 * shim as not runnable; a skill CLI must be probed the way it is started.
 */
export async function probeExecutableVersion(
  command: string,
  timeoutMs = 8_000,
  platform: NodeJS.Platform = process.platform
): Promise<{ status: 'detected' | 'missing' | 'not-runnable'; version?: string }> {
  let last: 'missing' | 'not-runnable' = 'missing';
  for (const candidate of windowsCommandCandidates(command, platform)) {
    const result = await runCommandAt(candidate, ['--version'], timeoutMs);
    if (result.error === 'missing' || commandNotFound(result)) {
      last = 'missing';
      continue;
    }
    if (result.error !== undefined || result.code !== 0) {
      last = 'not-runnable';
      continue;
    }
    const match = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(`${result.stdout}\n${result.stderr}`);
    return match?.[1] ? { status: 'detected', version: match[1] } : { status: 'detected' };
  }
  return { status: last };
}

export function createZvecGrepIO(): ZvecGrepIO {  return {
    platform: process.platform,
    run: runCommand,
    readConfig: readOpencodeConfig,
    probeServer: probeServerOnce
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
  const [configured, command] = await Promise.all([
    configHasZvecGrep(ctx.io, ctx.userConfig),
    locateZg(ctx)
  ]);
  const cli: ZvecGrepCli = command ? 'installed' : 'missing';
  if (!command) {
    return { enabled: false, cli };
  }
  if (!configured) {
    return { enabled: false, cli };
  }
  // Detection is not "the file exists": the server entry OpenCode will spawn
  // must answer `initialize` + `tools/list`. A wrong argv (`zg --server`) or a
  // broken proxy is reported here instead of after a failed turn.
  const probe = ctx.io.probeServer;
  if (!probe) {
    return { enabled: true, cli };
  }
  const result = await probe(zvecGrepOpencodeServer(command));
  if (result.ok) {
    return { enabled: true, cli, server: 'ready' };
  }
  return {
    enabled: false,
    cli,
    server: 'failed',
    message: result.message ?? 'The zvec-grep MCP server did not answer.'
  };
}

/**
 * Rewrite the known legacy zvec-grep MCP entry `[zg, '--server', '--stdio']`
 * to the 0.2.x form `[zg, 'server', '--stdio']`.
 *
 * Idempotent and safe: the known argv shape is rewritten textually, so
 * comments, trailing commas, indentation and unrelated keys stay
 * byte-for-byte. The previous file is kept as `<path>.bak`, and an unparsable,
 * ambiguous or unsafe rewrite is never written. Other legacy shapes fall back
 * to the parsed upsert (which preserves keys but normalises formatting).
 * Best-effort at activation; `enableZvecGrep` calls it before applying.
 */
export async function migrateLegacyZvecServer(
  userConfig: OpencodeUserConfigIO = createOpencodeUserConfigIO()
): Promise<{ changed: boolean; path?: string; message?: string; mode?: 'textual' | 'parsed' }> {
  const current = await readOpencodeUserConfig(userConfig);
  if (current.error) {
    return {
      changed: false,
      path: current.path,
      message: 'The OpenCode config could not be read, so the zvec-grep entry was not migrated.'
    };
  }
  const mcp =
    current.data.mcp && typeof current.data.mcp === 'object' && !Array.isArray(current.data.mcp)
      ? (current.data.mcp as Record<string, unknown>)
      : undefined;
  const entry = mcp?.[ZVEC_GREP_MCP_SERVER];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { changed: false, path: current.path };
  }
  const command = (entry as { command?: unknown }).command;
  if (!Array.isArray(command) || typeof command[0] !== 'string') {
    return { changed: false, path: current.path };
  }
  const rest = command.slice(1).filter((part): part is string => typeof part === 'string');
  const legacy = rest.includes('--server') && rest[0] !== 'server';
  if (!legacy) {
    return { changed: false, path: current.path };
  }
  if (current.text === undefined) {
    return { changed: false, path: current.path };
  }
  const textual = rewriteLegacyZvecCommand(current.text);
  if (textual.status === 'rewritten') {
    await replaceOpencodeConfigText(userConfig, current.path, current.text, textual.text);
    return { changed: true, path: current.path, mode: 'textual' };
  }
  if (textual.status === 'ambiguous' || textual.status === 'invalid') {
    return { changed: false, path: current.path, message: textual.message };
  }
  // No exact textual match: another legacy argv shape (for example flags in a
  // different order). The parsed upsert keeps keys but normalises formatting.
  const extra = rest.filter((part) => part !== '--server' && part !== '--stdio');
  const next = {
    ...(entry as Record<string, unknown>),
    command: [command[0], 'server', '--stdio', ...extra]
  };
  await upsertOpencodeMcpServer(ZVEC_GREP_MCP_SERVER, next, userConfig);
  return { changed: true, path: current.path, mode: 'parsed' };
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
  // Repair a config written by an older build before the upsert below decides
  // the final entry. A parse failure is reported by the upsert, not here.
  await migrateLegacyZvecServer(ctx.userConfig).catch(() => undefined);
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
  const before = await readOpencodeUserConfig(ctx.userConfig).catch(() => undefined);
  try {
    await upsertOpencodeMcpServer(ZVEC_GREP_MCP_SERVER, server, ctx.userConfig);
    // The saved entry just changed; re-probe instead of reusing an earlier
    // failure for the same binary.
    serverProbeCache.clear();
  } catch {
    await rollbackZvecEntry(before, ctx.userConfig);
    return {
      ok: false,
      enabled: false,
      cli: 'installed',
      message: 'zvec-grep could not be connected to OpenCode. The OpenCode config could not be updated.'
    };
  }

  const status = await detectZvecGrep(ctx);
  if (!status.enabled) {
    // A failed handshake must not leave a live MCP entry behind while Settings
    // says the skill is off. Restore the exact bytes we read (comments and all).
    await rollbackZvecEntry(before, ctx.userConfig);
    return {
      ok: false,
      enabled: false,
      cli: status.cli,
      ...(status.server ? { server: status.server } : {}),
      message:
        status.message ??
        'zvec-grep finished installing, but OpenCode is not configured to use it.'
    };
  }
  return {
    ok: true,
    enabled: true,
    cli: 'installed',
    message: 'zvec-grep is connected to OpenCode. A new session uses it.'
  };
}

/**
 * Restore the config read before a failed enable. Best effort: the connect
 * failure is what the user needs to see, and a locked file is retried on the
 * next toggle.
 */
async function rollbackZvecEntry(
  before: Awaited<ReturnType<typeof readOpencodeUserConfig>> | undefined,
  userConfig: OpencodeUserConfigIO
): Promise<void> {
  if (!before || before.error) {
    return;
  }
  try {
    if (before.text === undefined) {
      await removeOpencodeMcpServer(ZVEC_GREP_MCP_SERVER, userConfig);
      return;
    }
    await replaceOpencodeConfigText(userConfig, before.path, undefined, before.text);
  } catch {
    // Reported by the apply result; the next toggle retries.
  }
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

/**
 * Find `zg` for the active source.
 *
 * Bundled prefers the sideCode-managed prefix. Local uses the path setting,
 * PATH, then npm's global prefix.
 *
 * A path setting that is relative and contains a separator is skipped: it
 * would run a file from the workspace's working directory, so the PATH lookup
 * is used instead.
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

  const resolved = resolveExecutableCommand(ctx.path, '');
  if (resolved.ok && resolved.command.length > 0) {
    if (await zgRuns(io, resolved.command)) {
      return resolved.command;
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
  // When sideCode owns the user-config IO, that file is authoritative (enable
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
