/**
 * Pure parser for `opencode run --format json` output.
 *
 * opencode writes one JSON object per line (NDJSON). This module turns a line
 * into a small, provider-neutral shape the adapter can drive its normalized
 * event union with. It is free of `vscode`, child processes and the filesystem
 * so the mapping is unit-testable against real captured output.
 *
 * ## Facts this module is built on (verified against opencode 1.1.65)
 *
 * - Each line is `{ type, timestamp, sessionID, part?, error? }`. The `sessionID`
 *   is how the adapter learns the runtime's own session id to persist and resume.
 * - `type: "text"` carries `part.text`; `type: "reasoning"` carries reasoning
 *   text. In this pinned version a whole text/reasoning part arrives at once
 *   rather than as token deltas, so the adapter forwards each part as it lands.
 * - `type: "tool_use"` carries `part.tool` and a `part.state` with a `status`
 *   (`pending` | `running` | `completed` | `error`). A `write`/`edit`/`patch`
 *   tool's `state.metadata.filepath` is the changed file; a `bash` tool's
 *   `state.input.command` is the command.
 * - `type: "error"` carries `error.data.message`.
 * - A stream that ends without a terminal `step_finish` (reason `stop`) is a
 *   stream error, not a successful turn.
 */

import { targetForTool } from '../toolLabel.ts';

export interface OpencodeStepStartEvent {
  kind: 'step-start';
  sessionId?: string;
}

export interface OpencodeTextEvent {
  kind: 'text';
  sessionId?: string;
  /** Part id, used to correlate deltas of one message part. */
  partId: string;
  text: string;
}

export interface OpencodeReasoningEvent {
  kind: 'reasoning';
  sessionId?: string;
  partId: string;
  text: string;
  /** True while the server is still producing this reasoning part. */
  streaming?: boolean;
}

export interface OpencodeToolEvent {
  kind: 'tool';
  sessionId?: string;
  callId: string;
  tool: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  /** bash: the command line. */
  command?: string;
  /** write/edit/patch: the file the tool touched. */
  filePath?: string;
  /**
   * The path, command, pattern, or query this call actually used.
   * Never a lifecycle word such as "completed".
   */
  target?: string;
  /**
   * write/patch: whether the target file already existed, from the tool's own
   * metadata. `false` means the tool created it, so a late before snapshot
   * cannot prove the create and this hint is used instead. Absent when the
   * runtime did not report it.
   */
  fileExists?: boolean;
  /** Tool output text, when completed. */
  output?: string;
  /** Short title opencode assigned the call. */
  title?: string;
  /** Unified diff of a file edit, when the tool reported one. */
  diff?: string;
  /** Exact text an edit tool replaced, when it reported both sides. */
  replacement?: { before: string; after: string };
  /** Full pre-edit file text, when the tool reported it next to the post-edit text. */
  beforeText?: string;
  /** Full post-edit file text paired with `beforeText`. */
  afterText?: string;
  /** Structured todo list reported by OpenCode's todowrite tool. */
  todos?: Array<{ text: string; status: 'pending' | 'inProgress' | 'completed' }>;
}

export interface OpencodeStepFinishEvent {
  kind: 'step-finish';
  sessionId?: string;
  reason: string;
  /** Tokens occupying the window at the end of this step, when the runtime reported them. */
  usedTokens?: number;
}

export interface OpencodeErrorEvent {
  kind: 'error';
  sessionId?: string;
  message: string;
  statusCode?: number;
}

/** A line that is valid JSON but of a shape this pinned version does not name. */
export interface OpencodeUnknownEvent {
  kind: 'unknown';
  sessionId?: string;
  type?: string;
}

/** A line that is not JSON at all, e.g. a human-readable log line. */
export interface OpencodeMalformedEvent {
  kind: 'malformed';
  raw: string;
}

export type OpencodeEvent =
  | OpencodeStepStartEvent
  | OpencodeTextEvent
  | OpencodeReasoningEvent
  | OpencodeToolEvent
  | OpencodeStepFinishEvent
  | OpencodeErrorEvent
  | OpencodeUnknownEvent
  | OpencodeMalformedEvent;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** Convert cumulative parts into deltas, retaining the final reasoning status. */
export function createOpencodePublisher(onEvent: (event: OpencodeEvent) => void): (event: OpencodeEvent) => void {
  const seen = new Map<string, string>();
  const completed = new Set<string>();
  return (event) => {
    if (event.kind !== 'text' && event.kind !== 'reasoning') {
      onEvent(event);
      return;
    }
    if (completed.has(event.partId)) return;
    const previous = seen.get(event.partId);
    const finishing = event.kind === 'reasoning' && !event.streaming;
    if (previous === undefined || (event.text.startsWith(previous) && event.text.length > previous.length)) {
      seen.set(event.partId, event.text);
      onEvent({ ...event, text: previous === undefined ? event.text : event.text.slice(previous.length) });
    } else if (finishing) {
      onEvent({ ...event, text: '' });
    }
    if (finishing) completed.add(event.partId);
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Tokens in the window at step end. `total` already includes input, output,
 * and cache reads, so those fields are only a fallback when `total` is absent.
 */
function usedTokensOf(part: Record<string, unknown> | undefined): number | undefined {
  const tokens = asRecord(part?.tokens);
  if (!tokens) {
    return undefined;
  }
  if (typeof tokens.total === 'number' && Number.isFinite(tokens.total) && tokens.total > 0) {
    return Math.round(tokens.total);
  }
  const cache = asRecord(tokens.cache);
  const input = typeof tokens.input === 'number' ? tokens.input : 0;
  const output = typeof tokens.output === 'number' ? tokens.output : 0;
  const cacheRead = typeof cache?.read === 'number' ? cache.read : 0;
  const sum = input + output + cacheRead;
  return sum > 0 ? Math.round(sum) : undefined;
}

/** The `part` object of an event, when present. */
function partOf(record: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(record.part);
}

/**
 * Parse one NDJSON line from opencode. Never throws: an unparseable line is a
 * `malformed` event and an unrecognized shape is `unknown`, so a newer opencode
 * release adding an event type cannot break the transcript.
 */
export function parseOpencodeEvent(line: string): OpencodeEvent {
  const trimmed = line.trim();
  if (!trimmed) {
    return { kind: 'malformed', raw: line };
  }
  let record: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    const asObj = asRecord(parsed);
    if (!asObj) {
      return { kind: 'malformed', raw: trimmed };
    }
    record = asObj;
  } catch {
    return { kind: 'malformed', raw: trimmed };
  }

  const type = asString(record.type);
  const sessionId = asString(record.sessionID);
  const part = partOf(record);

  switch (type) {
    case 'step_start':
    case 'step-start':
      return { kind: 'step-start', sessionId };
    case 'text': {
      const text = asString(part?.text);
      const partId = asString(part?.id);
      if (text === undefined || partId === undefined) {
        return { kind: 'unknown', sessionId, type };
      }
      return { kind: 'text', sessionId, partId, text };
    }
    case 'reasoning': {
      const text = asString(part?.text);
      const partId = asString(part?.id);
      if (text === undefined || partId === undefined) {
        return { kind: 'unknown', sessionId, type };
      }
      const time = asRecord(part?.time);
      return { kind: 'reasoning', sessionId, partId, text, ...(time && time.end === undefined ? { streaming: true } : {}) };
    }
    case 'tool_use': {
      const tool = asString(part?.tool);
      const callId = asString(part?.callID);
      const state = asRecord(part?.state);
      const status = asString(state?.status);
      if (tool === undefined || callId === undefined) {
        return { kind: 'unknown', sessionId, type };
      }
      const input = asRecord(state?.input);
      const metadata = asRecord(state?.metadata);
      const normalizedStatus =
        status === 'completed' || status === 'error' || status === 'running' || status === 'pending'
          ? status
          : 'running';
      const command = asString(input?.command);
      const filePath =
        asString(metadata?.filepath) ??
        asString(metadata?.filePath) ??
        asString(input?.filePath) ??
        asString(input?.file_path) ??
        asString(input?.filepath);
      const fileExists = typeof metadata?.exists === 'boolean' ? metadata.exists : undefined;
      const output = asString(state?.output);
      const title = asString(state?.title);
      const todos = tool.toLowerCase() === 'todowrite' ? parseTodos(input?.todos) : undefined;
      const target = targetForTool(tool, input, metadata);
      const edit = isFileTool(tool) ? editFacts(input, metadata, output) : undefined;
      return {
        kind: 'tool',
        sessionId,
        callId,
        tool,
        status: normalizedStatus,
        command,
        filePath,
        target,
        fileExists,
        output,
        title,
        todos,
        ...(edit?.diff ? { diff: edit.diff } : {}),
        ...(edit?.replacement ? { replacement: edit.replacement } : {}),
        ...(edit?.beforeText !== undefined ? { beforeText: edit.beforeText } : {}),
        ...(edit?.afterText !== undefined ? { afterText: edit.afterText } : {})
      };
    }
    case 'step_finish':
    case 'step-finish': {
      const reason = asString(part?.reason) ?? asString(record.reason) ?? 'unknown';
      return { kind: 'step-finish', sessionId, reason, usedTokens: usedTokensOf(part) };
    }
    case 'error': {
      const error = asRecord(record.error);
      const data = asRecord(error?.data);
      const message = asString(data?.message) ?? asString(error?.name) ?? 'opencode reported an error.';
      const statusCode = typeof data?.statusCode === 'number' ? data.statusCode : undefined;
      return { kind: 'error', sessionId, message, statusCode };
    }
    default:
      return { kind: 'unknown', sessionId, type };
  }
}

function parseTodos(value: unknown): Array<{ text: string; status: 'pending' | 'inProgress' | 'completed' }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const todos = value.flatMap((entry) => {
    const todo = asRecord(entry);
    const text = asString(todo?.content)?.trim();
    if (!todo || !text) return [];
    const status = asString(todo.status)?.toLowerCase();
    const normalizedStatus =
      status === 'completed' || status === 'done'
        ? 'completed'
        : status === 'in_progress' || status === 'inprogress'
          ? 'inProgress'
          : 'pending';
    return [{ text, status: normalizedStatus as 'pending' | 'inProgress' | 'completed' }];
  });
  return todos.length > 0 ? todos : undefined;
}

/**
 * The session id on any event that carries one, so the adapter can persist it
 * before the stream ends and even if the stream later fails.
 */
export function sessionIdOf(event: OpencodeEvent): string | undefined {
  switch (event.kind) {
    case 'malformed':
      return undefined;
    default:
      return event.sessionId;
  }
}

/** Whether a tool name changes files, so its card is a file-change card. */
export function isFileTool(tool: string): boolean {
  return tool === 'write' || tool === 'edit' || tool === 'patch';
}

/**
 * The neutral file change a file-tool call names, or `undefined` for a tool that
 * is not a file edit or that reported no path.
 *
 * `write`/`patch` on a path the tool says did not exist is a create; an `edit`
 * or an existing target is a modification. A `bash` command's side effects are
 * deliberately not inferred from its command line: the host watcher catches
 * those as `watched`, which is honest about how they were learned.
 */
export function reportedChangeOfTool(event: OpencodeToolEvent): {
  absPath: string;
  status: 'created' | 'modified';
  diff?: string;
  replacement?: { before: string; after: string };
  beforeText?: string;
  afterText?: string;
} | undefined {
  if (!isFileTool(event.tool) || !event.filePath) {
    return undefined;
  }
  const status = event.tool === 'write' && event.fileExists === false ? 'created' : 'modified';
  return {
    absPath: event.filePath,
    status,
    ...(event.diff ? { diff: event.diff } : {}),
    ...(event.replacement ? { replacement: event.replacement } : {}),
    ...(event.beforeText !== undefined ? { beforeText: event.beforeText } : {}),
    ...(event.afterText !== undefined ? { afterText: event.afterText } : {})
  };
}

/** Pull a unified diff or an old/new pair out of a file-tool payload. */
function editFacts(
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  output: string | undefined
): { diff?: string; replacement?: { before: string; after: string }; beforeText?: string; afterText?: string } {
  const filediff = asRecord(metadata?.filediff);
  const diff =
    unifiedDiff(metadata?.diff) ??
    unifiedDiff(metadata?.patch) ??
    unifiedDiff(metadata?.unifiedDiff) ??
    unifiedDiff(metadata?.unified_diff) ??
    unifiedDiff(input?.diff) ??
    unifiedDiff(input?.patch) ??
    unifiedDiff(filediff?.diff) ??
    unifiedDiff(filediff?.patch) ??
    unifiedDiff(output);
  const oldString = asString(input?.oldString) ?? asString(input?.old_string);
  const newString = asString(input?.newString) ?? asString(input?.new_string);
  const replacement =
    oldString !== undefined && newString !== undefined && oldString !== newString
      ? { before: oldString, after: newString }
      : undefined;
  const beforeText = asString(filediff?.before);
  const afterText = asString(filediff?.after);
  return {
    ...(diff ? { diff } : {}),
    ...(replacement ? { replacement } : {}),
    ...(beforeText !== undefined && afterText !== undefined ? { beforeText, afterText } : {})
  };
}

/** A string that contains a real added or removed diff line, not a status sentence. */
function unifiedDiff(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  for (const raw of value.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('@@') || raw.startsWith('diff ')) {
      continue;
    }
    if (raw.startsWith('+') || raw.startsWith('-')) {
      return value;
    }
  }
  return undefined;
}

/**
 * Whether a stream that ended with this last `step_finish` reason is a clean
 * terminal. `stop` is a completed turn; anything else means the model stopped
 * to run tools or the stream was cut, so the adapter must not report success.
 */
export function isTerminalStepReason(reason: string): boolean {
  return reason === 'stop';
}

/**
 * Plain-language reason a non-terminal stream stopped.
 * `length` is the output budget, not a transport failure.
 */
export function opencodeStreamDetail(reason: string | undefined): string {
  if (reason === 'length') {
    return 'The reply stopped early because it reached the output limit.';
  }
  return 'The opencode stream ended before the turn completed.';
}

/**
 * The assistant turn carried by a completed `POST /session/:id/message` body.
 *
 * The live bus can drop the last frame when the request returns. This body is
 * the copy the server already finished, so text and the finish reason can be
 * recovered from it. Tool parts are left to the live bus: replaying them would
 * open a second card for the same call.
 */
export function promptTurnFromBody(body: string): { finish?: string; events: OpencodeEvent[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { events: [] };
  }
  const events: OpencodeEvent[] = [];
  let finish: string | undefined;
  for (const message of assistantMessages(parsed)) {
    const info = asRecord(message.info) ?? {};
    if (asString(info.role) === 'user') {
      continue;
    }
    const sessionId = asString(info.sessionID) ?? asString(message.sessionID);
    const messageFinish = asString(info.finish);
    if (messageFinish) {
      finish = messageFinish;
    }
    const parts = Array.isArray(message.parts) ? message.parts : [];
    let stepReason: string | undefined;
    for (const part of parts) {
      const record = asRecord(part);
      if (!record) {
        continue;
      }
      const event = eventFromPart(sessionId, record);
      if (!event) {
        continue;
      }
      if (event.kind === 'step-finish') {
        stepReason = event.reason;
      }
      if (event.kind === 'text' || event.kind === 'reasoning' || event.kind === 'step-finish') {
        events.push(event);
      }
    }
    if (!messageFinish && stepReason) {
      finish = stepReason;
    }
  }
  return { ...(finish ? { finish } : {}), events };
}

function assistantMessages(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) {
    return parsed.flatMap((entry) => assistantMessages(entry));
  }
  const record = asRecord(parsed);
  if (!record) {
    return [];
  }
  const data = asRecord(record.data);
  if (data && (data.info || data.parts) && !record.parts) {
    return [data];
  }
  if (record.info || record.parts) {
    return [record];
  }
  return [];
}

function eventFromPart(sessionId: string | undefined, part: Record<string, unknown>): OpencodeEvent | undefined {
  const type = asString(part.type);
  if (!type) {
    return undefined;
  }
  const wire = type === 'tool' ? 'tool_use' : type === 'step-finish' ? 'step_finish' : type === 'step-start' ? 'step_start' : type;
  const event = parseOpencodeEvent(
    JSON.stringify({
      type: wire,
      sessionID: asString(part.sessionID) ?? sessionId,
      part
    })
  );
  if (event.kind === 'unknown' || event.kind === 'malformed') {
    return undefined;
  }
  return event;
}
