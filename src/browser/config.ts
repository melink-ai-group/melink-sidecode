import type { JsonValue } from '../../schemas/serde_json/JsonValue.ts';
import { opencodeMcpToolPermissionKey } from '../skills/opencodeMcp.ts';
import type { BrowserSkillProvider } from './policy.ts';
import { BROWSER_TOOLS } from './tools.ts';

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

/**
 * Tool names the browser server exposes, taken from the tool definitions so a
 * tool added to `BROWSER_TOOLS` also gets a permission key without a second
 * list to keep in sync.
 */
export const BROWSER_TOOL_NAMES: readonly string[] = BROWSER_TOOLS.map((tool) => tool.name);

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

/**
 * Permission keys that let the browser tools run without a per-click prompt.
 *
 * OpenCode resolves an MCP tool to `<server>_<tool>`, so a rule written as
 * `browser_navigate` or as the bare server `melink_browser` never matches.
 * The bare server key is deliberately absent: it would also cover any tool a
 * future release adds without an explicit decision here.
 */
export function browserPermissionKeys(): Record<string, 'allow'> {
  const keys: Record<string, 'allow'> = {};
  for (const name of BROWSER_TOOL_NAMES) {
    keys[opencodeMcpToolPermissionKey(BROWSER_MCP_SERVER, name)] = 'allow';
  }
  return keys;
}

/**
 * The endpoint filename for one window.
 *
 * `unique` is the window's per-skill token, so two windows never share a file
 * and one window's stop only removes its own. `pid` is injectable for tests.
 */
export function browserEndpointFileName(unique: string, pid: number = process.pid): string {
  const safe = unique.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  return `browser-endpoint-${pid}-${safe || 'window'}.json`;
}

/** The provider named on the shim command line, or undefined when absent/invalid. */
export function asBrowserProvider(value: unknown): BrowserSkillProvider | undefined {
  return value === 'codex' || value === 'opencode' ? value : undefined;
}

/**
 * Whether a bridge call may run.
 *
 * Agent calls carry the provider that spawned the shim, so a thread keeps
 * working only while its own provider still has the skill on. Panel calls have
 * no provider and stay allowed while either provider is on.
 */
export function browserAgentCallAllowed(
  provider: BrowserSkillProvider | undefined,
  enabled: (provider?: BrowserSkillProvider) => boolean
): boolean {
  return provider ? enabled(provider) : enabled();
}
