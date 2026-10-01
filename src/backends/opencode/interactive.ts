import { spawn, type ChildProcess } from 'node:child_process';
import { parseOpencodeEvent } from './events.ts';
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

    const ready = await waitUntilReady(baseUrl, options.cwd, options.signal);
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
      });
      if (existing.status === 404) {
        return { outcome: 'stale-session', terminal: false, sessionId: options.sessionId, detail: 'The saved opencode session is no longer available.' };
      }
    }

    const sessionId = options.sessionId ?? (await createSession(baseUrl, options));
    if (!sessionId) {
      return { outcome: 'provider', terminal: false, detail: 'The opencode session could not be started.' };
    }

    const state = { sawError: undefined as { message: string; statusCode?: number } | undefined, terminal: false };
    const eventsAbort = new AbortController();
    const stopEvents = (): void => eventsAbort.abort();
    options.signal?.addEventListener('abort', stopEvents, { once: true });
    const events = readEvents(baseUrl, options, sessionId, state, onEvent, eventsAbort.signal);

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
    });
    stopEvents();
    await events.catch(() => undefined);

    if (options.signal?.aborted) {
      return { outcome: 'canceled', terminal: state.terminal, sessionId };
    }
    if (prompt.status === 404 && options.sessionId) {
      return { outcome: 'stale-session', terminal: false, sessionId, detail: 'The saved opencode session is no longer available.' };
    }
    if (prompt.status === 401 || prompt.status === 403 || state.sawError?.statusCode === 401 || state.sawError?.statusCode === 403) {
      return { outcome: 'unauthenticated', terminal: false, sessionId, detail: 'The Ollama Cloud token was rejected.' };
    }
    if (!prompt.ok) {
      return {
        outcome: 'provider',
        terminal: false,
        sessionId,
        detail: state.sawError?.message ?? 'The opencode server did not complete the turn.'
      };
    }
    if (!state.terminal) {
      onEvent({ kind: 'step-finish', sessionId, reason: 'stop' });
    }
    return { outcome: 'completed', terminal: true, sessionId };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    stop();
  }
}

async function createSession(baseUrl: string, options: OpencodeRunOptions): Promise<string | undefined> {
  const response = await serverFetch(baseUrl, options.cwd, '/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      permission: [
        { permission: 'question', action: 'deny', pattern: '*' },
        { permission: 'plan_enter', action: 'deny', pattern: '*' },
        { permission: 'plan_exit', action: 'deny', pattern: '*' }
      ]
    }),
    signal: options.signal
  });
  if (!response.ok) {
    return undefined;
  }
  const body = (await response.json().catch(() => undefined)) as { id?: unknown } | undefined;
  return typeof body?.id === 'string' ? body.id : undefined;
}

async function readEvents(
  baseUrl: string,
  options: OpencodeRunOptions & {
    decidePermission: (ask: OpencodePermissionAsk, signal: AbortSignal) => Promise<OpencodePermissionReply>;
  },
  sessionId: string,
  state: { sawError?: { message: string; statusCode?: number }; terminal: boolean },
  onEvent: (event: OpencodeEvent) => void,
  signal: AbortSignal
): Promise<void> {
  const response = await serverFetch(baseUrl, options.cwd, '/event', {
    method: 'GET',
    headers: { accept: 'text/event-stream' },
    signal
  });
  if (!response.ok || !response.body) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const consumed = consumeSse(buffer);
      buffer = consumed.rest;
      for (const message of consumed.messages) {
        await handleBusMessage(message, baseUrl, options, sessionId, state, onEvent);
      }
    }
  } catch {
    // The prompt ending aborts this stream on purpose.
  } finally {
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
  sessionId: string,
  state: { sawError?: { message: string; statusCode?: number }; terminal: boolean },
  onEvent: (event: OpencodeEvent) => void
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
    }).catch(() => undefined);
    return;
  }

  const question = questionIdFromBus(payload);
  if (question && (!question.sessionId || question.sessionId === sessionId)) {
    await serverFetch(baseUrl, options.cwd, `/question/${encodeURIComponent(question.id)}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: options.signal
    }).catch(() => undefined);
    return;
  }

  const line = busPayloadToOpencodeLine(payload);
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
  if (event.kind === 'step-finish' && event.reason === 'stop') {
    state.terminal = true;
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

async function waitForListen(child: ChildProcess, signal?: AbortSignal): Promise<string> {
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
      if (url) {
        finish(undefined, url);
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
  signal?: AbortSignal
): Promise<'ok' | 'unauthorized' | 'canceled' | 'failed'> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (signal?.aborted) {
      return 'canceled';
    }
    try {
      const response = await serverFetch(baseUrl, cwd, '/session', { method: 'GET', signal });
      if (response.ok) {
        return 'ok';
      }
      if (response.status === 401 || response.status === 403) {
        return 'unauthorized';
      }
    } catch {
      // The listen line can arrive before the socket accepts connections.
    }
    await delay(100, signal);
  }
  return 'failed';
}

function serverFetch(baseUrl: string, _cwd: string, path: string, init: RequestInit): Promise<Response> {
  // The child is already started in the workspace, which is the server's
  // default project. A directory query that does not byte-match that root
  // would open a second instance and the permission reply would miss the ask.
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  return fetch(url, init);
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
