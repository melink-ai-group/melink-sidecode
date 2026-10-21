/**
 * Stdio MCP server for ast-grep. Shells out to the CLI named by AST_GREP_BIN
 * (or `ast-grep` / `sg` on PATH). Does not rewrite OpenCode config itself.
 *
 * The server runs with the workspace as its working directory and confines
 * every `paths` value to it. `replace` previews by default; writing requires
 * `approve: true` plus explicit paths.
 */
import { spawn } from 'node:child_process';
import { AST_GREP_TOOLS } from './tools.ts';
import { AST_GREP_BIN_ENV } from '../skills/opencodeMcp.ts';
import { buildReplaceArgs, buildSearchArgs } from './args.ts';
import { resolveAstGrepBinValue } from './bin.ts';
import { astGrepWorkspaceRoot, resolveWorkspacePaths, validateWorkspaceGlobs } from './paths.ts';
import { commandLaunch, commandNotFound } from '../backends/launch.ts';

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

const PROBE_TIMEOUT_MS = 8_000;
const RUN_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 512_000;

const workspaceRoot = astGrepWorkspaceRoot();

let queue = Promise.resolve();
let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});

type Framing = 'line' | 'header';

interface InboundMessage {
  body: string;
  framing: Framing;
}

function drain(): void {
  for (const message of readMessages(() => buffer, (next) => (buffer = next))) {
    queue = queue
      .then(() => dispatch(message.body, message.framing))
      .catch(() => undefined);
  }
}

/**
 * Pull complete JSON-RPC payloads out of the buffer.
 *
 * OpenCode 1.19.x writes one JSON object per line and expects the reply in the
 * same framing. Older clients use `Content-Length` headers. Both are read, and
 * the framing is remembered so each reply matches the request that caused it.
 */
function readMessages(get: () => Buffer, set: (next: Buffer) => void): InboundMessage[] {
  const messages: InboundMessage[] = [];
  while (true) {
    const current = get();
    if (current.length === 0) {
      return messages;
    }
    const prefix = current.subarray(0, Math.min(current.length, 32)).toString('ascii');
    if (/^\s*[{[]/.test(prefix)) {
      const newline = current.indexOf(0x0a);
      if (newline < 0) {
        return messages;
      }
      const line = current.subarray(0, newline).toString('utf8').trim();
      set(current.subarray(newline + 1));
      if (line.length > 0) {
        messages.push({ body: line, framing: 'line' });
      }
      continue;
    }
    const headerEnd = current.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      return messages;
    }
    const header = current.subarray(0, headerEnd).toString('ascii');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match?.[1]) {
      set(current.subarray(headerEnd + 4));
      continue;
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (current.length < start + length) {
      return messages;
    }
    messages.push({
      body: current.subarray(start, start + length).toString('utf8'),
      framing: 'header'
    });
    set(current.subarray(start + length));
  }
}

async function dispatch(body: string, framing: Framing): Promise<void> {
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
    write({ jsonrpc: '2.0', id, result }, framing);
  } catch (error) {
    const text = error instanceof Error && error.message ? error.message : 'The ast-grep call failed.';
    write({ jsonrpc: '2.0', id, error: { code: -32000, message: text } }, framing);
  }
}

async function call(message: RpcMessage): Promise<unknown> {
  switch (message.method) {
    case 'initialize':
      return {
        protocolVersion: protocolVersion(message.params),
        capabilities: { tools: {} },
        serverInfo: { name: 'melink-ast-grep', version: '0.3.0' }
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
      const text = await runAstGrep(buildSearchArgs(confineArgs(args, false)));
      return { content: [{ type: 'text', text }] };
    }
    if (name === 'replace') {
      const text = await runAstGrep(buildReplaceArgs(confineArgs(args, args.dryRun === false)));
      return { content: [{ type: 'text', text }] };
    }
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  } catch (error) {
    const text = error instanceof Error && error.message ? error.message : 'ast-grep failed.';
    return { content: [{ type: 'text', text }], isError: true };
  }
}

/**
 * Validate `paths`/`globs` and replace them with workspace-relative values.
 *
 * `requireExplicitPaths` is true for a write: the model must name what it
 * changes rather than rewriting every file the pattern matches.
 */
function confineArgs(args: Record<string, unknown>, requireExplicitPaths: boolean): Record<string, unknown> {
  const rawPaths = Array.isArray(args.paths)
    ? args.paths.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  if (requireExplicitPaths && rawPaths.length === 0) {
    throw new Error('replace writes files only with explicit paths inside the workspace.');
  }
  const globs = Array.isArray(args.globs)
    ? args.globs.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  const globCheck = validateWorkspaceGlobs(globs);
  if (!globCheck.ok) {
    throw new Error(globCheck.error ?? 'The glob is outside the workspace.');
  }
  const checked = resolveWorkspacePaths(rawPaths.length > 0 ? rawPaths : ['.'], workspaceRoot);
  if (!checked.ok) {
    throw new Error(checked.error ?? 'The path is outside the workspace.');
  }
  return { ...args, paths: checked.paths };
}

async function runAstGrep(args: string[]): Promise<string> {
  const command = await resolveAstGrepBin();
  const result = await spawnCapture(command, args, RUN_TIMEOUT_MS);
  if (result.error === 'timeout') {
    throw new Error('ast-grep took too long and was stopped.');
  }
  if (result.error === 'missing' || commandNotFound(result)) {
    throw new Error('ast-grep was not found. Install it under Settings → Skills.');
  }
  if (result.error === 'failed') {
    throw new Error(`ast-grep could not be started: ${lastUsefulLine(result.stderr) || 'unknown error'}.`);
  }
  const text = [result.stdout, result.stderr].filter((part) => part.trim().length > 0).join('\n').trim();
  if (result.code !== 0 && result.code !== null) {
    throw new Error(text || `ast-grep exited with code ${result.code}.`);
  }
  return text || '(no matches)';
}

async function resolveAstGrepBin(): Promise<string> {
  // The env value is the configured CLI path. A relative value (with or
  // without a separator, including a Windows drive-relative one) would run a
  // file from the shim's working directory, so it is refused with a message
  // rather than silently falling back to PATH.
  const configured = process.env[AST_GREP_BIN_ENV]?.trim();
  if (configured) {
    const fromEnv = resolveAstGrepBinValue(configured);
    if (!fromEnv) {
      throw new Error(
        'The configured ast-grep path is relative and would run a file from the workspace. Set an absolute path or a command name under Settings → Skills.'
      );
    }
    return fromEnv;
  }
  for (const name of process.platform === 'win32'
    ? ['ast-grep.exe', 'ast-grep.cmd', 'ast-grep', 'sg.exe', 'sg.cmd', 'sg']
    : ['ast-grep', 'sg']) {
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
    const launched = commandLaunch(
      process.platform,
      command,
      args,
      process.env.ComSpec || 'cmd.exe'
    );
    let child;
    try {
      child = spawn(launched.command, launched.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        cwd: workspaceRoot,
        ...(launched.verbatim ? { windowsVerbatimArguments: true } : {})
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

function lastUsefulLine(value: string): string {
  const lines = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r\n|\n|\r/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
  return lines[lines.length - 1] ?? '';
}

function protocolVersion(params: unknown): string {
  if (params && typeof params === 'object' && typeof (params as { protocolVersion?: unknown }).protocolVersion === 'string') {
    return (params as { protocolVersion: string }).protocolVersion;
  }
  return '2024-11-05';
}

/**
 * Reply in the framing the client used. OpenCode 1.19.x sends and expects
 * newline-delimited JSON; a header reply there is silently ignored and the
 * handshake times out. A header request still gets a header reply so the
 * browser shim and the older probe keep working.
 */
function write(message: unknown, framing: Framing): void {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  if (framing === 'line') {
    process.stdout.write(json);
    process.stdout.write('\n');
    return;
  }
  process.stdout.write(`Content-Length: ${json.length}\r\n\r\n`);
  process.stdout.write(json);
}
