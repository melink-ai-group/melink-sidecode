import { existsSync } from 'node:fs';
import {
  createOpencodeUserConfigIO,
  opencodeUserConfigHasServer,
  readOpencodeUserConfig,
  removeOpencodeMcpServer,
  replaceOpencodeConfigText,
  upsertOpencodeMcpServer,
  type OpencodeUserConfigIO
} from '../opencode/userConfig.ts';
import {
  AST_GREP_MCP_SERVER,
  ELECTRON_RUN_AS_NODE_ENV,
  astGrepMcpScriptPath,
  astGrepOpencodeServer,
  type OpencodeLocalMcpServer
} from '../../skills/opencodeMcp.ts';
import { probeOpencodeServer, type McpProbeResult } from '../../skills/mcpProbe.ts';
import { commandNotFound, windowsCommandCandidates } from '../launch.ts';
import { runCommand, type CommandRunner, type SpawnOutcome } from '../opencode/zvecGrep.ts';
import { resolveAstGrepExecutable, type AstGrepCliSource } from './resolve.ts';
import type { SkillResolveRoots } from '../skillCli.ts';

const PROBE_TIMEOUT_MS = 8_000;

export type AstGrepCli = 'missing' | 'installed';

export type AstGrepServerProbe = (server: OpencodeLocalMcpServer) => Promise<McpProbeResult>;

export interface AstGrepStatus {
  enabled: boolean;
  cli: AstGrepCli;
  path: string;
  /** MCP handshake outcome; `undefined` when no probe seam was supplied. */
  server?: 'ready' | 'failed';
  /** Plain-language reason when the server is not ready. */
  message?: string;
}

export interface AstGrepApplyResult extends AstGrepStatus {
  ok: boolean;
  message: string;
}

export interface AstGrepApplyOptions {
  enabled: boolean;
  source: AstGrepCliSource;
  path: string;
  roots: SkillResolveRoots;
  /** Absolute path to dist/ast-grep-mcp.js */
  mcpScriptPath?: string;
  run?: CommandRunner;
  /** Test seam; production probes the real shim. */
  probeServer?: AstGrepServerProbe;
  userConfig?: OpencodeUserConfigIO;
  platform?: NodeJS.Platform;
}

/**
 * One handshake per shim/CLI/min for the settings snapshot: the probe starts a
 * child Node process, and the snapshot runs on every settings echo.
 */
const SERVER_PROBE_TTL_MS = 60_000;
const serverProbeCache = new Map<string, { at: number; result: McpProbeResult }>();

async function probeServerOnce(server: OpencodeLocalMcpServer): Promise<McpProbeResult> {
  const key = `${server.command.join('\u0000')}\u0001${server.environment?.AST_GREP_BIN ?? ''}`;
  const cached = serverProbeCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < SERVER_PROBE_TTL_MS) {
    return cached.result;
  }
  const result = await probeOpencodeServer(server, { cwd: process.cwd() });
  serverProbeCache.set(key, { at: now, result });
  return result;
}

export async function detectAstGrep(options: {
  source: AstGrepCliSource;
  path: string;
  roots: SkillResolveRoots;
  mcpScriptPath?: string;
  run?: CommandRunner;
  probeServer?: AstGrepServerProbe;
  userConfig?: OpencodeUserConfigIO;
  platform?: NodeJS.Platform;
}): Promise<AstGrepStatus> {
  const run = options.run ?? runCommand;
  const executable = resolveAstGrepExecutable({
    source: options.source,
    path: options.path,
    roots: options.roots
  });
  const cli = (await cliRuns(run, executable)) ? 'installed' : 'missing';
  const configured = await opencodeUserConfigHasServer(
    AST_GREP_MCP_SERVER,
    options.userConfig ?? createOpencodeUserConfigIO()
  );
  if (!configured || cli === 'missing') {
    return { enabled: false, cli, path: executable };
  }

  // "Configured" and "the CLI runs" are not enough: the entry OpenCode spawns
  // must run under Node and answer `initialize` + `tools/list`.
  const mcpScript = options.mcpScriptPath ?? astGrepMcpScriptPath(options.roots.extensionPath);
  if (!existsSync(mcpScript)) {
    return {
      enabled: false,
      cli,
      path: executable,
      server: 'failed',
      message: 'The ast-grep MCP shim is missing from the extension build.'
    };
  }
  const probe = options.probeServer ?? (run === runCommand ? probeServerOnce : undefined);
  if (!probe) {
    return { enabled: true, cli, path: executable };
  }
  const result = await probe(
    astGrepOpencodeServer({
      mcpScriptPath: mcpScript,
      astGrepExecutable: executable,
      workspaceRoot: process.cwd()
    })
  );
  if (result.ok) {
    return { enabled: true, cli, path: executable, server: 'ready' };
  }
  return {
    enabled: false,
    cli,
    path: executable,
    server: 'failed',
    message: result.message ?? 'The ast-grep MCP server did not answer.'
  };
}

export async function applyAstGrep(options: AstGrepApplyOptions): Promise<AstGrepApplyResult> {
  return options.enabled ? enableAstGrep(options) : disableAstGrep(options);
}

async function enableAstGrep(options: AstGrepApplyOptions): Promise<AstGrepApplyResult> {
  const run = options.run ?? runCommand;
  const userConfig = options.userConfig ?? createOpencodeUserConfigIO();
  const executable = resolveAstGrepExecutable({
    source: options.source,
    path: options.path,
    roots: options.roots
  });
  if (!(await cliRuns(run, executable))) {
    return {
      ok: false,
      enabled: false,
      cli: 'missing',
      path: executable,
      message:
        options.source === 'bundled'
          ? 'Bundled ast-grep is not installed. Use Install under Settings → Skills.'
          : 'ast-grep was not found. Set a path or install the bundled CLI under Settings → Skills.'
    };
  }

  const mcpScript = options.mcpScriptPath ?? astGrepMcpScriptPath(options.roots.extensionPath);
  if (!existsSync(mcpScript)) {
    return {
      ok: false,
      enabled: false,
      cli: 'installed',
      path: executable,
      message: 'The ast-grep MCP shim is missing from the extension build.'
    };
  }

  const server = astGrepOpencodeServer({
    mcpScriptPath: mcpScript,
    astGrepExecutable: executable
  });
  const before = await readOpencodeUserConfig(userConfig).catch(() => undefined);
  try {
    await upsertOpencodeMcpServer(AST_GREP_MCP_SERVER, server, userConfig);
    // The saved entry just changed; re-probe instead of reusing an earlier
    // failure for the same shim/CLI pair.
    serverProbeCache.clear();
  } catch (error) {
    await rollbackAstGrepEntry(before, userConfig);
    return {
      ok: false,
      enabled: false,
      cli: 'installed',
      path: executable,
      message:
        error instanceof Error && error.message
          ? error.message
          : 'ast-grep could not be connected to OpenCode. The OpenCode config could not be updated.'
    };
  }
  const status = await detectAstGrep({ ...options, run, userConfig });
  if (!status.enabled) {
    // A failed handshake must not leave a live MCP entry behind while Settings
    // says the skill is off. Restore the exact bytes we read (comments and all).
    await rollbackAstGrepEntry(before, userConfig);
    return {
      ok: false,
      ...status,
      message:
        status.message ?? 'ast-grep finished installing, but OpenCode is not configured to use it.'
    };
  }
  return {
    ok: true,
    ...status,
    message: 'ast-grep is connected to OpenCode. A new session uses it.'
  };
}

async function disableAstGrep(options: AstGrepApplyOptions): Promise<AstGrepApplyResult> {
  const run = options.run ?? runCommand;
  const userConfig = options.userConfig ?? createOpencodeUserConfigIO();
  const executable = resolveAstGrepExecutable({
    source: options.source,
    path: options.path,
    roots: options.roots
  });
  const cli: AstGrepCli = (await cliRuns(run, executable)) ? 'installed' : 'missing';
  const configured = await opencodeUserConfigHasServer(AST_GREP_MCP_SERVER, userConfig);
  if (!configured) {
    return { ok: true, enabled: false, cli, path: executable, message: 'ast-grep is off.' };
  }
  await removeOpencodeMcpServer(AST_GREP_MCP_SERVER, userConfig);
  const still = await opencodeUserConfigHasServer(AST_GREP_MCP_SERVER, userConfig);
  if (still) {
    return {
      ok: false,
      enabled: true,
      cli,
      path: executable,
      message: 'ast-grep is still connected to OpenCode.'
    };
  }
  return {
    ok: true,
    enabled: false,
    cli,
    path: executable,
    message: 'ast-grep is off. A new OpenCode session no longer uses it.'
  };
}

/**
 * Rewrite a stored `ast_grep` entry from the old Electron-host shape to the
 * Node-runtime shape (`process.execPath` + `ELECTRON_RUN_AS_NODE=1`).
 *
 * OpenCode launches the stored argv, not whatever `detectAstGrep` probes, so a
 * stale entry could show Ready while the real session starts `Code.exe` as the
 * editor. Idempotent, keeps unrelated bytes/comments through the textual upsert,
 * and leaves an unparsable config untouched. The AST_GREP_BIN path from the
 * entry is kept; a missing one is not invented.
 */
export async function migrateLegacyAstGrepEntry(options: {
  mcpScriptPath: string;
  userConfig?: OpencodeUserConfigIO;
}): Promise<{ changed: boolean; path?: string; message?: string }> {
  const userConfig = options.userConfig ?? createOpencodeUserConfigIO();
  const current = await readOpencodeUserConfig(userConfig).catch(() => undefined);
  if (!current || current.error) {
    return {
      changed: false,
      path: current?.path,
      message: 'The OpenCode config could not be read, so the ast-grep entry was not migrated.'
    };
  }
  const mcp = current.data.mcp;
  const entry =
    mcp && typeof mcp === 'object' && !Array.isArray(mcp)
      ? (mcp as Record<string, unknown>)[AST_GREP_MCP_SERVER]
      : undefined;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { changed: false, path: current.path };
  }
  const record = entry as Record<string, unknown>;
  const command = Array.isArray(record.command)
    ? record.command.filter((part): part is string => typeof part === 'string')
    : [];
  if (command.length < 2) {
    return { changed: false, path: current.path };
  }
  const script = command[1];
  if (!script || !script.replace(/\\/g, '/').endsWith('ast-grep-mcp.js')) {
    return { changed: false, path: current.path };
  }
  const environment =
    record.environment && typeof record.environment === 'object' && !Array.isArray(record.environment)
      ? (record.environment as Record<string, string>)
      : {};
  const isHostBinary = /[\\/]Code\.exe$/i.test(command[0] ?? '') || command[0] === process.execPath;
  const nodeExecutable = isHostBinary ? process.execPath : (command[0] as string);
  const needsFlag = environment[ELECTRON_RUN_AS_NODE_ENV] !== '1';
  const needsScript = script !== options.mcpScriptPath;
  if (!needsFlag && !needsScript && (isHostBinary || command[0] === nodeExecutable)) {
    return { changed: false, path: current.path };
  }
  const astGrepExecutable =
    typeof environment.AST_GREP_BIN === 'string' && environment.AST_GREP_BIN.trim().length > 0
      ? environment.AST_GREP_BIN
      : 'ast-grep';
  const workspaceRoot =
    typeof environment.AST_GREP_WORKSPACE === 'string' ? environment.AST_GREP_WORKSPACE : undefined;
  const server = astGrepOpencodeServer({
    nodeExecutable,
    mcpScriptPath: options.mcpScriptPath,
    astGrepExecutable,
    ...(workspaceRoot ? { workspaceRoot } : {})
  });
  await upsertOpencodeMcpServer(
    AST_GREP_MCP_SERVER,
    { ...record, ...server, environment: { ...environment, ...server.environment } },
    userConfig
  );
  return { changed: true, path: current.path };
}

/**
 * Put the config back the way it was before a failed enable. Best effort: a
 * rollback failure must not hide the original connect failure, and the next
 * enable/disable retries the same safe edit.
 */
async function rollbackAstGrepEntry(
  before: Awaited<ReturnType<typeof readOpencodeUserConfig>> | undefined,
  userConfig: OpencodeUserConfigIO
): Promise<void> {
  if (!before || before.error) {
    return;
  }
  try {
    if (before.text === undefined) {
      await removeOpencodeMcpServer(AST_GREP_MCP_SERVER, userConfig);
      return;
    }
    await replaceOpencodeConfigText(userConfig, before.path, undefined, before.text);
  } catch {
    // The reason the apply failed is reported to the user; a locked config is
    // retried on the next toggle.
  }
}

async function cliRuns(run: CommandRunner, command: string): Promise<boolean> {
  // `runCommand` (the production runner) applies the Windows `.cmd` launch
  // rule, but Node does not apply PATHEXT to a bare name. Try the Windows
  // `.exe`/`.cmd` names so a default `ast-grep` setting finds the npm shim.
  for (const candidate of windowsCommandCandidates(command, process.platform)) {
    const result = await run(candidate, ['--version'], PROBE_TIMEOUT_MS);
    if (commandNotFound(result)) {
      continue;
    }
    if (result.error === undefined && result.code === 0) {
      return true;
    }
  }
  return false;
}

export type { SpawnOutcome };
