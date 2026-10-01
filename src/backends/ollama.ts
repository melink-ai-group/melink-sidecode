import * as vscode from 'vscode';
import { createId, Emitter } from './base';
import { OLLAMA_TOKEN_SECRET_KEY } from './secrets';
import { ThreadStore } from './threadStore';
import {
  AgentBackend,
  AgentEvent,
  ApprovalDecision,
  ApprovalRule,
  BackendError,
  BackendModel,
  CompactRequest,
  CompactResult,
  ConnectionTestResult,
  ContextPayload,
  DefaultMode,
  Disposable,
  ErrorEventCode,
  ModelCapabilities,
  PermissionLevel,
  ResumeResult,
  SendTurnRequest,
  StartThreadOptions,
  ThreadHandle,
  ThreadSummary
} from './types';
import { ollamaCapabilities, ollamaNativeRequest } from './capabilities';
import { buildContextMessages } from './contextMessages';
import { effectivePermissionLevel, isDefaultMode, modeInstructions } from './modes';
// Type-only imports are erased at compile time, so the off path loads neither
// the runtime module nor any child-process code; the runtime is dynamically
// imported inside the enabled branch only. `isFileTool` is a pure predicate
// with no child-process dependency, so it is safe to import directly.
import { isFileTool, reportedChangeOfTool } from './opencode/events';
import { ollamaContextUsed } from './contextUsage';
import {
  COMPACTION_INSTRUCTIONS,
  compactedTranscript,
  compactedSummary,
  compactionPreface,
  compactionSource,
  fitCompactionSource
} from './compaction';
import { cleanToolTarget, friendlyToolTitle, isStatusText } from './toolLabel.ts';
import type { OpencodeEvent } from './opencode/events';
import type { OpencodeOutcome } from './opencode/runtime';
import { isAbsolute, resolve } from 'node:path';

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string; details?: { parameter_size?: string } }>;
}

interface OllamaChatChunk {
  message?: { role?: string; content?: string; thinking?: string };
  done?: boolean;
  error?: string;
  /** Prompt tokens evaluated for this request. Present on the final chunk, and sometimes earlier. */
  prompt_eval_count?: number;
  /** Tokens generated so far. Grows as the stream runs when the server reports it. */
  eval_count?: number;
}

/** A provider failure already translated into the UI's error taxonomy. */
interface CategorizedError {
  code: ErrorEventCode;
  message: string;
}

/** Thrown by the streaming loop; carries provider-neutral wording, never a raw stack. */
class StreamError extends Error implements CategorizedError {
  constructor(readonly code: ErrorEventCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'StreamError';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** A base URL must be a full http(s) address, or the request never leaves. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError';
}

/**
 * Compose the text handed to `opencode run`.
 *
 * opencode 1.1.65 exposes **no** native system/instructions field on the `run`
 * command, so project context is delivered by priming the turn text instead.
 * This is a deliberate fallback, not an oversight: the child is still spawned
 * with the workspace root as its cwd (so opencode's own `AGENTS.md` discovery
 * and file access work from the right place).
 *
 * `freshSession` is true for the session opener (and for a stale-session retry),
 * which gets the full snapshot; later turns in a live session carry just the
 * compact delta, keeping the stable prefix cacheable and per-turn cost flat. The
 * context exists only in this prompt and is never written to any transcript.
 */
function opencodePrompt(request: SendTurnRequest, freshSession: boolean, summary?: string): string {
  const context = request.context;
  const block = freshSession
    ? context?.snapshot ?? context?.notice
    : context?.delta ?? context?.notice;
  const mode = isDefaultMode(request.mode) ? request.mode : 'agent';
  const instructions = modeInstructions(mode);
  // A fresh session has no memory of the thread. The compaction summary is
  // included once here; later turns resume the session and do not repeat it.
  const preface = freshSession && summary ? compactionPreface(summary) : undefined;
  const parts = [instructions, preface, block, context?.attachedFile, request.text].filter(
    (part): part is string => Boolean(part && part.trim().length > 0)
  );
  return parts.join('\n\n');
}

/**
 * Whether a transport failure names the host (DNS failure, connection refused)
 * rather than the network (offline, timed out).
 *
 * Node's undici wraps the real failure in `error.cause`, so the code lives at
 * `error.cause.code`. A bare `'fetch failed'` message is deliberately NOT
 * treated as host: it is what undici reports for every transport failure, so
 * matching it would mislabel a no-network failure as a bad host. Only the
 * explicit host codes — plus a getaddrinfo message from a pre-undici stack —
 * count as host; everything else is a network problem.
 */
function isDnsOrRefused(error: unknown): boolean {
  const code = causeCode(error);
  if (code) {
    // Only a name-resolution or connection-refused failure indicts the host.
    // A timeout, an unreachable network, a reset, or an offline stack is a
    // network problem, so those codes fall through to `false`.
    return code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN';
  }
  // A pre-undici stack may only expose the message; match the DNS wording, not
  // the generic `fetch failed` that undici uses for every transport failure.
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('getaddrinfo') || message.includes('enotfound');
}

/** The `code` on a transport error's cause chain, when one is present. */
function causeCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) {
    return undefined;
  }
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code.toUpperCase() : undefined;
}

/**
 * Ollama Cloud adapter. Talks to the hosted native HTTP API with a bearer token
 * held in VS Code's secret storage; no local daemon and no Ollama SDK types
 * cross this boundary.
 *
 * Model identifiers are passed through exactly as `/api/tags` returns them —
 * the adapter never rewrites a name (in particular it never adds or strips the
 * `:cloud` suffix the app/CLI uses).
 */
export class OllamaBackend implements AgentBackend {
  readonly id = 'ollama';
  readonly label = 'Ollama Cloud';
  readonly badge = 'Ollama';

  /**
   * Ollama Cloud has no approval channel of its own: `/api/chat` cannot ask the
   * user for a decision and has no sandbox to configure. It therefore reports
   * exactly one level and never emits an approval request, rather than faking a
   * prompt it cannot answer.
   *
   * With the optional opencode runtime enabled, the runtime's own permission
   * config is the second gate the ticket asks for, but a headless `opencode run`
   * auto-rejects an `ask` rather than prompting, so there is still no interactive
   * approval channel to surface. `hasApprovalChannel` stays false and a level is
   * mapped to allow/deny; the runtime's enforcement never opens a prompt the user
   * cannot answer.
   */
  readonly hasApprovalChannel = false;

  /**
   * Permission levels this path can serve. The direct `/api/chat` adapter serves
   * a single level; the opencode runtime can enforce all three, so they are
   * reported only while it is enabled.
   */
  get permissionLevels(): readonly PermissionLevel[] {
    return this.opencodeEnabled ? ['read-only', 'default', 'unrestricted'] : ['default'];
  }

  /**
   * Modes this path can honour. Agent, Plan, and Ask are advertised on every
   * path. The direct `/api/chat` adapter applies them as per-turn instructions
   * and cannot edit files. With the opencode runtime enabled, Plan honors the
   * selected permission level and Ask maps to a read-only agent.
   */
  get modes(): readonly DefaultMode[] {
    return ['agent', 'plan', 'ask'];
  }

  /** No approval channel, so there are never stored rules to list. */
  async listApprovalRules(): Promise<ApprovalRule[]> {
    return [];
  }

  /** No approval channel, so there is nothing to revoke. */
  async revokeApprovalRule(_ruleId: string): Promise<void> {}

  /**
   * No approval channel: a decision can never arrive for a request this backend
   * never raises. Ignoring the call is honest, not a silent success.
   */
  decideApproval(_threadId: string, _requestId: string, _decision: ApprovalDecision): void {}

  private readonly events = new Emitter<AgentEvent>();
  private readonly threads = new Set<string>();
  private inFlight?: AbortController;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store?: ThreadStore
  ) {}

  private get baseUrl(): string {
    return normalizeBaseUrl(vscode.workspace.getConfiguration('melink.ollama').get<string>('baseUrl', 'https://ollama.com'));
  }

  /** Whether the opencode agentic runtime is enabled. Default `true`. */
  private get opencodeEnabled(): boolean {
    return vscode.workspace.getConfiguration('melink.ollama.opencode').get<boolean>('enabled', true) !== false;
  }

  /** Executable path for the runtime; a bare name is resolved from `PATH`. */
  private get opencodePath(): string {
    return vscode.workspace.getConfiguration('melink.ollama.opencode').get<string>('path', 'opencode') || 'opencode';
  }

  /** Working directory the runtime runs in, mirroring the Codex adapter. */
  private get cwd(): string {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : process.cwd();
  }

  private get defaultModel(): string {
    return vscode.workspace.getConfiguration('melink.ollama').get<string>('defaultModel', '');
  }

  private async token(): Promise<string | undefined> {
    return this.context.secrets.get(OLLAMA_TOKEN_SECRET_KEY);
  }

  async isAuthenticated(): Promise<boolean> {
    const token = await this.token();
    if (!token) {
      return false;
    }
    try {
      await this.request('/api/tags', token);
      return true;
    } catch (error) {
      if (error instanceof BackendError && error.code === 'unauthenticated') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Real authenticated call for the settings screen's Test connection action.
   * Never throws: a rejected key, an unreachable host, and a network failure
   * each become a distinct plain-language outcome, and the token never appears.
   */
  async testConnection(): Promise<ConnectionTestResult> {
    if (!isHttpUrl(this.baseUrl)) {
      return {
        backendId: this.id,
        outcome: 'host',
        message: 'The base URL is not a full http or https address. Fix it, then test again.'
      };
    }
    const token = await this.token();
    if (!token) {
      return {
        backendId: this.id,
        outcome: 'invalid-key',
        message: 'No key is stored. Add a key, then test again.'
      };
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/tags`, {
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch (error) {
      // A transport failure is the only place the network and the host differ.
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (offline) {
        return {
          backendId: this.id,
          outcome: 'network',
          message: 'This device appears to be offline. Reconnect, then test again.'
        };
      }
      if (isDnsOrRefused(error)) {
        return {
          backendId: this.id,
          outcome: 'host',
          message: `Could not reach ${this.baseUrl}. Check the base URL, then test again.`
        };
      }
      return {
        backendId: this.id,
        outcome: 'network',
        message: 'The request did not complete. Check your network connection, then test again.'
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        backendId: this.id,
        outcome: 'invalid-key',
        message: 'The host answered but rejected this key. Check the key, or confirm the base URL points at the host that issued it.'
      };
    }
    if (!response.ok) {
      return {
        backendId: this.id,
        outcome: 'provider',
        message: `The host answered with ${response.status}. The key was accepted, so this is a host-side problem.`
      };
    }
    return {
      backendId: this.id,
      outcome: 'ok',
      message: `Connected to ${this.baseUrl}. The key was accepted.`
    };
  }

  /** Reject a credential without ever echoing it back to the caller. */
  private async request(path: string, token: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(init?.headers ?? {})
        }
      });
    } catch (cause) {
      if (isAbortError(cause)) {
        throw new StreamError('canceled', 'Turn canceled.', cause);
      }
      throw new BackendError('unavailable', `Cannot reach Ollama Cloud at ${this.baseUrl}. Check the network or the base URL setting.`, cause);
    }
    if (response.status === 401 || response.status === 403) {
      throw new BackendError('unauthenticated', 'Your Ollama Cloud token was rejected. It may be expired or revoked.');
    }
    if (!response.ok) {
      throw new BackendError('provider', `Ollama Cloud returned ${response.status} ${response.statusText}.`);
    }
    return response;
  }

  async listModels(): Promise<BackendModel[]> {
    const token = await this.token();
    if (!token) {
      throw new BackendError('unauthenticated', 'Set an Ollama Cloud token to list models.');
    }
    const response = await this.request('/api/tags', token);
    const body = (await response.json()) as OllamaTagsResponse;
    // No hardcoded array and no fallback list: the picker is exactly what the
    // live server reports, so removing a model server-side removes it here.
    const names = this.tagNamesFromBody(body);
    // Each model's descriptor is read from `/api/show`, in parallel. A model
    // whose `/api/show` fails still appears, with an all-unknown descriptor, so
    // a single metadata failure cannot hide a usable model.
    return Promise.all(
      names.map(async (name) => {
        const capabilities = await this.modelCapabilities(name);
        return {
          id: name,
          label: name,
          description: (body.models ?? []).find((m) => (m.name ?? m.model) === name)?.details?.parameter_size,
          capabilities
        };
      })
    );
  }

  /** The live model ids from `/api/tags`, with no per-model metadata read. */
  private async tagNames(): Promise<string[]> {
    const token = await this.token();
    if (!token) {
      throw new BackendError('unauthenticated', 'Set an Ollama Cloud token to list models.');
    }
    const response = await this.request('/api/tags', token);
    return this.tagNamesFromBody((await response.json()) as OllamaTagsResponse);
  }

  private tagNamesFromBody(body: OllamaTagsResponse): string[] {
    return (body.models ?? [])
      .map((model) => model.name ?? model.model)
      .filter((name): name is string => Boolean(name));
  }

  /**
   * The capability descriptor for one Ollama model, read live from `/api/show`.
   *
   * `/api/show` reports the architecture's context length (`model_info`) and the
   * model's `capabilities` list, which drive context, thinking and tool support.
   * A model the server no longer knows, or whose show call fails, yields
   * `undefined` so the caller degrades to all-unknown rather than guessing.
   */
  async modelCapabilities(modelId: string): Promise<ModelCapabilities | undefined> {
    const token = await this.token();
    if (!token) {
      return undefined;
    }
    let show: unknown;
    try {
      const response = await this.request('/api/show', token, {
        method: 'POST',
        body: JSON.stringify({ model: modelId })
      });
      show = await response.json();
    } catch {
      // A metadata failure is not a list failure: the model is simply unknown.
      return undefined;
    }
    return ollamaCapabilities(show, this.modes);
  }

  async startThread(options?: StartThreadOptions): Promise<ThreadHandle> {
    const threadId = createId('ollama_thread');
    this.threads.add(threadId);
    const model = options?.model ?? this.defaultModel;
    const handle: ThreadHandle = { backendId: this.id, threadId, model: model || undefined };
    this.events.fire({ type: 'thread/started', backendId: this.id, threadId, model: model || undefined });
    return handle;
  }

  /**
   * Reconnects to a locally recorded Ollama thread. `/api/chat` is stateless,
   * so replaying the stored message list against the same interface *is* the
   * resume: the next turn is sent with the prior turns as context.
   */
  async resumeThread(threadId: string): Promise<ResumeResult> {
    const ref = this.store?.listThreads(this.id).find((entry) => entry.threadId === threadId);
    if (!this.threads.has(threadId) && !ref) {
      throw new BackendError('provider', `Ollama thread ${threadId} is no longer available.`);
    }
    this.threads.add(threadId);
    const model = ref?.modelId;
    this.events.fire({ type: 'thread/started', backendId: this.id, threadId, model });
    return {
      handle: { backendId: this.id, threadId, model },
      model,
      items: this.store?.getTranscript(this.id, threadId) ?? []
    };
  }

  /** Threads this workspace has seen, from the persisted index and live cache. */
  async listThreads(): Promise<ThreadSummary[]> {
    const summaries = new Map<string, ThreadSummary>();
    for (const ref of this.store?.listThreads(this.id) ?? []) {
      summaries.set(ref.threadId, {
        threadId: ref.threadId,
        title: ref.title,
        model: ref.modelId,
        updatedAt: ref.updatedAt
      });
    }
    for (const threadId of this.threads) {
      if (!summaries.has(threadId)) {
        summaries.set(threadId, { threadId });
      }
    }
    return [...summaries.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  cancel(): void {
    this.inFlight?.abort();
  }

  /**
   * Summarize the stored conversation with the same model and replace it.
   *
   * `/api/chat` is stateless, and an opencode session keeps its own history, so
   * both paths shrink only when the transcript becomes the summary and the
   * opencode session is dropped. The next opencode turn is fresh and carries
   * the summary once. The transcript itself is returned for the host to store;
   * this adapter does not write it.
   */
  async compact(handle: ThreadHandle, request: CompactRequest): Promise<CompactResult> {
    const token = await this.token();
    if (!token) {
      throw new BackendError('unauthenticated', 'Set an Ollama Cloud token before compacting context.');
    }
    const model = request.model ?? this.defaultModel;
    if (!model) {
      throw new BackendError('provider', 'No Ollama Cloud model selected.');
    }
    const source = fitCompactionSource(compactionSource(request.transcript), request.maxTokens);
    if (!source.trim()) {
      throw new BackendError('provider', 'There is no conversation to compact.');
    }

    const controller = new AbortController();
    this.inFlight = controller;
    let summary = '';
    try {
      const settings =
        request.modelSettings?.contextWindow !== undefined
          ? request.modelSettings
          : request.maxTokens
            ? { ...request.modelSettings, contextWindow: request.maxTokens }
            : request.modelSettings;
      const response = await this.request('/api/chat', token, {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            { role: 'system', content: COMPACTION_INSTRUCTIONS },
            { role: 'user', content: source }
          ],
          ...ollamaNativeRequest(settings)
        })
      });
      const body = (await response.json()) as OllamaChatChunk;
      if (body.error) {
        throw new BackendError('provider', body.error);
      }
      summary = body.message?.content?.trim() ?? '';
    } catch (error) {
      if (this.inFlight === controller) {
        this.inFlight = undefined;
      }
      const failure = this.categorize(error);
      throw new BackendError(
        failure.code === 'unauthenticated' ? 'unauthenticated' : 'provider',
        failure.code === 'canceled' ? 'Compaction canceled.' : failure.message
      );
    }
    if (this.inFlight === controller) {
      this.inFlight = undefined;
    }
    if (!summary) {
      throw new BackendError('provider', 'Compaction did not return a summary.');
    }
    // Drop the live session only after a summary exists, so a failed compact
    // leaves the conversation where it was.
    await this.store?.setOpencodeSession(this.id, handle.threadId, undefined);
    return { transcript: compactedTranscript(summary) };
  }

  async sendTurn(handle: ThreadHandle, request: SendTurnRequest): Promise<void> {
    const token = await this.token();
    if (!token) {
      throw new BackendError('unauthenticated', 'Set an Ollama Cloud token before sending a turn.');
    }

    // Fallback is exact: with the setting off, the direct `/api/chat` adapter
    // runs and no opencode child is ever spawned. The runtime is imported
    // statically, but nothing on this branch constructs or launches it.
    if (this.opencodeEnabled) {
      await this.sendOpencodeTurn(handle, request, token);
      return;
    }

    const turnId = createId('ollama_turn');
    const itemId = createId('ollama_item');
    const controller = new AbortController();
    this.inFlight = controller;

    this.events.fire({ type: 'turn/started', backendId: this.id, threadId: handle.threadId, turnId });

    const model = request.model ?? this.defaultModel;
    if (!model) {
      this.inFlight = undefined;
      const failure = new BackendError('provider', 'No Ollama Cloud model selected.');
      this.events.fire({ type: 'turn/interrupted', backendId: this.id, threadId: handle.threadId, turnId, reason: failure.message });
      throw failure;
    }

    this.events.fire({
      type: 'item/started',
      backendId: this.id,
      threadId: handle.threadId,
      item: { id: itemId, kind: 'message', role: 'assistant', title: model }
    });

    let response: Response;
    try {
      response = await this.request('/api/chat', token, {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: true,
          messages: this.messagesFor(handle.threadId, request.text, request.context, request.mode),
          // The adapter is the only place that knows Ollama spells the context
          // window `options.num_ctx` and reasoning effort `think`; the mapping is
          // the pure, unit-tested `ollamaNativeRequest`.
          ...ollamaNativeRequest(request.modelSettings)
        })
      });
    } catch (error) {
      this.inFlight = undefined;
      this.failTurn(handle, itemId, turnId, this.categorize(error));
      throw error;
    }

    try {
      await this.streamChunks(response, handle, itemId, controller);
      if (controller.signal.aborted) {
        throw new StreamError('canceled', 'Turn canceled.');
      }
      this.events.fire({ type: 'item/completed', backendId: this.id, threadId: handle.threadId, itemId, status: 'completed' });
      this.events.fire({ type: 'turn/completed', backendId: this.id, threadId: handle.threadId, turnId });
    } catch (error) {
      this.failTurn(handle, itemId, turnId, this.categorize(error));
      throw error;
    } finally {
      if (this.inFlight === controller) {
        this.inFlight = undefined;
      }
    }
  }

  /**
   * Run one turn through the optional opencode agentic runtime and normalize its
   * NDJSON events into the same union the direct adapter emits, so the transcript
   * has one path and never branches on the runtime.
   *
   * Every failure mode is a distinct, actionable state (CLI missing, spawn
   * failure, invalid config, unauthenticated, stream error) and no error text
   * ever carries the token or a raw stack.
   */
  private async sendOpencodeTurn(handle: ThreadHandle, request: SendTurnRequest, token: string): Promise<void> {
    const turnId = createId('ollama_turn');
    const model = request.model ?? this.defaultModel;
    this.events.fire({ type: 'turn/started', backendId: this.id, threadId: handle.threadId, turnId });
    if (!model) {
      const failure = new BackendError('provider', 'No Ollama Cloud model selected.');
      this.events.fire({ type: 'turn/interrupted', backendId: this.id, threadId: handle.threadId, turnId, reason: failure.message });
      throw failure;
    }

    const permissionLevel: PermissionLevel = effectivePermissionLevel(
      request.mode ?? 'agent',
      request.permissionLevel ?? 'default'
    );
    // The opencode config points at the same base URL and the same live model
    // ids the direct adapter uses. The id is never rewritten and no list is
    // hardcoded: the ids come from the live `/api/tags` response. Only the
    // selected model's capability descriptor is read, so the turn does not fan
    // out one `/api/show` call per model.
    let modelIds: string[];
    try {
      modelIds = await this.tagNames();
    } catch (error) {
      this.failTurn(handle, '', turnId, this.categorize(error));
      throw error;
    }
    if (!modelIds.includes(model)) {
      // A model the live server no longer reports cannot be sent; this is the
      // same degradation the direct adapter's model resolution relies on.
      const failure = new BackendError('provider', `Ollama Cloud no longer reports the model "${model}".`);
      this.failTurn(handle, '', turnId, this.categorize(failure));
      throw failure;
    }
    const capabilities = await this.modelCapabilities(model);

    // Dynamically imported so the direct `/api/chat` path never loads the
    // runtime module at all: with the setting off there is no opencode code on
    // the path and no child process is ever spawned.
    const { buildOpencodeConfig } = await import('./opencode/config.ts');
    const { runOpencodeTurn } = await import('./opencode/runtime.ts');

    const built = buildOpencodeConfig({
      baseUrl: this.baseUrl,
      modelIds,
      modelId: model,
      settings: request.modelSettings,
      capabilities,
      mode: request.mode ?? 'agent',
      permissionLevel
    });
    if (built.reasoningUnsupported) {
      this.events.fire({
        type: 'notice',
        backendId: this.id,
        threadId: handle.threadId,
        level: 'info',
        message: `${model} does not expose a reasoning control, so that setting was not sent.`
      });
    }

    const controller = new AbortController();
    this.inFlight = controller;
    // The session id is read before the turn so a later turn in the same thread
    // resumes the same opencode session; absent means a fresh session.
    //
    // A narrowed context setting cannot retroactively un-send content a live
    // session already received, so the delivery layer's rebuilt payload is what
    // guarantees no *further* active-file or selection content leaves: with a
    // category off, the rebuilt snapshot and any later deltas carry no such
    // content, and this turn sends no stale block. A fresh session is started
    // only on a stale-session retry, so a live session keeps its memory.
    let sessionId = this.store?.getOpencodeSession(this.id, handle.threadId);

    // opencode 1.1.65 exposes no `--instructions`/system-prompt flag on
    // `opencode run`, so the snapshot is delivered by priming the turn text
    // (see `opencodePrompt`). A fresh session is primed with the full snapshot
    // even when this is not the thread's first turn, so a stale-session retry
    // does not start a new session with only a delta. The cwd above is the
    // workspace root, so opencode's own `AGENTS.md` discovery works either way.
    const summary = compactedSummary(this.store?.getTranscript(this.id, handle.threadId) ?? []);
    const promptFor = (fresh: boolean) => opencodePrompt(request, fresh, fresh ? summary : undefined);

    // The cwd the child is spawned with, reused to anchor a relative tool path.
    // It is the same root the snapshot service supplied, or the adapter's own
    // fallback, so a reported change resolves against the directory the agent
    // actually ran in.
    const opencodeCwd = request.context?.workspaceRoot ?? this.cwd;

    const runOnce = (fresh: boolean) =>
      runOpencodeTurn(
        {
          executable: this.opencodePath,
          // Prefer the snapshot service's root so opencode's own project
          // discovery reads the real `AGENTS.md`; `this.cwd` is only a fallback.
          cwd: opencodeCwd,
          config: built.config,
          modelRef: built.modelRef,
          agent: built.agent,
          prompt: promptFor(fresh),
          sessionId,
          token,
          signal: controller.signal
        },
        (event) => this.handleOpencodeEvent(event, handle.threadId, opencodeCwd)
      );

    try {
      let result = await runOnce(!sessionId);

      // A stale session id degrades to a fresh session, says so, and retries
      // exactly once — the same degradation rule the reload-resume work uses.
      if (result.outcome === 'stale-session' && sessionId) {
        await this.store?.setOpencodeSession(this.id, handle.threadId, undefined);
        sessionId = undefined;
        this.events.fire({
          type: 'notice',
          backendId: this.id,
          threadId: handle.threadId,
          level: 'info',
          message: 'The saved opencode session was not available, so a new one was started.'
        });
        result = await runOnce(true);
      }

      if (result.sessionId) {
        await this.store?.setOpencodeSession(this.id, handle.threadId, result.sessionId);
      }

      if (result.outcome === 'canceled') {
        this.failTurn(handle, '', turnId, { code: 'canceled', message: 'Turn canceled.' });
        return;
      }
      if (result.outcome === 'stale-session') {
        // A fresh session also failed to start: clear the mapping and report it
        // distinctly rather than reusing a session that cannot be resumed.
        await this.store?.setOpencodeSession(this.id, handle.threadId, undefined);
        this.failTurn(handle, '', turnId, {
          code: 'provider',
          message: 'The opencode session could not be started or resumed.'
        });
        throw new BackendError('provider', 'The opencode session could not be started or resumed.');
      }
      if (result.outcome === 'permission') {
        // A headless `ask` was auto-rejected: the action was safely refused, the
        // turn is not a failure, and the transcript stays coherent. A visible
        // notice explains it rather than an error.
        this.events.fire({
          type: 'notice',
          backendId: this.id,
          threadId: handle.threadId,
          level: 'info',
          message: 'A tool action needed approval, which a headless turn cannot grant, so it was not run.'
        });
        this.events.fire({ type: 'turn/completed', backendId: this.id, threadId: handle.threadId, turnId });
        return;
      }
      if (result.outcome !== 'completed') {
        // Every failure mode is a distinct, actionable state, and the turn is
        // closed with an error + interruption so the transcript stays coherent.
        const failure = this.opencodeFailure(result.outcome, result.detail);
        this.failTurn(handle, '', turnId, failure);
        throw new BackendError(
          failure.code === 'unauthenticated' ? 'unauthenticated' : 'provider',
          failure.message
        );
      }
      this.events.fire({ type: 'turn/completed', backendId: this.id, threadId: handle.threadId, turnId });
    } finally {
      if (this.inFlight === controller) {
        this.inFlight = undefined;
      }
    }
  }

  /** Translate one opencode event into the normalized union. */
  private handleOpencodeEvent(event: OpencodeEvent, threadId: string, cwd: string): void {
    switch (event.kind) {
      case 'text':
        // opencode 1.1.65 delivers whole text parts rather than token deltas;
        // each part is its own streamed item keyed by its part id.
        this.events.fire({
          type: 'item/started',
          backendId: this.id,
          threadId,
          item: { id: event.partId, kind: 'message', role: 'assistant' }
        });
        this.events.fire({ type: 'item/delta', backendId: this.id, threadId, itemId: event.partId, delta: event.text });
        this.events.fire({ type: 'item/completed', backendId: this.id, threadId, itemId: event.partId, status: 'completed' });
        break;
      case 'reasoning':
        this.events.fire({
          type: 'item/started',
          backendId: this.id,
          threadId,
          item: { id: event.partId, kind: 'reasoning', role: 'assistant', title: 'Reasoning' }
        });
        this.events.fire({ type: 'item/delta', backendId: this.id, threadId, itemId: event.partId, delta: event.text });
        this.events.fire({ type: 'item/completed', backendId: this.id, threadId, itemId: event.partId, status: 'completed' });
        break;
      case 'tool': {
        if (event.todos) {
          this.events.fire({
            type: 'plan/updated',
            backendId: this.id,
            threadId,
            turnId: event.callId,
            steps: event.todos
          });
        }
        const fileTool = isFileTool(event.tool);
        const itemId = event.callId;
        // Report the structured edit so the change journal records the content
        // side; the transcript card below is unchanged. The path is resolved
        // against the workspace cwd so a relative tool path is still absolute.
        const reported = reportedChangeOfTool(event);
        if (reported) {
          this.events.fire({
            type: 'changes/reported',
            backendId: this.id,
            threadId,
            changes: [{ absPath: isAbsolute(reported.absPath) ? reported.absPath : resolve(cwd, reported.absPath), status: reported.status }]
          });
        }
        const target =
          cleanToolTarget(event.target) ??
          cleanToolTarget(event.command) ??
          cleanToolTarget(event.filePath) ??
          cleanToolTarget(event.title);
        const output = event.output && !isStatusText(event.output) ? event.output : undefined;
        this.events.fire({
          type: 'item/started',
          backendId: this.id,
          threadId,
          item: fileTool
            ? {
                id: itemId,
                kind: 'file-change',
                title: friendlyToolTitle(event.tool, event.filePath ?? target),
                files: event.filePath ? [{ path: event.filePath }] : [],
                text: output
              }
            : {
                id: itemId,
                kind: 'tool',
                title: friendlyToolTitle(event.tool, target),
                command: target,
                text: output
              }
        });
        // A non-terminal tool card must not be closed early; a terminal state
        // closes it with its real outcome.
        if (event.status === 'completed' || event.status === 'error') {
          this.events.fire({
            type: 'item/completed',
            backendId: this.id,
            threadId,
            itemId,
            status: event.status === 'error' ? 'failed' : 'completed'
          });
        }
        break;
      }
      case 'step-finish':
        if (event.usedTokens !== undefined) {
          this.events.fire({
            type: 'context/usage',
            backendId: this.id,
            threadId,
            usedTokens: event.usedTokens
          });
        }
        break;
      case 'step-start':
      case 'unknown':
      case 'malformed':
        break;
      case 'error':
        // The runtime's run() classifies the terminal outcome; an inline error
        // is still surfaced so a mid-stream failure is not silently dropped.
        this.events.fire({
          type: 'error',
          backendId: this.id,
          threadId,
          message: 'The opencode runtime reported an error.',
          recoverable: true,
          code: 'provider'
        });
        break;
    }
  }

  /** Map a non-completed runtime outcome to a distinct, plain-language state. */
  private opencodeFailure(outcome: OpencodeOutcome, detail?: string): CategorizedError {
    switch (outcome) {
      case 'cli-missing':
        return {
          code: 'cli-missing',
          message: 'The opencode CLI was not found. Install it, or set melink.ollama.opencode.path, then try again.'
        };
      case 'spawn':
        return { code: 'spawn', message: detail ?? 'The opencode CLI could not be started.' };
      case 'invalid-config':
        return { code: 'invalid-config', message: 'The generated opencode config was rejected. Nothing was sent.' };
      case 'unauthenticated':
        return { code: 'unauthenticated', message: 'Your Ollama Cloud token was rejected. It may be expired or revoked.' };
      case 'permission':
        return {
          code: 'provider',
          message: detail ?? 'A tool action needed approval, which a headless turn cannot grant, so it was not run.'
        };
      case 'stream':
        return { code: 'stream', message: detail ?? 'The opencode stream ended before the turn completed.' };
      case 'canceled':
        return { code: 'canceled', message: 'Turn canceled.' };
      case 'stale-session':
        return { code: 'provider', message: 'The opencode session could not be resumed.' };
      case 'provider':
      default:
        return { code: 'provider', message: detail ?? 'The opencode runtime reported an error.' };
    }
  }

  /**
   * Build the `/api/chat` message list. `/api/chat` is stateless, so a resumed
   * thread is sent as its stored user/assistant turns followed by the new turn —
   * the same interface, with the conversation's context replayed in.
   *
   * Project context is layered in as `system`-role input by the shared, pure
   * `buildContextMessages`: the snapshot first (once per session), then the
   * per-turn delta immediately before the user turn. The stored history is read
   * but never mutated, so a delta can never be persisted as user content.
   */
  private messagesFor(
    threadId: string,
    text: string,
    context?: ContextPayload,
    mode?: DefaultMode
  ): Array<{ role: string; content: string }> {
    const history = (this.store?.getTranscript(this.id, threadId) ?? [])
      .filter((item) => item.kind === 'message' && (item.role === 'user' || item.role === 'assistant'))
      .map((item) => ({ role: item.role as 'user' | 'assistant', content: item.text ?? '' }))
      .filter((message) => message.content.length > 0);
    // The host appends the current turn to the render cache before invoking us,
    // so the trailing user message is this turn: drop it and re-add it exactly
    // once at the end rather than sending it twice.
    const last = history[history.length - 1];
    if (last && last.role === 'user' && last.content === text) {
      history.pop();
    }
    const messages = buildContextMessages(history, text, context);
    const instructions = modeInstructions(isDefaultMode(mode) ? mode : 'agent');
    if (instructions) {
      messages.unshift({ role: 'system', content: instructions });
    }
    return messages;
  }

  /** Emit the failed item + interruption pair that leaves the transcript coherent. */
  private failTurn(handle: ThreadHandle, itemId: string, turnId: string, error: CategorizedError): void {
    if (error.code === 'canceled') {
      // A cancel is not a failure: keep the partial message, no error treatment.
      this.events.fire({ type: 'item/completed', backendId: this.id, threadId: handle.threadId, itemId, status: 'completed' });
      this.events.fire({
        type: 'turn/interrupted',
        backendId: this.id,
        threadId: handle.threadId,
        turnId,
        reason: error.message,
        canceled: true
      });
      return;
    }
    this.events.fire({ type: 'item/completed', backendId: this.id, threadId: handle.threadId, itemId, status: 'failed' });
    this.events.fire({
      type: 'error',
      backendId: this.id,
      threadId: handle.threadId,
      message: error.message,
      recoverable: true,
      code: error.code
    });
    this.events.fire({ type: 'turn/interrupted', backendId: this.id, threadId: handle.threadId, turnId });
  }

  /** Translate any failure into provider-neutral, non-alarming UI copy. */
  private categorize(error: unknown): CategorizedError {
    if (error instanceof StreamError) {
      return { code: error.code, message: error.message };
    }
    if (error instanceof BackendError) {
      if (error.code === 'unauthenticated') {
        return { code: 'unauthenticated', message: error.message };
      }
      if (error.code === 'unavailable') {
        return { code: 'network', message: error.message };
      }
      return { code: 'provider', message: error.message };
    }
    if (isAbortError(error)) {
      return { code: 'canceled', message: 'Turn canceled.' };
    }
    return { code: 'provider', message: 'Ollama Cloud request failed.' };
  }

  private async streamChunks(
    response: Response,
    handle: ThreadHandle,
    itemId: string,
    controller: AbortController
  ): Promise<void> {
    if (!response.body) {
      throw new StreamError('stream', 'Ollama Cloud returned an empty response stream.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        if (controller.signal.aborted) {
          throw new StreamError('canceled', 'Turn canceled.');
        }
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            this.handleChunk(line, handle, itemId);
          }
          newline = buffer.indexOf('\n');
        }
      }
      if (buffer.trim()) {
        this.handleChunk(buffer.trim(), handle, itemId);
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw new StreamError('canceled', 'Turn canceled.', error);
      }
      if (error instanceof StreamError) {
        throw error;
      }
      // The socket dropped after the response began: a distinct, recoverable state.
      throw new StreamError('network', 'The connection to Ollama Cloud dropped mid-stream.', error);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // The reader may already be released after an abort; nothing to do.
      }
    }
  }

  private handleChunk(line: string, handle: ThreadHandle, itemId: string): void {
    let chunk: OllamaChatChunk;
    try {
      chunk = JSON.parse(line) as OllamaChatChunk;
    } catch {
      throw new StreamError('stream', 'Ollama Cloud sent a chunk that could not be read.');
    }
    if (chunk.error) {
      throw new StreamError('provider', chunk.error);
    }
    const delta = chunk.message?.content;
    if (delta) {
      this.events.fire({ type: 'item/delta', backendId: this.id, threadId: handle.threadId, itemId, delta });
    }
    const used = ollamaContextUsed(chunk.prompt_eval_count, chunk.eval_count);
    if (used !== undefined) {
      this.events.fire({
        type: 'context/usage',
        backendId: this.id,
        threadId: handle.threadId,
        usedTokens: used
      });
    }
  }

  onEvent(listener: (event: AgentEvent) => void): Disposable {
    return this.events.event(listener);
  }

  dispose(): void {
    this.cancel();
    this.threads.clear();
    this.events.dispose();
  }
}
