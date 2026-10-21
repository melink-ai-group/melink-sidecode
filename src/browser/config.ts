import type { JsonValue } from '../../schemas/serde_json/JsonValue.ts';

/**
 * The MCP server entry both agents receive when browser control is on.
 *
 * Pure: the command is decided by the host, and this module only shapes it
 * into each agent's config. With no command, the builders add nothing, which
 * is the off state.
 */

/** How an agent process should spawn the stdio shim. The token is not here. */
export interface BrowserCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export const BROWSER_MCP_SERVER = 'melink_browser';

/** Tool names the browser server exposes. Kept in one list so permissions match. */
export const BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_resize',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_console'
] as const;

/**
 * Codex thread `config` fragment. `null` when the skill is off, so the caller
 * omits the field and the thread starts as it does today.
 */
export function codexBrowserConfig(command: BrowserCommand | undefined): { [key: string]: JsonValue } | null {
  if (!command) {
    return null;
  }
  const server: { [key: string]: JsonValue } = {
    command: command.command,
    args: command.args,
    env: command.env,
    enabled: true
  };
  const servers: { [key: string]: JsonValue } = { melink_browser: server };
  return { mcp_servers: servers };
}

/** One OpenCode local MCP server, in the same shape as the zvec-grep entry. */
export function opencodeBrowserServer(command: BrowserCommand): Record<string, unknown> {
  return {
    type: 'local',
    command: [command.command, ...command.args],
    environment: command.env,
    enabled: true
  };
}

/**
 * Add the browser server beside any servers already in the map.
 * Passing no command returns the existing map unchanged, including `undefined`.
 */
export function mergeOpencodeMcp(
  existing: Record<string, unknown> | undefined,
  command: BrowserCommand | undefined
): Record<string, unknown> | undefined {
  if (!command) {
    return existing;
  }
  return { ...existing, [BROWSER_MCP_SERVER]: opencodeBrowserServer(command) };
}

/** Permission keys that let the browser tools run without a per-click prompt. */
export function browserPermissionKeys(): Record<string, 'allow'> {
  const keys: Record<string, 'allow'> = { [BROWSER_MCP_SERVER]: 'allow' };
  for (const name of BROWSER_TOOL_NAMES) {
    keys[name] = 'allow';
  }
  return keys;
}
