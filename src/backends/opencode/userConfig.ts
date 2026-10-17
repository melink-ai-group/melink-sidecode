import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Read and update the user's OpenCode config MCP map.
 *
 * Candidate paths match zvec-grep's installer. Writes are JSON (comments are
 * dropped on rewrite) so absolute-path MCP entries stay reliable for bundled
 * binaries.
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
): Promise<{ path: string; text: string | undefined; data: Record<string, unknown> }> {
  const path = await resolveOpencodeConfigPath(io);
  if (!io.exists(path)) {
    return { path, text: undefined, data: {} };
  }
  try {
    const text = await io.readFile(path);
    const parsed = JSON.parse(stripJsonComments(text)) as unknown;
    const data =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    return { path, text, data };
  } catch {
    return { path, text: undefined, data: {} };
  }
}

/** Upsert one MCP server entry and write the config file. */
export async function upsertOpencodeMcpServer(
  serverName: string,
  server: Record<string, unknown>,
  io: OpencodeUserConfigIO = createOpencodeUserConfigIO()
): Promise<{ path: string }> {
  const current = await readOpencodeUserConfig(io);
  const mcp =
    current.data.mcp && typeof current.data.mcp === 'object' && !Array.isArray(current.data.mcp)
      ? { ...(current.data.mcp as Record<string, unknown>) }
      : {};
  mcp[serverName] = { ...server };
  const next = { ...current.data, mcp };
  await io.mkdir(dirname(current.path));
  await io.writeFile(current.path, `${JSON.stringify(next, null, 2)}\n`);
  return { path: current.path };
}

/** Remove one MCP server entry when present. */
export async function removeOpencodeMcpServer(
  serverName: string,
  io: OpencodeUserConfigIO = createOpencodeUserConfigIO()
): Promise<{ path: string; removed: boolean }> {
  const current = await readOpencodeUserConfig(io);
  if (!current.text) {
    return { path: current.path, removed: false };
  }
  const mcp =
    current.data.mcp && typeof current.data.mcp === 'object' && !Array.isArray(current.data.mcp)
      ? { ...(current.data.mcp as Record<string, unknown>) }
      : undefined;
  if (!mcp || !(serverName in mcp)) {
    return { path: current.path, removed: false };
  }
  delete mcp[serverName];
  const next = { ...current.data };
  if (Object.keys(mcp).length === 0) {
    delete next.mcp;
  } else {
    next.mcp = mcp;
  }
  await io.writeFile(current.path, `${JSON.stringify(next, null, 2)}\n`);
  return { path: current.path, removed: true };
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
