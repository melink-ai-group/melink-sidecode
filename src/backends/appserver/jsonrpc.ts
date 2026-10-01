/**
 * Newline-delimited JSON-RPC 2.0 framing for the Codex app-server transport.
 *
 * The app-server omits the `"jsonrpc":"2.0"` field on the wire, so this module
 * never writes it and never requires it when reading. Messages are one JSON
 * object per line. A single malformed line is treated as an unknown message
 * rather than a transport failure: the peer may be a newer Codex release and a
 * line we cannot classify must not take the connection down.
 *
 * Kept free of `vscode` and `node:child_process` so it is unit-testable and so
 * protocol drift is caught by a type error, not at runtime.
 */

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccess {
  kind: 'response';
  id: number;
  result: unknown;
}

export interface JsonRpcFailure {
  kind: 'response';
  id: number;
  error: JsonRpcErrorShape;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export interface JsonRpcNotification {
  kind: 'notification';
  method: string;
  params?: unknown;
}

export interface JsonRpcIncomingRequest {
  kind: 'request';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcUnknown {
  kind: 'unknown';
  raw: string;
}

export type JsonRpcMessage =
  | JsonRpcResponse
  | JsonRpcNotification
  | JsonRpcIncomingRequest
  | JsonRpcUnknown;

/** A server-side failure with its JSON-RPC numeric code preserved. */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: JsonRpcErrorShape) {
    super(error.message || `JSON-RPC error ${error.code}`);
    this.name = 'JsonRpcError';
    this.code = error.code;
    this.data = error.data;
  }
}

/** The app-server's overload / retry signal, documented for ingress rejection. */
export const SERVER_OVERLOADED_CODE = -32001;

/**
 * True when a failure is the overload rejection clients are expected to retry
 * with exponential backoff and jitter.
 */
export function isServerOverloaded(error: unknown): boolean {
  return error instanceof JsonRpcError && error.code === SERVER_OVERLOADED_CODE;
}

function serialize(message: Record<string, unknown>): string {
  return `${JSON.stringify(message)}\n`;
}

export function encodeRequest(id: number, method: string, params?: unknown): string {
  return serialize(params === undefined ? { id, method } : { id, method, params });
}

export function encodeNotification(method: string, params?: unknown): string {
  return serialize(params === undefined ? { method } : { method, params });
}

export function encodeSuccess(id: number, result: unknown): string {
  return serialize({ id, result });
}

export function encodeError(id: number, error: JsonRpcErrorShape): string {
  return serialize({ id, error });
}

/** A message is a response when it carries an id plus a result or an error. */
function isResponse(value: Record<string, unknown>): boolean {
  return 'id' in value && ('result' in value || 'error' in value);
}

/**
 * Classify one line. Response vs. server-initiated request is decided by the
 * presence of `result`/`error`; a bare `method` with an `id` is a request the
 * peer expects an answer to.
 */
export function parseMessage(line: string): JsonRpcMessage {
  const raw = line.trim();
  if (!raw) {
    return { kind: 'unknown', raw: line };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'unknown', raw };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'unknown', raw };
  }
  const value = parsed as Record<string, unknown>;

  if (typeof value.id === 'number' && typeof value.method === 'string') {
    return { kind: 'request', id: value.id, method: value.method, params: value.params };
  }
  if (typeof value.id === 'number' && isResponse(value)) {
    const error = value.error;
    if (typeof error === 'object' && error !== null) {
      const shape = error as JsonRpcErrorShape;
      return {
        kind: 'response',
        id: value.id,
        error: { code: shape.code, message: shape.message, data: shape.data }
      };
    }
    return { kind: 'response', id: value.id, result: value.result };
  }
  if (typeof value.method === 'string') {
    return { kind: 'notification', method: value.method, params: value.params };
  }
  return { kind: 'unknown', raw };
}

/**
 * Split a growing stdout buffer into complete lines, returning the lines and
 * the unconsumed remainder. A partial trailing JSON object stays buffered.
 */
export function drainLines(buffer: string): { lines: string[]; remainder: string } {
  const lines: string[] = [];
  let rest = buffer;
  let index = rest.indexOf('\n');
  while (index >= 0) {
    const line = rest.slice(0, index);
    rest = rest.slice(index + 1);
    if (line.trim()) {
      lines.push(line);
    }
    index = rest.indexOf('\n');
  }
  return { lines, remainder: rest };
}
