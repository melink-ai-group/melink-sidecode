/**
 * Stdio MCP server. It lists the browser tools and forwards each call to the
 * extension's localhost bridge. It does not launch a browser.
 */
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
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

const file = endpointFile();
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
    const text = error instanceof Error && error.message ? error.message : 'The browser call failed.';
    write({ jsonrpc: '2.0', id, error: { code: -32000, message: text } });
  }
}

async function call(message: RpcMessage): Promise<unknown> {
  switch (message.method) {
    case 'initialize':
      return {
        protocolVersion: protocolVersion(message.params),
        capabilities: { tools: {} },
        serverInfo: { name: 'melink-browser', version: '0.1.0' }
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
  const payload = JSON.stringify({ name, arguments: record.arguments ?? {} });
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

function write(message: unknown): void {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${json.length}\r\n\r\n`);
  process.stdout.write(json);
}
