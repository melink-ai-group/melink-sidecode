/**
 * Stdio MCP server. It lists the browser tools and forwards each call to the
 * extension's localhost bridge. It does not launch a browser.
 */
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { asBrowserProvider } from './config.ts';
import { BROWSER_TOOLS } from './tools.ts';

interface Endpoint {
  url: string;
  token: string;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

type Framing = 'line' | 'header';

interface InboundMessage {
  body: string;
  framing: Framing;
}

const file = endpointFile();
const provider = providerFlag();
let queue = Promise.resolve();
let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});

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
    const text = error instanceof Error && error.message ? error.message : 'The browser call failed.';
    write({ jsonrpc: '2.0', id, error: { code: -32000, message: text } }, framing);
  }
}

async function call(message: RpcMessage): Promise<unknown> {
  switch (message.method) {
    case 'initialize':
      return {
        protocolVersion: protocolVersion(message.params),
        capabilities: { tools: {} },
        serverInfo: { name: 'melink-browser', version: '0.2.0' }
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: BROWSER_TOOLS };
    case 'tools/call':
      return forward(message.params);
    default:
      return {};
  }
}

function forward(params: unknown): Promise<unknown> {
  const record = params && typeof params === 'object' ? (params as { name?: unknown; arguments?: unknown }) : {};
  const name = typeof record.name === 'string' ? record.name : '';
  const endpoint = readEndpoint(file);
  const payload = JSON.stringify({
    name,
    arguments: record.arguments ?? {},
    ...(provider ? { provider } : {})
  });
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint.url);
    const req = httpRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          connection: 'close',
          authorization: `Bearer ${endpoint.token}`
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(text) as unknown);
          } catch {
            reject(new Error('The browser bridge returned an unreadable response.'));
          }
        });
      }
    );
    req.setTimeout(60_000, () => {
      req.destroy();
      reject(new Error('The browser bridge did not answer.'));
    });
    req.on('error', () => reject(new Error('The browser bridge is not running. Turn browser control on and try again.')));
    req.end(payload);
  });
}

function protocolVersion(params: unknown): string {
  if (params && typeof params === 'object' && typeof (params as { protocolVersion?: unknown }).protocolVersion === 'string') {
    return (params as { protocolVersion: string }).protocolVersion;
  }
  return '2024-11-05';
}

function readEndpoint(path: string): Endpoint {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Endpoint;
  if (!parsed.url || !parsed.token) {
    throw new Error('The browser endpoint file is incomplete.');
  }
  return parsed;
}

function endpointFile(): string {
  const index = process.argv.indexOf('--endpoint-file');
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    throw new Error('Missing --endpoint-file.');
  }
  return value;
}

function providerFlag(): 'codex' | 'opencode' | undefined {
  const index = process.argv.indexOf('--provider');
  return asBrowserProvider(index >= 0 ? process.argv[index + 1] : undefined);
}

/**
 * Reply in the framing the client used. OpenCode 1.19.x sends and expects
 * newline-delimited JSON; a header reply there is silently ignored and the
 * handshake times out. A header request still gets a header reply so older
 * clients keep working.
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
