import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest, Agent, type IncomingMessage } from 'node:http';
import { createOpencodePublisher, isTerminalStepReason, opencodeStreamDetail, parseOpencodeEvent, promptTurnFromBody } from './events.ts';
import type { OpencodeEvent } from './events.ts';
import {
  busPayloadToOpencodeLine,
  consumeSse,
  opencodeListenUrl,
  permissionAskFromBus,
  questionIdFromBus,
  type OpencodePermissionAsk,
  type OpencodePermissionReply
} from './approval.ts';
import { questionAskFromBus } from '../../questions.ts';
import type { OpencodeRunOptions, OpencodeRunResult } from './runtime.ts';

/**
 * Drive one turn through `opencode serve` so an `ask` permission can wait for
 * the user. `opencode run` answers those requests itself (reject or auto-approve)
 * and never gives the sidebar a chance to show them.
 *
 * The child is still one short-lived process. Config and the token travel the
 * same way as `opencode run`: config in `OPENCODE_CONFIG_CONTENT`, token only
 * in the child environment. Server stdout is classified, never returned.
 */

const LISTEN_TIMEOUT_MS = 15_000;
const READY_ATTEMPTS = 50;
const READY_INTERVAL_MS = 100;

/**
 * The extension host replaces Node's global agent with one that follows the
 * editor proxy. This server is on loopback, and that proxy refusing it is
 * reported as the server not accepting a connection.
 */
const loopbackAgent = new Agent({ keepAlive: false });

export async function runOpencodeServerTurn(
  options: OpencodeRunOptions & {
    decidePermission: (ask: OpencodePermissionAsk, signal: AbortSignal) => Promise<OpencodePermissionReply>;
  },
  onEvent: (event: OpencodeEvent) => void
): Promise<OpencodeRunResult> {
  const { buildEnv, killProcessTree } = await import('./runtime.ts');
  const env = buildEnv(options);
  let child: ChildProcess;
  try {
    child = spawn(options.executable, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env
    });
  } catch (cause) {
    return { outcome: 'spawn', terminal: false, detail: cause instanceof Error ? cause.message : 'The opencode server could not be started.' };
  }

  const stop = (): void => {
    killProcessTree(child);
  };
  const onAbort = (): void => stop();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (options.signal?.aborted) {
      return { outcome: 'canceled', terminal: false };
    }
    let baseUrl: string;
    try {
      baseUrl = await waitForListen(child, options.signal);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' || /ENOENT/.test(String(error));
      if (missing) {
        return {
          outcome: 'cli-missing',
          terminal: false,
          detail: `The opencode CLI was not found at "${options.executable}".`
        };
      }
      return {
        outcome: 'spawn',
        terminal: false,
        detail: 'The opencode server did not start, so the turn was not sent.'
      };
    }

    const ready = await waitUntilReady(baseUrl, options.cwd, env, options.signal);
    if (ready === 'unauthorized') {
      return { outcome: 'unauthenticated', terminal: false, detail: 'The opencode server rejected the token.' };
    }
    if (ready === 'canceled') {
      return { outcome: 'canceled', terminal: false };
    }
    if (ready !== 'ok') {
      return { outcome: 'spawn', terminal: false, detail: 'The opencode server did not accept a connection.' };
    }

    if (options.sessionId) {
      const existing = await serverFetch(baseUrl, options.cwd, `/session/${encodeURIComponent(options.sessionId)}`, {
        method: 'GET',
        signal: options.signal
      }, env);
      if (existing.status === 404) {
        return { outcome: 'stale-session', terminal: false, sessionId: options.sessionId, detail: 'The saved opencode session is no longer available.' };
      }
    }

    const created = options.sessionId
      ? { ok: true as const, id: options.sessionId }
      : await createSession(baseUrl, options, env);
    if (!created.ok) {
      return {
        outcome: 'provider',
        terminal: false,
        detail: created.detail
      };
    }
    const sessionId = created.id;

    const state = {
      sawError: undefined as { message: string; statusCode?: number } | undefined,
      terminal: false,
      cutoff: undefined as string | undefined
    };
    const publishContent = createOpencodePublisher(onEvent);
    const publish = (event: OpencodeEvent): void => {
      if (event.kind === 'step-finish') {
        if (event.reason === 'length') {
          state.cutoff = 'length';
        }
        if (isTerminalStepReason(event.reason)) {
          state.terminal = true;
        }
      }
      publishContent(event);
    };
    const eventsAbort = new AbortController();
    const stopEvents = (): void => eventsAbort.abort();
    options.signal?.addEventListener('abort', stopEvents, { once: true });
    const events = readEvents(baseUrl, options, env, sessionId, state, publish, eventsAbort.signal);

    const model = splitModel(options.modelRef);
    const prompt = await serverFetch(baseUrl, options.cwd, `/session/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: options.agent,
        model: { providerID: model.providerID, modelID: model.modelID },
        parts: [{ type: 'text', text: options.prompt }]
      }),
      signal: options.signal
    }, env);
    const body = await prompt.text().catch(() => '');
    stopEvents();
    await events.catch(() => undefined);
    const reported = promptTurnFromBody(body);
    for (const event of reported.events) {
      publish(event);
    }

    if (options.signal?.aborted) {
      return { outcome: 'canceled', terminal: state.terminal, sessionId };
    }
    if (prompt.status === 404 && options.sessionId) {
      return { outcome: 'stale-session', terminal: false, sessionId, detail: 'The saved opencode session is no longer available.' };
    }
    if (prompt.status === 401 || prompt.status === 403 || state.sawError?.statusCode === 401 || state.sawError?.statusCode === 403) {
      return { outcome: 'unauthenticated', terminal: false, sessionId, detail: 'The API credential was rejected.' };
    }
    if (!prompt.ok) {
      return {
        outcome: 'provider',
        terminal: false,
        sessionId,
        detail: state.sawError?.message ?? 'The opencode server did not complete the turn.'
      };
    }
    if (reported.finish === 'length' || state.cutoff === 'length') {
      return { outcome: 'stream', terminal: false, sessionId, detail: opencodeStreamDetail('length') };
    }
    if (!state.terminal) {
      publish({ kind: 'step-finish', sessionId, reason: 'stop' });
    }
    return { outcome: 'completed', terminal: true, sessionId };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    stop();
  }
}

async function createSession(
  baseUrl: string,
  options: OpencodeRunOptions,
  env: NodeJS.ProcessEnv
): Promise<{ ok: true; id: string } | { ok: false; detail: string }> {
  let response: Response;
  try {
    response = await serverFetch(baseUrl, options.cwd, '/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        permission: [
          { permission: 'question', action: options.questionPermission ?? 'deny', pattern: '*' },
          { permission: 'plan_enter', action: 'deny', pattern: '*' },
          { permission: 'plan_exit', action: 'deny', pattern: '*' }
        ]
      }),
      signal: options.signal
    }, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return {
      ok: false,
      detail: message ? `The opencode session could not be started. ${message}` : 'The opencode session could not be started.'
    };
  }
  const text = await response.text().catch(() => '');
  const id = response.ok ? sessionIdFromBody(text) : undefined;
  if (id) {
    return { ok: true, id };
  }
  const reason = serverErrorDetail(text);
  const status = response.ok ? '' : ` (HTTP ${response.status})`;
  return {
    ok: false,
    detail: reason
      ? `The opencode session could not be started${status}. ${reason}`
      : `The opencode session could not be started${status}.`
  };
}

/** Session id from a v1 body `{ id }` or a v2 body `{ data: { id } }`. */
function sessionIdFromBody(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { id?: unknown; data?: { id?: unknown } };
    if (typeof parsed.id === 'string') {
      return parsed.id;
    }
    if (typeof parsed.data?.id === 'string') {
      return parsed.data.id;
    }
  } catch {
    // Not JSON.
  }
  return undefined;
}

function serverErrorDetail(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as { message?: unknown; data?: { message?: unknown } };
    const message =
      typeof parsed.message === 'string'
        ? parsed.message
        : typeof parsed.data?.message === 'string'
          ? parsed.data.message
          : undefined;
    if (message?.trim()) {
      return message.trim().replace(/\s+/g, ' ').slice(0, 240);
    }
  } catch {
    // A plain-text body is still worth showing.
  }
  return trimmed.replace(/\s+/g, ' ').slice(0, 240);
}

async function readEvents(
  baseUrl: string,
  options: OpencodeRunOptions & {
    decidePermission: (ask: OpencodePermissionAsk, signal: AbortSignal) => Promise<OpencodePermissionReply>;
  },
  env: NodeJS.ProcessEnv,
  sessionId: string,
  state: { sawError?: { message: string; statusCode?: number }; terminal: boolean },
  onEvent: (event: OpencodeEvent) => void,
  signal: AbortSignal
): Promise<void> {
  const response = await serverFetch(baseUrl, options.cwd, '/event', {
    method: 'GET',
    headers: { accept: 'text/event-stream' },
    signal
  }, env);
  if (!response.ok || !response.body) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const reasoningParts = new Map<string, Record<string, unknown>>();
  // The bus also carries the user's prompt as a text part; the role lets the
  // converter tell that part from the assistant's reply.
  const messageRoles = new Map<string, string>();
  const drain = async (flushTail: boolean): Promise<void> => {
    const consumed = consumeSse(buffer, flushTail);
    buffer = consumed.rest;
    for (const message of consumed.messages) {
      await handleBusMessage(message, baseUrl, options, env, sessionId, state, onEvent, reasoningParts, messageRoles);
    }
  };
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      await drain(false);
    }
  } catch {
    // The prompt ending aborts this stream on purpose.
  } finally {
    buffer += decoder.decode();
    try {
      await drain(true);
    } catch {
      // A late frame must not hide the turn result already in hand.
    }
    try {
      await reader.cancel();
    } catch {
      // Already closed.
    }
  }
}

async function handleBusMessage(
  message: string,
  baseUrl: string,
  options: OpencodeRunOptions & {
    decidePermission: (ask: OpencodePermissionAsk, signal: AbortSignal) => Promise<OpencodePermissionReply>;
  },
  env: NodeJS.ProcessEnv,
  sessionId: string,
  state: { sawError?: { message: string; statusCode?: number }; terminal: boolean },
  onEvent: (event: OpencodeEvent) => void,
  reasoningParts: Map<string, Record<string, unknown>>,
  messageRoles: Map<string, string>
): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(message) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return;
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return;
  }

  const ask = permissionAskFromBus(payload);
  if (ask && (!ask.sessionId || ask.sessionId === sessionId)) {
    const reply = await options.decidePermission(ask, options.signal ?? new AbortController().signal).catch(() => 'reject' as const);
    await serverFetch(baseUrl, options.cwd, `/permission/${encodeURIComponent(ask.id)}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reply,
        message: reply === 'reject' ? 'The user denied this request.' : undefined
      }),
      signal: options.signal
    }, env).catch(() => undefined);
    return;
  }

  const question = questionAskFromBus(payload);
  if (question && (!question.threadId || question.threadId === sessionId)) {
    const answers = options.answerQuestion
      ? await options.answerQuestion(
          { id: question.id, sessionId: question.threadId || undefined, questions: question.questions },
          options.signal ?? new AbortController().signal
        ).catch(() => 'reject' as const)
      : 'reject';
    if (answers === 'reject') {
      await serverFetch(baseUrl, options.cwd, `/question/${encodeURIComponent(question.id)}/reject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: options.signal
      }, env).catch(() => undefined);
    } else {
      await serverFetch(baseUrl, options.cwd, `/question/${encodeURIComponent(question.id)}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answers }),
        signal: options.signal
      }, env).catch(() => undefined);
    }
    return;
  }

  const bareQuestion = questionIdFromBus(payload);
  if (bareQuestion && (!bareQuestion.sessionId || bareQuestion.sessionId === sessionId) && !question) {
    await serverFetch(baseUrl, options.cwd, `/question/${encodeURIComponent(bareQuestion.id)}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: options.signal
    }, env).catch(() => undefined);
    return;
  }

  const line = busPayloadToOpencodeLine(payload, reasoningParts, messageRoles);
  if (!line) {
    return;
  }
  const event = parseOpencodeEvent(line);
  if (event.kind === 'malformed') {
    return;
  }
  if (event.kind !== 'unknown' && event.sessionId && event.sessionId !== sessionId) {
    return;
  }
  if (event.kind === 'error') {
    state.sawError = { message: event.message, statusCode: event.statusCode };
  }
  onEvent(event);
}

function splitModel(modelRef: string): { providerID: string; modelID: string } {
  const slash = modelRef.indexOf('/');
  if (slash < 0) {
    return { providerID: modelRef, modelID: modelRef };
  }
  return { providerID: modelRef.slice(0, slash), modelID: modelRef.slice(slash + 1) };
}

export async function waitForListen(child: ChildProcess, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error('timeout')), LISTEN_TIMEOUT_MS);
    const finish = (error?: Error, url?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeListener('data', onData);
      child.stderr?.removeListener('data', onData);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      signal?.removeEventListener('abort', onAbort);
      if (url) {
        resolve(url);
      } else {
        reject(error ?? new Error('closed'));
      }
    };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const url = opencodeListenUrl(buffer);
      if (!url) {
        return;
      }
      try {
        if (isLoopbackHttp(new URL(url))) {
          finish(undefined, url);
        }
      } catch {
        // The listen line is not complete enough to parse yet.
      }
    };
    const onError = (error: NodeJS.ErrnoException): void => finish(error);
    const onClose = (): void => finish(new Error('closed'));
    const onAbort = (): void => finish(new Error('aborted'));
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', onError);
    child.on('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitUntilReady(
  baseUrl: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<'ok' | 'unauthorized' | 'canceled' | 'failed'> {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) {
      return 'canceled';
    }
    try {
      const health = await serverFetch(baseUrl, cwd, '/global/health', { method: 'GET', signal }, env);
      const healthStatus = classifyReady(health.status);
      await health.body?.cancel().catch(() => undefined);
      if (healthStatus) {
        return healthStatus;
      }
      // Older servers have no health route. A session list is ready once it answers.
      if (health.status === 404) {
        const sessions = await serverFetch(baseUrl, cwd, '/session', { method: 'GET', signal }, env);
        const sessionStatus = classifyReady(sessions.status);
        await sessions.body?.cancel().catch(() => undefined);
        if (sessionStatus) {
          return sessionStatus;
        }
      }
    } catch {
      // The listen line can arrive before the socket accepts connections.
    }
    await delay(READY_INTERVAL_MS, signal);
  }
  return 'failed';
}

function classifyReady(status: number): 'ok' | 'unauthorized' | undefined {
  if (status >= 200 && status < 300) {
    return 'ok';
  }
  if (status === 401 || status === 403) {
    return 'unauthorized';
  }
  return undefined;
}

/**
 * Talk to the spawned server on loopback.
 *
 * The child is already started in the workspace, which is the server's
 * default project. A directory header that does not byte-match that root
 * opens a second project, and the next turn cannot see this session.
 *
 * `fetch` follows the extension host proxy, which does not accept this
 * loopback port. A private agent connects directly. When the child inherited
 * `OPENCODE_SERVER_PASSWORD`, the server requires that same basic credential.
 */
export function serverFetch(
  baseUrl: string,
  _cwd: string,
  path: string,
  init: RequestInit,
  env: NodeJS.ProcessEnv = process.env
): Promise<Response> {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (!isLoopbackHttp(url)) {
    return Promise.reject(new Error('The opencode server URL is not a loopback address.'));
  }
  const headers: Record<string, string> = {};
  const requestHeaders = new Headers(init.headers);
  requestHeaders.forEach((value, key) => {
    headers[key] = value;
  });
  const authorization = basicAuthorization(env);
  if (authorization) {
    headers.authorization = authorization;
  }
  const body = requestBody(init.body);
  const stream = requestHeaders.get('accept') === 'text/event-stream';
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: init.method ?? 'GET',
        headers,
        agent: loopbackAgent,
        signal: init.signal ?? undefined
      },
      (incoming) => {
        const responseHeaders = new Headers();
        const contentType = incoming.headers['content-type'];
        if (typeof contentType === 'string') {
          responseHeaders.set('content-type', contentType);
        }
        const status = incoming.statusCode ?? 500;
        if (stream) {
          resolve(new Response(byteStream(incoming), { status, headers: responseHeaders }));
          return;
        }
        readBody(incoming).then(
          (bytes) => resolve(new Response(status === 204 || status === 205 || status === 304 ? null : bytes, { status, headers: responseHeaders })),
          reject
        );
      }
    );
    req.on('error', reject);
    if (body) {
      req.end(body);
    } else {
      req.end();
    }
  });
}

function isLoopbackHttp(url: URL): boolean {
  if (url.protocol !== 'http:') {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function basicAuthorization(env: NodeJS.ProcessEnv): string | undefined {
  const password = env.OPENCODE_SERVER_PASSWORD;
  if (!password) {
    return undefined;
  }
  const username = env.OPENCODE_SERVER_USERNAME?.trim() || 'opencode';
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function requestBody(body: BodyInit | null | undefined): Buffer | undefined {
  if (body == null) {
    return undefined;
  }
  if (typeof body === 'string') {
    return Buffer.from(body);
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new Error('The opencode request body must be text.');
}

function readBody(incoming: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    incoming.on('error', reject);
  });
}

/** Byte stream for SSE. Chunks are copied so the extension host can read them. */
function byteStream(incoming: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      incoming.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      });
      incoming.on('end', () => controller.close());
      incoming.on('error', (error) => controller.error(error));
    },
    cancel() {
      incoming.destroy();
    }
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
