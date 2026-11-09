import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { consumeSse } from './approval.ts';
import { createOpencodePublisher, parseOpencodeEvent, type OpencodeEvent } from './events.ts';
import { serverFetch, waitForListen } from './interactive.ts';
import { buildEnv, killProcessTree, type OpencodeRunOptions, type OpencodeRunResult } from './runtime.ts';
import { opencodeV2Prompt } from './attachments.ts';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' ? value as RecordValue : {};

/** Preserve the existing permission boundary: v2 Code Mode has a direct fetch
 * primitive. Expose our MCP tools directly so they remain usable with Code
 * Mode disabled and still reach sideCode's approval and browser channels.
 */
export function v2RuntimeConfig(config: RecordValue): RecordValue {
  const result = { ...config, permission: { ...record(config.permission), execute: 'deny', todowrite: 'allow' } };
  const agent = Object.fromEntries(Object.entries(record(config.agent)).map(([name, value]) => {
    const entry = record(value);
    return [name, { ...entry, tools: { ...record(entry.tools), execute: false },
      permission: { ...record(entry.permission), execute: 'deny', todowrite: 'allow' } }];
  }));
  const servers = Object.fromEntries(Object.entries(record(config.mcp)).map(([name, value]) => {
    const { enabled, timeout, ...entry } = record(value);
    return [name, { ...entry, disabled: enabled === false, codemode: false,
      ...(typeof timeout === 'number' ? { timeout: { catalog: timeout, execution: timeout } } : {}) }];
  }));
  return { ...result, agent, experimental: { ...record(config.experimental), todo: true },
    ...(config.mcp ? { mcp: { servers } } : {}) };
}

/** Native v2 events use `data`, message ordinals, and execution-level completion.
 * Keep this boundary separate from the v1 bus parser. Contract: OpenCode's
 * released /docs/openapi.json (2.2.x). V1 configuration is normalized by v2.
 */
export function createV2EventTranslator(sessionID: string, publish: (event: OpencodeEvent) => void): (value: unknown) => void {
  const texts = new Map<string, string>();
  const tools = new Map<string, { name: string; input: RecordValue }>();
  const emit = createOpencodePublisher(publish);
  return (value) => {
    const event = record(value);
    const data = record(event.data);
    if (data.sessionID !== sessionID) return;
    const type = String(event.type);
    const sessionId = `v2:${sessionID}`;
    if (/^session\.(text|reasoning)\.(delta|ended)$/.test(type)) {
      const kind = type.includes('.reasoning.') ? 'reasoning' : 'text';
      const partId = `${data.assistantMessageID}:${kind}:${data.ordinal}`;
      const text = type.endsWith('.delta')
        ? (texts.get(partId) ?? '') + String(data.delta ?? '') : String(data.text ?? '');
      texts.set(partId, text);
      emit(kind === 'text' ? { kind, sessionId, partId, text }
        : { kind, sessionId, partId, text, streaming: !type.endsWith('.ended') });
    } else if (type === 'session.tool.input.started') {
      tools.set(String(data.id), { name: String(data.name), input: {} });
    } else if (/^session\.tool\.(called|success|failed)$/.test(type)) {
      const id = String(data.id);
      const previous = tools.get(id) ?? { name: typeof data.name === 'string' ? data.name : 'tool', input: {} };
      const nativeInput = type.endsWith('.called') ? record(data.input) : previous.input;
      const input = { ...nativeInput, ...(typeof nativeInput.path === 'string' ? { filePath: nativeInput.path } : {}) };
      tools.set(id, { ...previous, input });
      const content = Array.isArray(data.content) ? data.content : [];
      const output = content.map((item) => String(record(item).text ?? '')).join('\n');
      emit(parseOpencodeEvent(JSON.stringify({ type: 'tool_use', sessionID: sessionId,
        part: { callID: id, tool: previous.name === 'shell' ? 'bash' : previous.name, state: {
          status: type.endsWith('.called') ? 'running' : type.endsWith('.success') ? 'completed' : 'error',
          input, output, metadata: data.metadata, error: record(data.error).message
        } }
      })));
    } else if (type === 'session.step.started') {
      emit({ kind: 'step-start', sessionId });
    } else if (type === 'session.step.ended') {
      emit(parseOpencodeEvent(JSON.stringify({ type: 'step_finish', sessionID: sessionId,
        part: { reason: data.finish, tokens: data.tokens } })));
    } else if (type === 'session.execution.failed' || type === 'session.step.failed') {
      const error = record(data.error);
      emit({ kind: 'error', sessionId, message: String(error.message ?? 'OpenCode 2 could not complete the turn.'),
        ...(typeof error.status === 'number' ? { statusCode: error.status } : {}) });
    }
  };
}

/** Latest successful todo result, newest messages first. Do not replay a
 * resumed session's old messages as progress for the current turn.
 */
export function v2TodoSnapshot(value: unknown, sessionID: string, currentMessages: ReadonlySet<string>): OpencodeEvent | undefined {
  const messages = record(value).data;
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages.map(record)) {
    if (message.type !== 'assistant' || !currentMessages.has(String(message.id)) || !Array.isArray(message.content)) continue;
    for (const content of [...message.content].reverse().map(record)) {
      const state = record(content.state);
      if (content.type !== 'tool' || content.name !== 'todowrite' || state.status !== 'completed') continue;
      const event = parseOpencodeEvent(JSON.stringify({ type: 'tool_use', sessionID: `v2:${sessionID}`,
        part: { callID: content.id, tool: 'todowrite', state } }));
      if (event.kind === 'tool' && event.todos) return event;
    }
  }
  return undefined;
}

/** Own one loopback server and wait for execution completion, not prompt admission. */
export async function runOpencodeV2Turn(options: OpencodeRunOptions, onEvent: (event: OpencodeEvent) => void): Promise<OpencodeRunResult> {
  const controller = new AbortController();
  const eventsController = new AbortController();
  const stopEvents = (): void => eventsController.abort();
  controller.signal.addEventListener('abort', stopEvents, { once: true });
  const abort = (): void => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const env = buildEnv({ ...options, config: v2RuntimeConfig(options.config) });
  // v2 always authenticates as opencode. An isolated password avoids inheriting
  // an ambient server credential or accidentally connecting to another server.
  env.OPENCODE_PASSWORD = randomBytes(24).toString('hex');
  env.OPENCODE_SERVER_PASSWORD = env.OPENCODE_PASSWORD;
  env.OPENCODE_SERVER_USERNAME = 'opencode';
  const child = spawn(options.executable, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false
  });
  const closed = new Promise<void>((resolve) => { child.once('close', () => resolve()); });
  const stopped = (): void => controller.abort();
  child.on('close', stopped);
  let sessionID = options.sessionId?.slice(3);
  let stream: Promise<void> | undefined;
  try {
    const base = await waitForListen(child, controller.signal);
    const request = (path: string, method = 'GET', body?: unknown): Promise<Response> => serverFetch(base, options.cwd, `/api${path}`, {
      method, signal: controller.signal,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }, env);
    const slash = options.modelRef.indexOf('/');
    const model = { providerID: options.modelRef.slice(0, slash), id: options.modelRef.slice(slash + 1) };
    if (sessionID) {
      const existing = await request(`/session/${encodeURIComponent(sessionID)}`);
      if (existing.status === 404) return { outcome: 'stale-session', terminal: false, sessionId: options.sessionId };
      if (!existing.ok) throw new Error('session');
      // Per-turn agents have random names; update even when resuming a session.
      for (const [route, body] of [['agent', { agent: options.agent }], ['model', { model }]] as const) {
        const response = await request(`/session/${encodeURIComponent(sessionID)}/${route}`, 'POST', body);
        if (!response.ok) throw new Error(route);
      }
    } else {
      const response = await request('/session', 'POST', {
        agent: options.agent, model, location: { directory: options.cwd },
        permissions: [
          { action: 'question', resource: '*', effect: options.questionPermission ?? 'deny' },
          { action: 'plan_enter', resource: '*', effect: 'deny' },
          { action: 'plan_exit', resource: '*', effect: 'deny' }
        ]
      });
      if (!response.ok) throw new Error('session');
      const body = record(await response.json());
      const id = record(body.data).id;
      if (typeof id !== 'string') throw new Error('session');
      sessionID = id;
    }
    const id = sessionID;
    const sessionId = `v2:${id}`;
    const path = `/session/${encodeURIComponent(id)}`;
    const state: { outcome: OpencodeRunResult['outcome'] } = { outcome: 'stream' };
    let detail: string | undefined;
    let cutoff = false;
    let rejectedPermission = false;
    const currentMessages = new Set<string>();
    let sawTodo = false;
    let done!: () => void;
    const completed = new Promise<void>((resolve) => { done = resolve; });
    const translate = createV2EventTranslator(id, (event) => {
      if (event.kind === 'step-finish' && event.reason === 'length') cutoff = true;
      if (event.kind === 'error') {
        detail = event.message;
        state.outcome = event.statusCode === 401 || event.statusCode === 403 ? 'unauthenticated' : 'provider';
      }
      onEvent(event);
    });
    const response = await serverFetch(base, options.cwd, '/api/event', {
      signal: eventsController.signal, headers: { accept: 'text/event-stream' }
    }, env);
    if (!response.ok || !response.body) throw new Error('events');
    // The subscription is established before admitting a prompt.
    stream = (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!controller.signal.aborted) {
          const chunk = await reader.read();
          buffer += decoder.decode(chunk.value, { stream: !chunk.done });
          const frames = consumeSse(buffer, chunk.done);
          buffer = frames.rest;
          for (const frame of frames.messages) {
            const event = record(JSON.parse(frame));
            const data = record(event.data);
            if (data.sessionID === id && typeof data.assistantMessageID === 'string') {
              currentMessages.add(data.assistantMessageID);
              if (event.type === 'session.tool.input.started' && data.name === 'todowrite') sawTodo = true;
            }
            if (event.type === 'permission.asked' && data.sessionID === id) {
              const patterns = Array.isArray(data.resources) ? data.resources.map(String) : [];
              const decision = await options.decidePermission?.({
                id: String(data.id), sessionId, permission: data.action === 'shell' ? 'bash' : String(data.action),
                patterns, metadata: { ...record(data.metadata),
                  // A compound shell request must expose every scanned command
                  // to sideCode's destructive-command check and stored rules.
                  ...(data.action === 'shell' ? { command: patterns.join(' && ') } : {}) }
              }, controller.signal) ?? 'reject';
              if (decision === 'reject') rejectedPermission = true;
              const replied = await request(`${path}/permission/${encodeURIComponent(String(data.id))}/reply`, 'POST',
                // Persistent approval rules belong to sideCode, not the CLI.
                { decision: decision === 'always' ? 'once' : decision });
              if (!replied.ok) throw new Error('permission reply');
            } else if (event.type === 'form.created') {
              const form = record(data.form);
              if (form.sessionID !== id) continue;
              const fields = Array.isArray(form.fields) ? form.fields.map(record) : [];
              const supported = fields.every((field) => (field.type === 'string' || field.type === 'multiselect') && !field.hidden &&
                (!Array.isArray(field.when) || field.when.length === 0));
              const answers = supported && options.answerQuestion ? await options.answerQuestion({
                id: String(form.id), sessionId, questions: fields.map((field) => ({
                  id: String(field.key), header: typeof field.title === 'string' ? field.title : undefined,
                  prompt: String(field.description ?? field.title ?? form.title),
                  options: Array.isArray(field.options) ? field.options.map((option) => String(record(option).label)) : []
                }))
              }, controller.signal) : 'reject';
              const formPath = `${path}/form/${encodeURIComponent(String(form.id))}`;
              if (answers === 'reject') {
                if (!(await request(formPath, 'DELETE')).ok) throw new Error('form cancel');
              } else {
                const answer = Object.fromEntries(fields.map((field, index) => {
                  const text = answers[index]?.[0] ?? '';
                  const option = Array.isArray(field.options) ? field.options.map(record).find((item) => item.label === text) : undefined;
                  const values = (answers[index] ?? []).map((answer) => {
                    const match = Array.isArray(field.options) ? field.options.map(record).find((item) => item.label === answer) : undefined;
                    return match?.value ?? answer;
                  });
                  return [String(field.key), field.type === 'multiselect' ? values : option?.value ?? text];
                }));
                if (!(await request(`${formPath}/reply`, 'POST', { answer })).ok) throw new Error('form reply');
              }
            }
            translate(event);
            if (data.sessionID !== id) continue;
            if (event.type === 'session.execution.succeeded') {
              state.outcome = cutoff ? 'stream' : detail ? state.outcome : 'completed';
              done();
            } else if (event.type === 'session.execution.failed' || event.type === 'session.execution.interrupted') {
              state.outcome = rejectedPermission ? 'permission' : 'provider';
              done();
            }
          }
          if (chunk.done) break;
        }
      } catch {
        if (!controller.signal.aborted && !eventsController.signal.aborted) detail = 'The OpenCode 2 event stream was interrupted.';
      } finally {
        done();
        await reader.cancel().catch(() => undefined);
      }
    })();
    const prompt = await request(`${path}/prompt`, 'POST', opencodeV2Prompt(options.prompt, options.attachmentFiles));
    if (!prompt.ok) {
      return { outcome: prompt.status === 401 || prompt.status === 403 ? 'unauthenticated' : 'provider', terminal: false, sessionId,
        detail: 'OpenCode 2 did not accept the turn.' };
    }
    const interrupted = (): void => done();
    controller.signal.addEventListener('abort', interrupted, { once: true });
    if (controller.signal.aborted) done();
    await completed;
    controller.signal.removeEventListener('abort', interrupted);
    eventsController.abort();
    await stream;
    if (options.signal?.aborted) return { outcome: 'canceled', terminal: false, sessionId };
    if (state.outcome === 'completed' && sawTodo) {
      // Reconcile persisted results before turn/completed reaches the host:
      // the last volatile SSE tool update may not have arrived yet.
      try {
        const latest = await request(`${path}/message?type=assistant&order=desc&limit=20`);
        if (latest.ok) {
          const todo = v2TodoSnapshot(await latest.json(), id, currentMessages);
          if (todo) onEvent(todo);
        }
      } catch {
        // Retain confirmed streamed statuses; never infer completion from prose.
      }
    }
    if (options.signal?.aborted) return { outcome: 'canceled', terminal: false, sessionId };
    return { outcome: state.outcome, terminal: state.outcome === 'completed', sessionId, detail: cutoff ? 'OpenCode reached the output limit.' : detail };
  } catch {
    return { outcome: options.signal?.aborted ? 'canceled' : 'spawn', terminal: false,
      detail: options.signal?.aborted ? undefined : 'OpenCode 2 could not start or connect to its local server.' };
  } finally {
    controller.abort();
    controller.signal.removeEventListener('abort', stopEvents);
    await stream?.catch(() => undefined);
    child.removeListener('close', stopped);
    killProcessTree(child);
    await Promise.race([closed, new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      closed.then(() => { clearTimeout(timer); resolve(); });
    })]);
    options.signal?.removeEventListener('abort', abort);
  }
}
