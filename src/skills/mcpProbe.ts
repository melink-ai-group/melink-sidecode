import { spawn } from 'node:child_process';
import { commandLaunch } from '../backends/launch.ts';
import type { OpencodeLocalMcpServer } from './opencodeMcp.ts';

/**
 * One stdio MCP handshake: `initialize` + `tools/list`, then optional
 * `tools/call` requests.
 *
 * This is the same transport OpenCode uses to start a local MCP server, so a
 * probe here answers "will the tool actually be usable?" rather than "does the
 * file exist?". Both framings are accepted because the ecosystem is split:
 * older servers use `Content-Length` headers, newer ones (zvec-grep 0.2.x) send
 * one JSON object per line.
 */

export interface McpToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpCallResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export interface McpProbeResult {
  ok: boolean;
  tools: string[];
  serverInfo?: { name?: string; version?: string };
  calls: McpCallResult[];
  /** Plain-language failure reason, when `ok` is false. */
  message?: string;
}

export interface McpProbeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  comSpec?: string;
  timeoutMs?: number;
  calls?: readonly McpToolCall[];
  /**
   * Request framing. `line` is the modern default and what zg 0.2.x reads;
   * `header` matches the older clients (and OpenCode's browser shim).
   */
  framing?: 'line' | 'header';
}

const PROBE_TIMEOUT_MS = 6_000;
const MAX_BUFFER = 1_000_000;

export function probeOpencodeServer(
  server: OpencodeLocalMcpServer,
  options: McpProbeOptions = {}
): Promise<McpProbeResult> {
  const [command, ...args] = server.command;
  if (!command) {
    return Promise.resolve({
      ok: false,
      tools: [],
      calls: [],
      message: 'The MCP server entry has no command.'
    });
  }
  return runMcpSession(command, args, {
    ...options,
    env: { ...(server.environment ?? {}), ...(options.env ?? {}) }
  });
}

export function runMcpSession(
  command: string,
  args: readonly string[],
  options: McpProbeOptions = {}
): Promise<McpProbeResult> {
  const platform = options.platform ?? process.platform;
  const launched = commandLaunch(platform, command, args, options.comSpec ?? process.env.ComSpec ?? 'cmd.exe');
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const calls = options.calls ?? [];

  return new Promise((resolve) => {
    const tools: string[] = [];
    let serverInfo: McpProbeResult['serverInfo'];
    const callResults: McpCallResult[] = [];
    let stderr = '';
    let settled = false;
    let buffer = Buffer.alloc(0);
    let nextId = 1;
    const pending = new Map<number, (message: JsonRpcResponse) => void>();
    let child: ReturnType<typeof spawn> | undefined;

    const finish = (result: McpProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        // already exited
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        tools,
        calls: callResults,
        ...(serverInfo ? { serverInfo } : {}),
        message: `The MCP server did not answer within ${Math.round(timeoutMs / 1000)} seconds.`
      });
    }, timeoutMs);

    const request = (method: string, params: unknown): Promise<JsonRpcResponse> =>
      new Promise((resolveRequest) => {
        const id = nextId++;
        pending.set(id, resolveRequest);
        writeMessage(id, method, params);
      });

    const writeMessage = (id: number, method: string, params: unknown): void => {
      if (!child) {
        return;
      }
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      if (options.framing === 'header') {
        const bytes = Buffer.from(payload, 'utf8');
        child.stdin?.write(`Content-Length: ${bytes.length}\r\n\r\n`);
        child.stdin?.write(bytes);
        return;
      }
      // Newline-delimited JSON is the modern MCP stdio framing and is accepted
      // by zg 0.2.x; the sideCode shims read both.
      child.stdin?.write(`${payload}\n`);
    };

    try {
      child = spawn(launched.command, launched.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        cwd: options.cwd ?? process.cwd(),
        env: { ...process.env, ...(options.env ?? {}) },
        ...(launched.verbatim ? { windowsVerbatimArguments: true } : {})
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The MCP server could not be started.';
      resolve({ ok: false, tools, calls: callResults, message });
      return;
    }

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        tools,
        calls: callResults,
        message:
          error.code === 'ENOENT'
            ? `The MCP server command was not found: ${command}.`
            : `The MCP server could not be started: ${error.message}`
      });
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk.toString('utf8'));
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_BUFFER) {
        buffer = buffer.subarray(buffer.length - MAX_BUFFER);
      }
      for (const message of readMessages(() => buffer, (next) => (buffer = next))) {
        if (typeof message.id === 'number') {
          pending.get(message.id)?.(message);
          pending.delete(message.id);
        }
      }
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      const line = lastLine(stderr);
      finish({
        ok: false,
        tools,
        calls: callResults,
        ...(serverInfo ? { serverInfo } : {}),
        message:
          line.length > 0
            ? `${line}${code !== null ? ` (exit ${code})` : ''}`
            : `The MCP server exited before answering${code !== null ? ` (exit ${code})` : ''}.`
      });
    });

    void (async () => {
      const initialized = await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'sidecode-probe', version: '0.2.1' }
      });
      if (settled) {
        return;
      }
      if (initialized.error) {
        finish({
          ok: false,
          tools,
          calls: callResults,
          message: initialized.error.message ?? 'The MCP server rejected initialize.'
        });
        return;
      }
      const result = initialized.result as
        | { serverInfo?: { name?: string; version?: string } }
        | undefined;
      serverInfo = result?.serverInfo;

      const listed = await request('tools/list', {});
      if (settled) {
        return;
      }
      if (listed.error) {
        finish({
          ok: false,
          tools,
          calls: callResults,
          ...(serverInfo ? { serverInfo } : {}),
          message: listed.error.message ?? 'The MCP server did not list its tools.'
        });
        return;
      }
      const listedResult = listed.result as { tools?: { name?: unknown }[] } | undefined;
      for (const tool of listedResult?.tools ?? []) {
        if (typeof tool.name === 'string') {
          tools.push(tool.name);
        }
      }

      for (const call of calls) {
        const response = await request('tools/call', { name: call.name, arguments: call.arguments ?? {} });
        if (settled) {
          return;
        }
        if (response.error) {
          callResults.push({ ok: false, error: response.error.message ?? 'The tool call failed.' });
          continue;
        }
        const content = response.result as
          | { content?: { type?: string; text?: unknown }[]; isError?: boolean }
          | undefined;
        const text = (content?.content ?? [])
          .map((part) => (typeof part.text === 'string' ? part.text : ''))
          .filter((part) => part.length > 0)
          .join('\n');
        callResults.push(
          content?.isError ? { ok: false, error: text || 'The tool returned an error.' } : { ok: true, text }
        );
      }

      finish({
        ok: true,
        tools,
        calls: callResults,
        ...(serverInfo ? { serverInfo } : {})
      });
    })().catch((error: unknown) => {
      finish({
        ok: false,
        tools,
        calls: callResults,
        message: error instanceof Error ? error.message : 'The MCP handshake failed.'
      });
    });
  });
}

interface JsonRpcResponse {
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** Pull complete JSON-RPC payloads out of one buffer, in either framing. */
function readMessages(get: () => Buffer, set: (next: Buffer) => void): JsonRpcResponse[] {
  const messages: JsonRpcResponse[] = [];
  while (true) {
    const buffer = get();
    if (buffer.length === 0) {
      return messages;
    }
    const prefix = buffer.subarray(0, Math.min(buffer.length, 32)).toString('ascii');
    if (/^\s*[{[]/.test(prefix)) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        return messages;
      }
      const line = buffer.subarray(0, newline).toString('utf8').trim();
      set(buffer.subarray(newline + 1));
      if (line.length === 0) {
        continue;
      }
      messages.push(parsePayload(line));
      continue;
    }

    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      return messages;
    }
    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match?.[1]) {
      set(buffer.subarray(headerEnd + 4));
      continue;
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) {
      return messages;
    }
    const body = buffer.subarray(start, start + length).toString('utf8');
    set(buffer.subarray(start + length));
    messages.push(parsePayload(body));
  }
}

function parsePayload(text: string): JsonRpcResponse {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as JsonRpcResponse) : {};
  } catch {
    return {};
  }
}

function append(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > 8_000 ? next.slice(next.length - 8_000) : next;
}

function lastLine(text: string): string {
  const lines = text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r\n|\n|\r/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
  const line = lines[lines.length - 1] ?? '';
  return line.length > 240 ? `${line.slice(0, 237)}...` : line;
}
