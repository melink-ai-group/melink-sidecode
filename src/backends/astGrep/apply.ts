import { existsSync } from 'node:fs';
import {
  createOpencodeUserConfigIO,
  opencodeUserConfigHasServer,
  removeOpencodeMcpServer,
  upsertOpencodeMcpServer,
  type OpencodeUserConfigIO
} from '../opencode/userConfig.ts';
import {
  AST_GREP_MCP_SERVER,
  astGrepMcpScriptPath,
  astGrepOpencodeServer
} from '../../skills/opencodeMcp.ts';
import { commandLaunch, commandNotFound, runCommand, type CommandRunner, type SpawnOutcome } from '../opencode/zvecGrep.ts';
import { resolveAstGrepExecutable, type AstGrepCliSource } from './resolve.ts';
import type { SkillResolveRoots } from '../skillCli.ts';

const PROBE_TIMEOUT_MS = 8_000;

export type AstGrepCli = 'missing' | 'installed';

export interface AstGrepStatus {
  enabled: boolean;
  cli: AstGrepCli;
  path: string;
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
  userConfig?: OpencodeUserConfigIO;
  platform?: NodeJS.Platform;
}

export async function detectAstGrep(options: {
  source: AstGrepCliSource;
  path: string;
  roots: SkillResolveRoots;
  run?: CommandRunner;
  userConfig?: OpencodeUserConfigIO;
  platform?: NodeJS.Platform;
}): Promise<AstGrepStatus> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  const executable = resolveAstGrepExecutable({
    source: options.source,
    path: options.path,
    roots: options.roots
  });
  const cli = (await cliRuns(run, executable, platform)) ? 'installed' : 'missing';
  const configured = await opencodeUserConfigHasServer(
    AST_GREP_MCP_SERVER,
    options.userConfig ?? createOpencodeUserConfigIO()
  );
  return {
    enabled: configured && cli === 'installed',
    cli,
    path: executable
  };
}

export async function applyAstGrep(options: AstGrepApplyOptions): Promise<AstGrepApplyResult> {
  return options.enabled ? enableAstGrep(options) : disableAstGrep(options);
}

async function enableAstGrep(options: AstGrepApplyOptions): Promise<AstGrepApplyResult> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  const userConfig = options.userConfig ?? createOpencodeUserConfigIO();
  const executable = resolveAstGrepExecutable({
    source: options.source,
    path: options.path,
    roots: options.roots
  });
  if (!(await cliRuns(run, executable, platform))) {
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
  await upsertOpencodeMcpServer(AST_GREP_MCP_SERVER, server, userConfig);
  const status = await detectAstGrep({ ...options, run, userConfig, platform });
  if (!status.enabled) {
    return {
      ok: false,
      ...status,
      message: 'ast-grep finished installing, but OpenCode is not configured to use it.'
    };
  }
  return {
    ok: true,
    ...status,
    message: 'ast-grep is connected to OpenCode. A new session uses it.'
  };
}

async function disableAstGrep(options: AstGrepApplyOptions): Promise<AstGrepApplyResult> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  const userConfig = options.userConfig ?? createOpencodeUserConfigIO();
  const executable = resolveAstGrepExecutable({
    source: options.source,
    path: options.path,
    roots: options.roots
  });
  const cli: AstGrepCli = (await cliRuns(run, executable, platform)) ? 'installed' : 'missing';
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

async function cliRuns(run: CommandRunner, command: string, platform: string): Promise<boolean> {
  const launched = commandLaunch(platform, command, ['--version']);
  const result = await run(launched.command, launched.args, PROBE_TIMEOUT_MS);
  if (commandNotFound(result)) {
    return false;
  }
  return result.error === undefined && result.code === 0;
}

export type { SpawnOutcome };
