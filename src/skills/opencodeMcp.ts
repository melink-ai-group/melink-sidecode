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

/** Env var the ast-grep MCP shim reads for the CLI binary. */
export const AST_GREP_BIN_ENV = 'AST_GREP_BIN';

export interface OpencodeLocalMcpServer {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  enabled: boolean;
  [key: string]: unknown;
}

/** zvec-grep stdio MCP entry pointing at an absolute `zg` path. */
export function zvecGrepOpencodeServer(zgExecutable: string): OpencodeLocalMcpServer {
  return {
    type: 'local',
    command: [zgExecutable, '--server', '--stdio'],
    enabled: true
  };
}

/**
 * ast-grep MCP entry: Node runs the SideCode shim; the shim shells out to
 * `AST_GREP_BIN`.
 */
export function astGrepOpencodeServer(options: {
  nodeExecutable?: string;
  mcpScriptPath: string;
  astGrepExecutable: string;
}): OpencodeLocalMcpServer {
  return {
    type: 'local',
    command: [options.nodeExecutable ?? process.execPath, options.mcpScriptPath],
    environment: {
      [AST_GREP_BIN_ENV]: options.astGrepExecutable
    },
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

export function skillPermissionKeys(skills: {
  zvecGrep?: boolean;
  astGrep?: boolean;
}): Record<string, 'allow'> {
  const keys: Record<string, 'allow'> = {};
  if (skills.zvecGrep) {
    keys[ZVEC_GREP_MCP_SERVER] = 'allow';
    for (const name of ZVEC_GREP_TOOL_NAMES) {
      keys[name] = 'allow';
    }
  }
  if (skills.astGrep) {
    keys[AST_GREP_MCP_SERVER] = 'allow';
    for (const name of AST_GREP_TOOL_NAMES) {
      keys[name] = 'allow';
    }
  }
  return keys;
}
