import { join } from 'node:path';

/**
 * OpenCode MCP server entries and permission keys for SideCode skills.
 *
 * Used both when writing the user OpenCode config and when injecting into
 * per-turn OPENCODE_CONFIG_CONTENT.
 */

export const ZVEC_GREP_MCP_SERVER = 'zvec_grep';
export const AST_GREP_MCP_SERVER = 'ast_grep';

export const AST_GREP_TOOL_NAMES = ['search', 'replace'] as const;
export const ZVEC_GREP_TOOL_NAMES = ['zvec_grep_search'] as const;

/**
 * The permission key OpenCode resolves for one MCP tool.
 *
 * OpenCode 1.19.x registers an MCP tool as `<server>_<tool>` and asks for that
 * exact key, not the bare tool name. A rule written as `replace` therefore
 * never matches `ast_grep_replace`, and OpenCode's permissive `*` default
 * applies. These helpers are the single source of truth for the generated
 * config and the turn's pre-allow map.
 */
export function opencodeMcpToolPermissionKey(server: string, tool: string): string {
  return `${server}_${tool}`;
}

export const AST_GREP_SEARCH_PERMISSION = opencodeMcpToolPermissionKey(AST_GREP_MCP_SERVER, 'search');
export const AST_GREP_REPLACE_PERMISSION = opencodeMcpToolPermissionKey(AST_GREP_MCP_SERVER, 'replace');
export const ZVEC_GREP_SEARCH_PERMISSION = opencodeMcpToolPermissionKey(
  ZVEC_GREP_MCP_SERVER,
  'zvec_grep_search'
);

/** Env var the ast-grep MCP shim reads for the CLI binary. */
export const AST_GREP_BIN_ENV = 'AST_GREP_BIN';
/** Env var the ast-grep MCP shim uses as the workspace root for path checks. */
export const AST_GREP_WORKSPACE_ENV = 'AST_GREP_WORKSPACE';
/** Makes the Electron host binary behave as a plain Node process. */
export const ELECTRON_RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE';

export interface OpencodeLocalMcpServer {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  enabled: boolean;
  [key: string]: unknown;
}

/**
 * zvec-grep's stdio transport.
 *
 * 0.2.x uses the `server` subcommand (`zg server --stdio`); the old
 * `zg --server --stdio` form is rejected with `Unknown command: --server`.
 */
export function zvecGrepServerArgs(): string[] {
  return ['server', '--stdio'];
}

/** zvec-grep stdio MCP entry pointing at an absolute `zg` path. */
export function zvecGrepOpencodeServer(zgExecutable: string): OpencodeLocalMcpServer {
  return {
    type: 'local',
    command: [zgExecutable, ...zvecGrepServerArgs()],
    enabled: true
  };
}

/**
 * The Node executable that runs the SideCode MCP shims.
 *
 * Inside the extension host `process.execPath` is `Code.exe`, so the entry also
 * sets `ELECTRON_RUN_AS_NODE=1` (the same pattern the browser skill uses).
 * Setting it for a real `node` binary is harmless: only Electron reads it.
 */
export function astGrepNodeExecutable(nodeExecutable?: string): string {
  return nodeExecutable ?? process.execPath;
}

/**
 * ast-grep MCP entry: Node runs the SideCode shim; the shim shells out to
 * `AST_GREP_BIN`.
 */
export function astGrepOpencodeServer(options: {
  nodeExecutable?: string;
  mcpScriptPath: string;
  astGrepExecutable: string;
  /** Workspace root the shim confines `paths` to. */
  workspaceRoot?: string;
}): OpencodeLocalMcpServer {
  const environment: Record<string, string> = {
    [AST_GREP_BIN_ENV]: options.astGrepExecutable,
    [ELECTRON_RUN_AS_NODE_ENV]: '1'
  };
  if (options.workspaceRoot?.trim()) {
    environment[AST_GREP_WORKSPACE_ENV] = options.workspaceRoot.trim();
  }
  return {
    type: 'local',
    command: [astGrepNodeExecutable(options.nodeExecutable), options.mcpScriptPath],
    environment,
    enabled: true
  };
}

export function astGrepMcpScriptPath(extensionPath: string): string {
  return join(extensionPath, 'dist', 'ast-grep-mcp.js');
}

/** Merge skill MCP servers into an existing map (browser or otherwise). */
export function mergeSkillOpencodeMcp(
  existing: Record<string, unknown> | undefined,
  skills: {
    zvecGrep?: OpencodeLocalMcpServer;
    astGrep?: OpencodeLocalMcpServer;
  }
): Record<string, unknown> | undefined {
  let next = existing ? { ...existing } : undefined;
  if (skills.zvecGrep) {
    next = { ...(next ?? {}), [ZVEC_GREP_MCP_SERVER]: skills.zvecGrep };
  }
  if (skills.astGrep) {
    next = { ...(next ?? {}), [AST_GREP_MCP_SERVER]: skills.astGrep };
  }
  return next;
}

/**
 * Read-only tool permissions for the skills that are on.
 *
 * Never allow the bare server key: `ast_grep: allow` covers every tool the
 * server exposes, including the file-writing `replace`. `ast_grep_replace` is
 * also not in this map; the config builder sets it from the turn's permission
 * level so read-only/Ask deny it and Default/Plan ask before the call.
 *
 * The keys are the resolved names OpenCode uses (`<server>_<tool>`), not the
 * MCP tool's own `search`/`replace` names.
 */
export function skillPermissionKeys(skills: {
  zvecGrep?: boolean;
  astGrep?: boolean;
}): Record<string, 'allow'> {
  const keys: Record<string, 'allow'> = {};
  if (skills.zvecGrep) {
    keys[ZVEC_GREP_SEARCH_PERMISSION] = 'allow';
  }
  if (skills.astGrep) {
    keys[AST_GREP_SEARCH_PERMISSION] = 'allow';
  }
  return keys;
}
