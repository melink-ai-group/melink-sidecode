import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { ToolResult } from './tools.ts';

/** A tool call the stdio shim forwards onto the extension. */
export interface BridgeCall {
  name: string;
  arguments: unknown;
}

const MAX_BODY = 1_000_000;

/**
 * Localhost listener the MCP shim calls. It does not launch a browser; the
 * handler does that on the first tool call.
 */
export class BrowserBridge {
  private server?: Server;
  private token = '';

  constructor(private readonly handle: (call: BridgeCall) => Promise<ToolResult>) {}

  /** Bind 127.0.0.1 and return the URL the shim should POST to. */
  start(token: string): Promise<string> {
    this.token = token;
    if (this.server) {
      const address = this.server.address();
      if (address && typeof address === 'object') {
        return Promise.resolve(`http://127.0.0.1:${address.port}/call`);
      }
    }
    const server = createServer((request, response) => {
      void this.onRequest(request, response);
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('The browser bridge did not bind a port.'));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}/call`);
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async onRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/call') {
      respond(response, 404, { content: [{ type: 'text', text: 'Not found.' }], isError: true });
      return;
    }
    if (!authorized(request.headers.authorization, this.token)) {
      respond(response, 401, { content: [{ type: 'text', text: 'The browser bridge refused the call.' }], isError: true });
      return;
    }
    const body = await readBody(request);
    if (body === undefined) {
      respond(response, 400, { content: [{ type: 'text', text: 'The browser call was too large or unreadable.' }], isError: true });
      return;
    }
    let parsed: BridgeCall;
    try {
      const value = JSON.parse(body) as { name?: unknown; arguments?: unknown };
      if (typeof value.name !== 'string' || value.name.length === 0) {
        throw new Error('missing name');
      }
      parsed = { name: value.name, arguments: value.arguments };
    } catch {
      respond(response, 400, { content: [{ type: 'text', text: 'The browser call was not valid JSON.' }], isError: true });
      return;
    }
    try {
      const result = await this.handle(parsed);
      respond(response, 200, result);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : 'The browser action failed.';
      respond(response, 200, { content: [{ type: 'text', text: message }], isError: true });
    }
  }
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header || !token) {
    return false;
  }
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const left = Buffer.from(presented);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        resolve(undefined);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => resolve(undefined));
  });
}

function respond(response: ServerResponse, status: number, body: ToolResult): void {
  const json = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(json);
}
