import type { ApprovalDecision, ApprovalRequest } from '../types.ts';

/**
 * A `permission.asked` event from opencode's server bus, reduced to the fields
 * the sidebar needs in order to show a prompt and answer it.
 */
export interface OpencodePermissionAsk {
  id: string;
  sessionId?: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
}

export type OpencodePermissionReply = 'once' | 'always' | 'reject';

const FILE_PERMISSIONS = new Set(['edit', 'write', 'patch', 'external_directory']);

/**
 * The native reply for a sidebar decision.
 *
 * `allow-session` and `allow-always` both use opencode's `always`, which is
 * the session-scoped accept the server actually offers. Persistence past that
 * session is our stored rule, not a second native grant.
 */
export function opencodeReplyFor(decision: ApprovalDecision): OpencodePermissionReply {
  switch (decision) {
    case 'allow-once':
      return 'once';
    case 'allow-session':
    case 'allow-always':
      return 'always';
    case 'reject':
    default:
      return 'reject';
  }
}

/** Pull a permission request out of a server-bus payload. */
export function permissionAskFromBus(payload: Record<string, unknown>): OpencodePermissionAsk | undefined {
  if (payload.type !== 'permission.asked') {
    return undefined;
  }
  const properties = asRecord(payload.properties) ?? payload;
  const id = asString(properties.id);
  const permission = asString(properties.permission);
  if (!id || !permission) {
    return undefined;
  }
  const patterns = Array.isArray(properties.patterns)
    ? properties.patterns.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return {
    id,
    sessionId: asString(properties.sessionID),
    permission,
    patterns,
    metadata: asRecord(properties.metadata) ?? {}
  };
}

/** The question id on a `question.asked` event, when the payload is one. */
export function questionIdFromBus(payload: Record<string, unknown>): { id: string; sessionId?: string } | undefined {
  if (payload.type !== 'question.asked') {
    return undefined;
  }
  const properties = asRecord(payload.properties) ?? payload;
  const id = asString(properties.id);
  if (!id) {
    return undefined;
  }
  return { id, sessionId: asString(properties.sessionID) };
}

/**
 * The provider-neutral approval card for one opencode permission.
 * Commands, file writes, and everything else each keep their own kind so a
 * stored rule can only match the same kind later.
 */
export function approvalFromOpencode(ask: OpencodePermissionAsk, origin: string): ApprovalRequest {
  const command = commandOf(ask);
  const paths = pathsOf(ask);
  const kind = ask.permission === 'bash' || command ? 'command' : FILE_PERMISSIONS.has(ask.permission) || paths.length > 0 ? 'file-change' : 'permissions';
  const request: ApprovalRequest = {
    id: ask.id,
    kind,
    method: 'opencode/permission',
    reason: [ask.permission, ...ask.patterns].filter((part) => part.length > 0).join(' '),
    origin
  };
  if (kind === 'command') {
    request.command = command ?? ask.patterns.filter((pattern) => pattern !== '*').join(', ');
    // No native exec-policy amendment is proposed here: opencode offers none,
    // and a synthetic first-token prefix would be broader than the command the
    // user was shown. `ruleFor` derives the command family instead.
  } else if (kind === 'file-change') {
    request.paths = paths;
  } else {
    const network = asString(ask.metadata.host) ?? asString(ask.metadata.url) ?? ask.patterns.find((pattern) => pattern !== '*');
    if (network) {
      request.network = network;
    }
  }
  return request;
}

/**
 * Turn one server-bus payload into the NDJSON line `parseOpencodeEvent` already
 * understands. Text waits for a finished part; reasoning snapshots are forwarded
 * live and the publisher removes repeated prefixes before appending them.
 */
export function busPayloadToOpencodeLine(
  payload: Record<string, unknown>,
  reasoningParts = new Map<string, Record<string, unknown>>()
): string | undefined {
  const type = asString(payload.type);
  const properties = asRecord(payload.properties) ?? {};
  if (type === 'message.part.delta' && properties.field === 'text') {
    const partId = asString(properties.partID);
    const previous = partId ? reasoningParts.get(partId) : undefined;
    const delta = asString(properties.delta);
    if (!previous || !partStillStreaming(previous) || delta === undefined || properties.sessionID !== previous.sessionID) return undefined;
    const part: Record<string, unknown> = { ...previous, text: `${asString(previous.text) ?? ''}${delta}` };
    reasoningParts.set(partId!, part);
    return JSON.stringify({ type: 'reasoning', sessionID: part.sessionID, part });
  }
  if (type === 'message.part.updated') {
    const part = asRecord(properties.part);
    const partType = asString(part?.type);
    if (!part || !partType) {
      return undefined;
    }
    const sessionID = asString(part.sessionID);
    if (partType === 'tool') {
      return JSON.stringify({ type: 'tool_use', sessionID, part });
    }
    if (partType === 'text' && partStillStreaming(part)) {
      return undefined;
    }
    if (partType === 'text') {
      return JSON.stringify({ type: 'text', sessionID, part });
    }
    if (partType === 'reasoning') {
      const id = asString(part.id);
      if (id) reasoningParts.set(id, part);
      return JSON.stringify({ type: 'reasoning', sessionID, part });
    }
    if (partType === 'step-start') {
      return JSON.stringify({ type: 'step_start', sessionID, part });
    }
    if (partType === 'step-finish') {
      return JSON.stringify({ type: 'step_finish', sessionID, part });
    }
    return undefined;
  }
  if (type === 'session.error') {
    return JSON.stringify({
      type: 'error',
      sessionID: asString(properties.sessionID),
      error: properties.error
    });
  }
  return undefined;
}

/**
 * Split an SSE buffer into complete `data:` payloads, keeping a partial tail.
 *
 * `flushTail` also accepts one trailing frame that never received its blank
 * line. A closed stream often ends that way, and dropping it drops the last
 * text part.
 */
export function consumeSse(buffer: string, flushTail = false): { messages: string[]; rest: string } {
  const messages: string[] = [];
  let rest = buffer.replace(/\r\n/g, '\n');
  let split = rest.indexOf('\n\n');
  while (split >= 0) {
    const block = rest.slice(0, split);
    rest = rest.slice(split + 2);
    const data = sseData(block);
    if (data) {
      messages.push(data);
    }
    split = rest.indexOf('\n\n');
  }
  if (flushTail) {
    const data = sseData(rest);
    if (data && isJsonPayload(data)) {
      messages.push(data);
      rest = '';
    }
  }
  return { messages, rest };
}

function sseData(block: string): string | undefined {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data || data === '[DONE]') {
    return undefined;
  }
  return data;
}

function isJsonPayload(data: string): boolean {
  try {
    JSON.parse(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * The URL from `opencode server listening on http://...`.
 *
 * Startup text can mention another URL first (a provider base, a docs link).
 * Only the listen line is the server we spawned.
 */
export function opencodeListenUrl(text: string): string | undefined {
  const match = text.match(/opencode server listening on\s+(https?:\/\/\S+)/i);
  if (!match) {
    return undefined;
  }
  return match[1].replace(/\u001b\[[0-9;]*m/g, '').replace(/[),.;]+$/, '');
}

function partStillStreaming(part: Record<string, unknown>): boolean {
  const time = asRecord(part.time);
  return Boolean(time) && time?.end === undefined;
}

function commandOf(ask: OpencodePermissionAsk): string | undefined {
  const fromMetadata = asString(ask.metadata.command) ?? asString(ask.metadata.cmd);
  if (fromMetadata) {
    return fromMetadata;
  }
  if (ask.permission !== 'bash') {
    return undefined;
  }
  const pattern = ask.patterns.find((entry) => entry !== '*');
  return pattern ? stripGlob(pattern) : undefined;
}

function pathsOf(ask: OpencodePermissionAsk): string[] {
  const file =
    asString(ask.metadata.filepath) ?? asString(ask.metadata.filePath) ?? asString(ask.metadata.path);
  if (file) {
    return [file];
  }
  if (!FILE_PERMISSIONS.has(ask.permission)) {
    return [];
  }
  return ask.patterns.map(stripGlob).filter((entry) => entry.length > 0);
}

function stripGlob(value: string): string {
  return value.replace(/\*+$/g, '').replace(/[\\/]+$/g, '');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
