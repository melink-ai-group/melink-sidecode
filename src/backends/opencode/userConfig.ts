import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseOpencodeConfig, stripJsonComments } from './jsonc.ts';
import { removeMcpServerText, upsertMcpServerText } from './opencodeConfigText.ts';

export { parseOpencodeConfig, stripJsonComments, stripTrailingCommas } from './jsonc.ts';

/**
 * Read and update the user's OpenCode config MCP map.
 *
 * Candidate paths match zvec-grep's installer. JSONC is accepted (comments and
 * trailing commas), unrelated keys are preserved, and the previous file is
 * kept as `<path>.bak` before a rewrite. A file that cannot be parsed is never
 * written: it is reported instead of being replaced by an MCP-only object.
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

/** True when the config names an MCP server key (not a string mention). */
export function opencodeConfigHasMcpServer(text: string, serverName: string): boolean {
  const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[{,])\\s*["']${escaped}["']\\s*:`, 'm').test(stripJsonComments(text));
}

export type OpencodeMcpServer = Record<string, unknown> | { [key: string]: unknown };

export interface OpencodeUserConfigIO {
  platform: NodeJS.Platform;
  homedir: string;
  xdgConfigHome?: string;
  opencodeConfig?: string;
  exists: (path: string) => boolean;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, text: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
}

export function createOpencodeUserConfigIO(): OpencodeUserConfigIO {
  return {
    platform: process.platform,
    homedir: homedir(),
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    opencodeConfig: process.env.OPENCODE_CONFIG,
    exists: existsSync,
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, text) => writeFile(path, text, 'utf8'),
    mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined)
  };
}

export async function resolveOpencodeConfigPath(io: OpencodeUserConfigIO): Promise<string> {
  const candidates = opencodeConfigCandidates({
    homedir: io.homedir,
    platform: io.platform,
    xdgConfigHome: io.xdgConfigHome,
    opencodeConfig: io.opencodeConfig
  });
  const existing = firstExisting(candidates, io.exists);
  if (existing) {
    return existing;
  }
  return candidates[candidates.length - 1] ?? join(io.homedir, '.config', 'opencode', 'opencode.json');
}

export async function readOpencodeUserConfig(
  io: OpencodeUserConfigIO = createOpencodeUserConfigIO()
): Promise<{
  path: string;
  text: string | undefined;
  data: Record<string, unknown>;
  /** Set when the file exists but cannot be read as JSONC; never write then. */
  error?: string;
}> {
  const path = await resolveOpencodeConfigPath(io);
  if (!io.exists(path)) {
    return { path, text: undefined, data: {} };
  }
  let text: string;
  try {
    text = await io.readFile(path);
  } catch (error) {
    return {
      path,
      text: undefined,
      data: {},
      error: error instanceof Error ? error.message : 'the file could not be read'
    };
  }
  const parsed = parseOpencodeConfig(text);
  if (parsed.error) {
    return { path, text, data: {}, error: parsed.error };
  }
  return { path, text, data: parsed.data };
}

/**
 * Write the new config, keeping the previous file as `<path>.bak`.
 *
 * The backup is written first. If it fails, the target is left untouched, so
 * a partially written config can never replace the user's own settings.
 */
async function writeConfig(
  io: OpencodeUserConfigIO,
  path: string,
  previous: string | undefined,
  text: string
): Promise<void> {
  await io.mkdir(dirname(path));
  if (previous !== undefined && previous !== text) {
    await io.writeFile(`${path}.bak`, previous);
  }
  await io.writeFile(path, text);
}

/**
 * Write an already-prepared config text, keeping the previous file as
 * `<path>.bak` first. Used by the textual migration, which must not round-trip
 * the document through `JSON.stringify` and lose comments or formatting.
 */
export async function replaceOpencodeConfigText(
  io: OpencodeUserConfigIO,
  path: string,
  previous: string | undefined,
  text: string
): Promise<void> {
  await writeConfig(io, path, previous, text);
}

/** Upsert one MCP server entry and write the config file. */
export async function upsertOpencodeMcpServer(
  serverName: string,
  server: Record<string, unknown>,
  io: OpencodeUserConfigIO = createOpencodeUserConfigIO()
): Promise<{ path: string }> {
  const current = await readOpencodeUserConfig(io);
  if (current.error) {
    throw new Error(unreadableMessage(current.path, current.error));
  }
  const edited = current.text === undefined ? { status: 'not-found' as const } : upsertMcpServerText(current.text, serverName, server);
  if (edited.status === 'edited') {
    await writeConfig(io, current.path, current.text, edited.text);
    return { path: current.path };
  }
  if (edited.status === 'ambiguous' || edited.status === 'invalid') {
    throw new Error(`${edited.message} The file was left unchanged.`);
  }
  // A missing or empty file has no text to preserve; the parsed shape is the
  // only thing that can be written.
  const mcp =
    current.data.mcp && typeof current.data.mcp === 'object' && !Array.isArray(current.data.mcp)
      ? { ...(current.data.mcp as Record<string, unknown>) }
      : {};
  mcp[serverName] = { ...server };
  const next = { ...current.data, mcp };
  await writeConfig(io, current.path, current.text, `${JSON.stringify(next, null, 2)}\n`);
  return { path: current.path };
}

/** Remove one MCP server entry when present. */
export async function removeOpencodeMcpServer(
  serverName: string,
  io: OpencodeUserConfigIO = createOpencodeUserConfigIO()
): Promise<{ path: string; removed: boolean }> {
  const current = await readOpencodeUserConfig(io);
  if (current.error) {
    throw new Error(unreadableMessage(current.path, current.error));
  }
  if (!current.text) {
    return { path: current.path, removed: false };
  }
  const edited = removeMcpServerText(current.text, serverName);
  if (edited.status === 'edited') {
    await writeConfig(io, current.path, current.text, edited.text);
    return { path: current.path, removed: true };
  }
  if (edited.status === 'not-found') {
    return { path: current.path, removed: false };
  }
  if (edited.status === 'ambiguous' || edited.status === 'invalid') {
    throw new Error(`${edited.message} The file was left unchanged.`);
  }
  return { path: current.path, removed: false };
}

function unreadableMessage(path: string, error: string): string {
  return `The OpenCode config at ${path} could not be read (${error}). It was left unchanged, so no settings were lost. Fix the JSON syntax and try again.`;
}

export async function opencodeUserConfigHasServer(
  serverName: string,
  io: OpencodeUserConfigIO = createOpencodeUserConfigIO()
): Promise<boolean> {
  const current = await readOpencodeUserConfig(io);
  if (!current.text) {
    return false;
  }
  return opencodeConfigHasMcpServer(current.text, serverName);
}
