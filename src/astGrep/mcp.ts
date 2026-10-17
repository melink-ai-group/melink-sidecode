/**
 * Stdio MCP server for ast-grep. Shells out to the CLI named by AST_GREP_BIN
 * (or `ast-grep` / `sg` on PATH). Does not rewrite OpenCode config itself.
 */
import { spawn } from 'node:child_process';
import { AST_GREP_TOOLS } from './tools.ts';
import { AST_GREP_BIN_ENV } from '../skills/opencodeMcp.ts';
import { buildReplaceArgs, buildSearchArgs } from './args.ts';

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

const PROBE_TIMEOUT_MS = 8_000;
const RUN_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 512_000;

let queue = Promise.resolve();
let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});

function drain(): void {
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      return;
    }
    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match?.[1]) {
      buffer = Buffer.alloc(0);
      return;
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) {
      return;
    }
    const body = buffer.subarray(start, start + length).toString('utf8');
    buffer = buffer.subarray(start + length);
    queue = queue.then(() => dispatch(body)).catch(() => undefined);
  }
}

async function dispatch(body: string): Promise<void> {
  let message: RpcMessage;
  try {
    message = JSON.parse(body) as RpcMessage;
  } catch {
    return;
  }
  if (message.id === undefined || message.id === null) {
    return;
  }
  const id = message.id;
  try {
    const result = await call(message);
    write({ jsonrpc: '2.0', id, result });
  } catch (error) {
    const text = error instanceof Error && error.message ? error.message : 'The ast-grep call failed.';
    write({ jsonrpc: '2.0', id, error: { code: -32000, message: text } });
  }
}

async function call(message: RpcMessage): Promise<unknown> {
  switch (message.method) {
    case 'initialize':
      return {
        protocolVersion: protocolVersion(message.params),
        capabilities: { tools: {} },
        serverInfo: { name: 'melink-ast-grep', version: '0.2.0' }
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: AST_GREP_TOOLS };
    case 'tools/call':
      return runTool(message.params);
    default:
      return {};
  }
}

async function runTool(params: unknown): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const record = params && typeof params === 'object' ? (params as { name?: unknown; arguments?: unknown }) : {};
  const name = typeof record.name === 'string' ? record.name : '';
  const args =
    record.arguments && typeof record.arguments === 'object' && !Array.isArray(record.arguments)
      ? (record.arguments as Record<string, unknown>)
      : {};
  try {
    if (name === 'search') {
      const text = await runAstGrep(buildSearchArgs(args));
      return { content: [{ type: 'text', text }] };
    }
    if (name === 'replace') {
      const text = await runAstGrep(buildReplaceArgs(args));
      return { content: [{ type: 'text', text }] };
    }
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  } catch (error) {
    const text = error instanceof Error && error.message ? error.message : 'ast-grep failed.';
    return { content: [{ type: 'text', text }], isError: true };
  }
}

async function runAstGrep(args: string[]): Promise<string> {
  const command = await resolveAstGrepBin();
  const result = await spawnCapture(command, args, RUN_TIMEOUT_MS);
  if (result.error === 'timeout') {
    throw new Error('ast-grep took too long and was stopped.');
  }
  if (result.error === 'missing') {
    throw new Error('ast-grep was not found. Install it under Settings → Skills.');
  }
  const text = [result.stdout, result.stderr].filter((part) => part.trim().length > 0).join('\n').trim();
  if (result.code !== 0 && result.code !== null) {
    throw new Error(text || `ast-grep exited with code ${result.code}.`);
  }
  return text || '(no matches)';
}

async function resolveAstGrepBin(): Promise<string> {
  const fromEnv = process.env[AST_GREP_BIN_ENV]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  for (const name of process.platform === 'win32' ? ['ast-grep.exe', 'ast-grep', 'sg.exe', 'sg'] : ['ast-grep', 'sg']) {
    const probe = await spawnCapture(name, ['--version'], PROBE_TIMEOUT_MS);
    if (probe.error === undefined && probe.code === 0) {
      return name;
    }
  }
  throw new Error('ast-grep was not found. Install it under Settings → Skills.');
}

function spawnCapture(
  command: string,
  args: readonly string[],
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string; error?: 'missing' | 'failed' | 'timeout' }> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: {
      code: number | null;
      stdout: string;
      stderr: string;
      error?: 'missing' | 'failed' | 'timeout';
    }): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };
    let child;
    try {
      child = spawn(command, [...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        cwd: process.cwd()
      });
    } catch {
      finish({ code: null, stdout: '', stderr: '', error: 'failed' });
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already exited
      }
      finish({ code: null, stdout, stderr, error: 'timeout' });
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk.toString());
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

function append(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_OUTPUT ? next.slice(next.length - MAX_OUTPUT) : next;
}

function protocolVersion(params: unknown): string {
  if (params && typeof params === 'object' && typeof (params as { protocolVersion?: unknown }).protocolVersion === 'string') {
    return (params as { protocolVersion: string }).protocolVersion;
  }
  return '2024-11-05';
}

function write(message: unknown): void {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${json.length}\r\n\r\n`);
  process.stdout.write(json);
}
