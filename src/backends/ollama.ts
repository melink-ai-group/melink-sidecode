import * as vscode from 'vscode';
import { repoMapPrompt } from '../context/providerCopy.ts';
import { createId, Emitter } from './base';
import { OLLAMA_TOKEN_SECRET_KEY } from './secrets';
import type { ThreadStore } from './threadStore';
import { describeApproval, ruleFor, ruleScopeFor } from './approvals';
import { safeModeDecision, storedRuleUnlessAsk } from './safeMode.ts';
import type { ApprovalStore } from './approvalStore';
import { APPROVAL_TIMEOUT_REASON, awaitUserDecision } from './approvalWait';
import { approvalFromOpencode, opencodeReplyFor, type OpencodePermissionAsk } from './opencode/approval';
import type { OpencodeQuestionAsk } from './opencode/runtime';
import { SKIPPED_ANSWER, type QuestionAnswer, type QuestionRequest } from '../questions';
import { BackendError } from './types';
import type {
  AgentBackend,
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRule,
  BackendModel,
  CompactRequest,
  CompactResult,
  ConnectionTestResult,
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
import {
  PROVIDER_PROBE_TIMEOUT_MS,
  isProbeTimeoutError,
  probeSignal as createProbeSignal,
  readProbeJson,
  timeoutMessage
} from './probeTimeout';
import { effectivePermissionLevel, isDefaultMode, modeInstructionsForTurn } from './modes';
// Type-only imports are erased at compile time, so the off path loads neither
// the runtime module nor any child-process code; the runtime is dynamically
// imported inside the enabled branch only. `isFileTool` is a pure predicate
// with no child-process dependency, so it is safe to import directly.
import { isFileTool, isTerminalStepReason, reportedChangeOfTool } from './opencode/events';
import { resolveOpencodeExecutable } from './opencode/resolve';
import { readTrustedOpencodeCliSource, readTrustedOpencodePath } from '../config/settings.ts';
import {
  COMPACTION_INSTRUCTIONS,
  compactedTranscript,
  compactedSummary,
  compactionPreface,
  compactionSource,
  fitCompactionSource
} from './compaction';
import { recoveryHandover, threadRecoveredNotice } from './threadRecovery';
import { cleanToolTarget, friendlyToolTitle, isStatusText } from './toolLabel.ts';
import { DICTATION_INSTRUCTIONS, dictationText } from '../dictation/prompt';
import type { OpencodeEvent } from './opencode/events';
import { quietTurnMessage, watchOpencodeQuiet } from './opencode/quiet';
import type { OpencodeOutcome } from './opencode/runtime';
import { isAbsolute, resolve } from 'node:path';
import {
  OllamaClient,
  defaultOllamaTransport,
  isHttpOllamaUrl,
  type OllamaTransport
} from './ollamaBaseUrl.ts';
import { OLLAMA_CLOUD_PROFILE, type OllamaProfile } from './ollamaProfile.ts';
import { probeOllamaLocal } from './ollamaLocalHealth.ts';
import { LOCAL_OPENCODE_API_KEY, OPENCODE_LOCAL_API_KEY_ENV, OPENCODE_LOCAL_PROVIDER_ID } from './opencode/config.ts';

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
  readonly code: ErrorEventCode;

  constructor(code: ErrorEventCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'StreamError';
    this.code = code;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
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
function opencodePrompt(
  request: SendTurnRequest,
  freshSession: boolean,
  summary?: string,
  recovery?: string,
  previousMode?: DefaultMode
): string {
  const context = request.context;
  const block = freshSession
    ? context?.snapshot ?? context?.notice
    : context?.delta ?? context?.notice;
  const mode = isDefaultMode(request.mode) ? request.mode : 'agent';
  const instructions = modeInstructionsForTurn(mode, previousMode, request.context?.frontendStack);
  // A fresh session has no memory of the thread. A replacement for a missing
  // session gets the saved chat once. Otherwise the compaction summary is
  // included once; later turns resume the session and do not repeat it.
  const preface = !freshSession
    ? undefined
    : recovery?.trim()
      ? recovery.trim()
      : summary
        ? compactionPreface(summary)
        : undefined;
  const parts = [instructions, preface, block, repoMapPrompt(context?.repoMap), context?.attachedFile, request.text].filter(
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
 * Ollama adapter for both Cloud and Local. Talks to the native HTTP API (with a
 * bearer token for Cloud; no credential at all for Local) and runs every LLM
 * turn through the shared OpenCode runtime; no Ollama SDK types cross this
 * boundary.
 *
 * Model identifiers are passed through exactly as `/api/tags` returns them —
 * the adapter never rewrites a name (in particular it never adds or strips the
 * `:cloud` suffix the app/CLI uses).
 */
export class OllamaBackend implements AgentBackend {
  readonly id: string;
  readonly label: string;
  readonly badge: string;

  private readonly profile: OllamaProfile;

  /**
   * Every Ollama turn runs through the opencode runtime, which can ask the user
   * for a decision and enforce all three permission levels.
   */
  get hasApprovalChannel(): boolean {
    return true;
  }

  /**
   * Permission levels this path can serve. The shared OpenCode runtime can
   * enforce all three, so they are reported for both providers.
   */
  get permissionLevels(): readonly PermissionLevel[] {
    return ['read-only', 'default', 'unrestricted'];
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

  /** Stored `always` rules for this backend. */
  async listApprovalRules(): Promise<ApprovalRule[]> {
    return this.approvals?.listGlobalRules().filter((rule) => rule.backendId === this.id) ?? [];
  }

  /** Removes one stored `always` rule. */
  async revokeApprovalRule(ruleId: string): Promise<void> {
    await this.approvals?.revokeRule(ruleId);
  }

  /**
   * Answer a pending opencode permission. An unknown or already settled id is
   * ignored, so a double click cannot answer twice. The wait itself lives in
   * `decideOpencodePermission`.
   */
  answerQuestion(threadId: string, requestId: string, answers: QuestionAnswer[]): void {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending || pending.threadId !== threadId) {
      return;
    }
    this.pendingQuestions.delete(requestId);
    pending.settle(
      pending.questions.map((question) => {
        const found = answers.find((entry) => entry.questionId === question.id);
        return [found?.text.trim() || SKIPPED_ANSWER];
      })
    );
  }

  decideApproval(threadId: string, requestId: string, decision: ApprovalDecision): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending || pending.threadId !== threadId) {
      return;
    }
    this.pendingApprovals.delete(requestId);
    pending.settle(decision);
  }

  private readonly events = new Emitter<AgentEvent>();
  private readonly threads = new Set<string>();
  private readonly pendingApprovals = new Map<
    string,
    { threadId: string; request: ApprovalRequest; settle: (decision: ApprovalDecision) => void }
  >();
  private readonly pendingQuestions = new Map<
    string,
    {
      threadId: string;
      questions: QuestionRequest['questions'];
      settle: (answers: string[][] | 'reject') => void;
    }
  >();
  /** One abort handle per chat, so two tabs can generate at once. */
  private readonly flights = new Map<string, AbortController>();
  /** User texts waiting to be folded into one chat's turn. Stop clears that chat. */
  private readonly steerQueues = new Map<string, string[]>();
  /** Chats whose live OpenCode turn was ended because nothing new arrived. */
  private readonly quietStops = new Set<string>();
  /**
   * The mode text last applied to each chat in this process. OpenCode keeps
   * earlier turns in its session history, so a changed mode needs an explicit
   * revocation sentence. In-memory only: a session resumed from an earlier
   * process has no recorded previous mode.
   */
  private readonly appliedModes = new Map<string, DefaultMode>();
  /** Compaction and other work that is not a chat turn. */
  private sideFlight?: AbortController;

  private readonly context: vscode.ExtensionContext;
  private readonly store?: ThreadStore;
  private readonly approvals?: ApprovalStore;
  /**
   * The transport seam. A test can observe the exact URL and headers every
   * request goes to — including the "Test connection" request — without a
   * network.
   */
  private readonly transport?: OllamaTransport;

  constructor(
    context: vscode.ExtensionContext,
    store?: ThreadStore,
    approvals?: ApprovalStore,
    transport?: OllamaTransport,
    profile: OllamaProfile = OLLAMA_CLOUD_PROFILE
  ) {
    this.context = context;
    this.store = store;
    this.approvals = approvals;
    this.transport = transport;
    this.profile = profile;
    this.id = profile.id;
    this.label = profile.label;
    this.badge = profile.badge;
  }

  private get baseUrl(): string {
    // The host the requests go to. Read from the user's own settings only: a
    // workspace `.vscode/settings.json` must not be able to redirect them.
    return this.client.baseUrl;
  }

  /**
   * The client that talks to the configured host.
   *
   * It owns the base-URL rule (user scope only) and the transport seam, so
   * the adapter never re-derives which host receives the request.
   */
  private get client(): OllamaClient {
    return new OllamaClient(
      vscode.workspace.getConfiguration().inspect<string>(this.profile.baseUrlKey),
      this.transport ?? defaultOllamaTransport(),
      this.profile.defaultBaseUrl,
      this.profile.label
    );
  }

  /** Whether this provider has a credential at all. */
  private get tokenless(): boolean {
    return this.profile.credential === 'none';
  }

  /**
   * Executable every opencode spawn uses. Bundled ignores the path setting so
   * the machine PATH cannot slip into turns.
   *
   * The source and the path are read from the user's own settings only, and a
   * relative path is refused — with a separator or in the Windows
   * drive-relative form — so neither the repository nor a workspace override
   * can choose the binary that runs.
   */
  private get opencodePath(): string {
    return resolveOpencodeExecutable({
      source: readTrustedOpencodeCliSource(),
      path: readTrustedOpencodePath(),
      roots: {
        extensionPath: this.context.extensionPath,
        globalStoragePath: this.context.globalStorageUri.fsPath
      }
    });
  }

  /** Working directory the runtime runs in, mirroring the Codex adapter. */
  private get cwd(): string {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : process.cwd();
  }

  private async skillMcpForTurn(): Promise<{
    mcp?: Record<string, unknown>;
    permissions: Record<string, 'allow'>;
    astGrep: boolean;
  }> {
    const { skillMcpForOpencodeTurn } = await import('../skills/resolveForTurn.ts');
    return skillMcpForOpencodeTurn({
      extensionPath: this.context.extensionPath,
      globalStoragePath: this.context.globalStorageUri.fsPath
    });
  }

  private get defaultModel(): string {
    return vscode.workspace.getConfiguration().get<string>(this.profile.defaultModelKey, '');
  }

  private async token(): Promise<string | undefined> {
    if (this.tokenless) {
      return undefined;
    }
    return this.context.secrets.get(OLLAMA_TOKEN_SECRET_KEY);
  }

  async isAuthenticated(): Promise<boolean> {
    if (this.tokenless) {
      // A local server has no credential: reachability *and* the OpenAI-
      // compatible `/v1` path are the availability signal. A failure carries
      // the actionable reason so the picker never says "No usable credential".
      const probe = await this.testConnection();
      if (probe.outcome === 'ok') {
        return true;
      }
      throw new BackendError('unavailable', probe.message);
    }
    const token = await this.token();
    if (!token) {
      return false;
    }
    try {
      await this.request('/api/tags', token, undefined, PROVIDER_PROBE_TIMEOUT_MS);
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
   *
   * The request goes through the client, so the transport seam observes it
   * exactly like every other request: the host that receives the credential
   * is the user's own base URL, never a workspace-supplied one.
   */
  async testConnection(timeoutMs: number = PROVIDER_PROBE_TIMEOUT_MS): Promise<ConnectionTestResult> {
    if (this.tokenless) {
      if (!isHttpOllamaUrl(this.baseUrl)) {
        return {
          backendId: this.id,
          outcome: 'host',
          message: 'The base URL is not a full http or https address. Fix it, then test again.'
        };
      }
      return probeOllamaLocal({
        baseUrl: this.baseUrl,
        timeoutMs,
        request: (path, init) => this.client.probe(path, undefined, init, { timeoutMs })
      });
    }
    if (!isHttpOllamaUrl(this.baseUrl)) {
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
      // The status-preserving probe: the client wraps a transport failure in a
      // `BackendError`, and this path has to tell a DNS or refused host apart
      // from a general network failure — and a rejected key (`401`) apart from
      // a host-side failure (any other non-2xx).
      response = await this.client.probe('/api/tags', token, undefined, { timeoutMs });
    } catch (error) {
      // A timed-out probe is neither a bad host nor a general network failure.
      if (isProbeTimeoutError(error)) {
        return {
          backendId: this.id,
          outcome: 'unavailable',
          message: timeoutMessage(this.label, timeoutMs)
        };
      }
      // A transport failure is the only place the network and the host differ.
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (offline) {
        return {
          backendId: this.id,
          outcome: 'network',
          message: 'This device appears to be offline. Reconnect, then test again.'
        };
      }
      const cause = error instanceof BackendError ? error.cause : error;
      if (isDnsOrRefused(cause)) {
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

  /**
   * One authenticated request to the configured host.
   *
   * The client owns the base-URL rule and the transport, so the host that
   * receives the credential is the one the user configured. A rejected
   * credential is reported without echoing it back to the caller.
   */
  private async request(
    path: string,
    token: string | undefined,
    init?: RequestInit,
    timeoutMs?: number,
    probeSignal?: AbortSignal
  ): Promise<Response> {
    try {
      const timeout =
        timeoutMs !== undefined || probeSignal !== undefined ? { timeoutMs, probeSignal } : undefined;
      return timeout
        ? await this.client.request(path, token, init, timeout)
        : await this.client.request(path, token, init);
    } catch (cause) {
      // A caller cancel wins over the probe deadline, so Stop is still Stop.
      if (init?.signal?.aborted) {
        throw new StreamError('canceled', 'Turn canceled.', cause);
      }
      if (cause instanceof BackendError) {
        throw cause;
      }
      if (isAbortError(cause)) {
        throw new StreamError('canceled', 'Turn canceled.', cause);
      }
      throw cause;
    }
  }

  async listModels(timeoutMs: number = PROVIDER_PROBE_TIMEOUT_MS): Promise<BackendModel[]> {
    const token = await this.token();
    if (!token && !this.tokenless) {
      throw new BackendError('unauthenticated', `Set an ${this.label} token to list models.`);
    }
    // One deadline covers the tag list and every per-model capability read, so
    // a stalled `/api/show` cannot leave the picker half-loaded past the probe.
    const signal = createProbeSignal(timeoutMs);
    const response = await this.request('/api/tags', token, undefined, timeoutMs, signal);
    const body = await readProbeJson<OllamaTagsResponse>(response, this.label, timeoutMs, signal);
    // No hardcoded array and no fallback list: the picker is exactly what the
    // live server reports, so removing a model server-side removes it here.
    const names = this.tagNamesFromBody(body);
    // Each model's descriptor is read from `/api/show`, in parallel. A model
    // whose `/api/show` fails still appears, with an all-unknown descriptor, so
    // a single metadata failure cannot hide a usable model. A timeout is not
    // just another metadata failure: it rejects the list so the UI can retry.
    return Promise.all(
      names.map(async (name) => {
        const capabilities = await this.modelCapabilities(name, timeoutMs, signal);
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
    if (!token && !this.tokenless) {
      throw new BackendError('unauthenticated', `Set an ${this.label} token to list models.`);
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
   *
   * `timeoutMs`/`probeSignal` are supplied only by `listModels`, so every
   * capability read shares that list's single deadline. The turn path calls
   * this without them and stays untimed, as before.
   */
  async modelCapabilities(
    modelId: string,
    timeoutMs?: number,
    probeSignal?: AbortSignal
  ): Promise<ModelCapabilities | undefined> {
    const token = await this.token();
    if (!token && !this.tokenless) {
      return undefined;
    }
    const timed = timeoutMs !== undefined || probeSignal !== undefined;
    const deadlineMs = timeoutMs ?? PROVIDER_PROBE_TIMEOUT_MS;
    const deadline = timed ? probeSignal ?? createProbeSignal(deadlineMs) : undefined;
    let show: unknown;
    try {
      const response = await this.request(
        '/api/show',
        token,
        {
          method: 'POST',
          body: JSON.stringify({ model: modelId })
        },
        timed ? deadlineMs : undefined,
        deadline
      );
      show = deadline
        ? await readProbeJson<unknown>(response, this.label, deadlineMs, deadline)
        : await response.json();
    } catch (error) {
      // A metadata failure is not a list failure: the model is simply unknown.
      // A probe timeout, however, must reach listModels so the UI can retry.
      if (isProbeTimeoutError(error)) {
        throw error;
      }
      return undefined;
    }
    return ollamaCapabilities(show, this.modes);
  }

  async startThread(options?: StartThreadOptions): Promise<ThreadHandle> {
    const threadId = createId('ollama_thread');
    if (options?.internalSubagent) {
      this.store?.markInternalThread(this.id, threadId);
    }
    this.threads.add(threadId);
    let model = options?.model ?? this.defaultModel;
    // Local has no app-level model until one is chosen, so an empty default
    // resolves to the first model the running server reports. A failed read is
    // not fatal here: the first turn reports the real provider error.
    if (!model && this.tokenless) {
      try {
        model = (await this.tagNames())[0] ?? '';
      } catch {
        model = '';
      }
    }
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
      if (this.store?.isInternalThread(this.id, threadId)) {
        continue;
      }
      if (!summaries.has(threadId)) {
        summaries.set(threadId, { threadId });
      }
    }
    return [...summaries.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  cancel(threadId?: string): void {
    if (threadId) {
      this.steerQueues.delete(threadId);
      this.quietStops.delete(threadId);
      this.flights.get(threadId)?.abort();
      return;
    }
    this.sideFlight?.abort();
    this.sideFlight = undefined;
    for (const [id, controller] of this.flights) {
      this.steerQueues.delete(id);
      this.quietStops.delete(id);
      controller.abort();
    }
  }

  /**
   * Stop the current generation and continue this same turn with `text`.
   * The direct adapter sends a new `/api/chat` that includes the partial
   * reply. Opencode resumes the same session with the new prompt. Either way
   * the turn stays open until that continuation finishes.
   */
  async steerTurn(handle: ThreadHandle, text: string): Promise<void> {
    const value = text.trim();
    if (!value) {
      return;
    }
    if (!this.flights.has(handle.threadId)) {
      throw new BackendError('provider', 'There is no active turn to steer.');
    }
    const queued = this.steerQueues.get(handle.threadId) ?? [];
    queued.push(value);
    this.steerQueues.set(handle.threadId, queued);
    this.flights.get(handle.threadId)?.abort();
  }

  private beginFlight(threadId: string): AbortController {
    const controller = new AbortController();
    this.flights.set(threadId, controller);
    return controller;
  }

  private endFlight(threadId: string, controller: AbortController): void {
    if (this.flights.get(threadId) === controller) {
      this.flights.delete(threadId);
    }
  }

  /** Join this chat's queued steers, or `undefined` when Stop won or nothing is queued. */
  private drainSteers(threadId: string): string | undefined {
    const queued = this.steerQueues.get(threadId);
    if (!queued || queued.length === 0) {
      return undefined;
    }
    this.steerQueues.delete(threadId);
    return queued.join('\n\n');
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
    const summary = await this.summarize(request);
    // Drop the live session only after a summary exists, so a failed compact
    // leaves the conversation where it was.
    await this.store?.setOpencodeSession(this.id, handle.threadId, undefined);
    return { transcript: compactedTranscript(summary) };
  }

  /**
   * Summarize the stored transcript with the same model. The thread and its
   * opencode session stay as they are; a provider switch carries the text
   * onto the next thread instead of shrinking this one.
   */
  async summarize(request: CompactRequest): Promise<string> {
    const token = await this.token();
    if (!token && !this.tokenless) {
      throw new BackendError('unauthenticated', `Set an ${this.label} token before compacting context.`);
    }
    const model = request.model ?? this.defaultModel;
    if (!model) {
      throw new BackendError('provider', `No ${this.label} model selected.`);
    }
    const source = fitCompactionSource(
      compactionSource(request.transcript),
      request.maxTokens ?? request.modelSettings?.contextWindow
    );
    if (!source.trim()) {
      throw new BackendError('provider', 'There is no conversation to compact.');
    }

    const controller = new AbortController();
    this.sideFlight = controller;
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
      if (this.sideFlight === controller) {
        this.sideFlight = undefined;
      }
      const failure = this.categorize(error);
      throw new BackendError(
        failure.code === 'unauthenticated' ? 'unauthenticated' : 'provider',
        failure.code === 'canceled' ? 'Compaction canceled.' : failure.message
      );
    }
    if (this.sideFlight === controller) {
      this.sideFlight = undefined;
    }
    if (!summary) {
      throw new BackendError('provider', 'Compaction did not return a summary.');
    }
    return summary;
  }

  /**
   * Turn a raw dictation into the utterance the speaker meant to send.
   * A direct `/api/chat` call: it never opens a thread and never uses opencode.
   */
  async cleanDictation(text: string, model: string): Promise<string> {
    const source = text.trim();
    if (!source) {
      throw new BackendError('provider', 'No speech was heard.');
    }
    const selected = model.trim();
    if (!selected) {
      throw new BackendError('provider', 'Choose a dictation model in Settings.');
    }
    const token = await this.token();
    if (!token && !this.tokenless) {
      throw new BackendError('unauthenticated', `Set an ${this.label} token before using dictation.`);
    }
    const response = await this.request('/api/chat', token, {
      method: 'POST',
      body: JSON.stringify({
        model: selected,
        stream: false,
        messages: [
          { role: 'system', content: DICTATION_INSTRUCTIONS },
          { role: 'user', content: source }
        ]
      })
    });
    const body = (await response.json()) as OllamaChatChunk;
    if (body.error) {
      throw new BackendError('provider', body.error);
    }
    const cleaned = dictationText(body.message?.content ?? '');
    if (!cleaned) {
      throw new BackendError('provider', 'Dictation cleanup returned nothing.');
    }
    return cleaned;
  }

  async sendTurn(handle: ThreadHandle, request: SendTurnRequest): Promise<void> {
    const token = await this.token();
    if (!token && !this.tokenless) {
      throw new BackendError('unauthenticated', `Set an ${this.label} token before sending a turn.`);
    }
    // Every LLM turn goes through the shared OpenCode runtime, for both Ollama
    // Cloud and Ollama Local. The direct `/api/chat` API remains only for
    // compaction/summarize and dictation cleanup.
    await this.sendOpencodeTurn(handle, request, token);
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
  private async sendOpencodeTurn(handle: ThreadHandle, request: SendTurnRequest, token?: string): Promise<void> {
    const turnId = createId('ollama_turn');
    const model = request.model ?? this.defaultModel;
    this.events.fire({ type: 'turn/started', backendId: this.id, threadId: handle.threadId, turnId });
    if (!model) {
      const failure = new BackendError('provider', `No ${this.label} model selected.`);
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
      const failure = new BackendError('provider', `${this.label} no longer reports the model "${model}".`);
      this.failTurn(handle, '', turnId, this.categorize(failure));
      throw failure;
    }
    const capabilities = await this.modelCapabilities(model);

    // Dynamically imported so the module graph stays small; the runtime is the
    // only LLM turn path for both Ollama Cloud and Ollama Local.
    const { buildOpencodeConfig, opencodeRequiresApproval } = await import('./opencode/config.ts');
    const { runOpencodeTurn } = await import('./opencode/runtime.ts');
    const { browserCommand } = await import('../browser/skill.ts');
    const browser = await browserCommand('opencode');
    const skills = await this.skillMcpForTurn();

    const local = this.tokenless;
    const built = buildOpencodeConfig({
      baseUrl: this.baseUrl,
      modelIds,
      modelId: model,
      settings: request.modelSettings,
      capabilities,
      mode: request.mode ?? 'agent',
      permissionLevel,
      ...(local
        ? {
            providerId: OPENCODE_LOCAL_PROVIDER_ID,
            providerName: this.label,
            apiKeyEnv: OPENCODE_LOCAL_API_KEY_ENV
          }
        : {}),
      ...(browser ? { browser } : {}),
      ...(skills.mcp ? { skillMcp: skills.mcp } : {}),
      ...(Object.keys(skills.permissions).length > 0 ? { skillPermissions: skills.permissions } : {}),
      ...(skills.astGrep ? { astGrepSkill: true } : {})
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

    let controller = this.beginFlight(handle.threadId);
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
    const summary = this.handoverSummary(handle.threadId) ?? compactedSummary(this.store?.getTranscript(this.id, handle.threadId) ?? []);
    // A steer on a live session sends only the new text. Until a session id
    // exists, the text is still primed with the snapshot.
    let visibleText = request.text;
    let turnAttachments = request.attachments;
    let barePrompt = false;
    // Set when a saved session is gone, so the replacement session receives the
    // sidebar chat instead of only the current turn.
    let recovery: string | undefined;

    // The cwd the child is spawned with, reused to anchor a relative tool path.
    // It is the same root the snapshot service supplied, or the adapter's own
    // fallback, so a reported change resolves against the directory the agent
    // actually ran in.
    const opencodeCwd = request.context?.workspaceRoot ?? this.cwd;

    const promptFor = (): string => {
      if (barePrompt) {
        return visibleText;
      }
      const mode = isDefaultMode(request.mode) ? request.mode : 'agent';
      const previousMode = this.appliedModes.get(handle.threadId);
      this.appliedModes.set(handle.threadId, mode);
      return opencodePrompt(
        { ...request, text: visibleText },
        !sessionId,
        !sessionId && !recovery ? summary : undefined,
        !sessionId ? recovery : undefined,
        previousMode
      );
    };

    try {
      for (;;) {
        const openTools = new Set<string>();
        const pace = { slowCall: false };
        const quietWatch = watchOpencodeQuiet({
          blocked: () => openTools.size > 0 || this.waitingOnUser(handle.threadId),
          slowCall: () => pace.slowCall,
          onQuiet: () => {
            this.quietStops.add(handle.threadId);
            controller.abort();
          }
        });
        const runOnce = (prompt: string, resumeId: string | undefined) =>
          runOpencodeTurn(
            {
              executable: this.opencodePath,
              // Prefer the snapshot service's root so opencode's own project
              // discovery reads the real `AGENTS.md`; `this.cwd` is only a fallback.
              cwd: opencodeCwd,
              config: built.config,
              attachments: turnAttachments,
              modelRef: built.modelRef,
              agent: built.agent,
              prompt,
              sessionId: resumeId,
              token: local ? LOCAL_OPENCODE_API_KEY : (token ?? ''),
              ...(local ? { apiKeyEnv: OPENCODE_LOCAL_API_KEY_ENV } : {}),
              signal: controller.signal,
              streamActivity: true,
              decidePermission: opencodeRequiresApproval(permissionLevel, request.mode ?? 'agent')
                ? (ask, signal) => this.decideOpencodePermission(handle.threadId, ask, signal)
                : undefined,
              questionPermission: (request.mode ?? 'agent') === 'ask' ? 'deny' : 'ask',
              answerQuestion:
                (request.mode ?? 'agent') === 'ask'
                  ? undefined
                  : (ask, signal) => this.decideOpencodeQuestion(handle.threadId, ask, signal)
            },
            (event) => {
              this.noteOpencodeActivity(event, openTools, pace, quietWatch);
              this.handleOpencodeEvent(event, handle.threadId, opencodeCwd);
            }
          );

        let result: Awaited<ReturnType<typeof runOnce>>;
        try {
          result = await runOnce(promptFor(), sessionId);

          // A stale session id degrades to a fresh session, says so, and retries
          // exactly once — the same degradation rule the reload-resume work uses.
          if (result.outcome === 'stale-session' && sessionId) {
            await this.store?.setOpencodeSession(this.id, handle.threadId, undefined);
            sessionId = undefined;
            barePrompt = false;
            const transcript = this.store?.getTranscript(this.id, handle.threadId) ?? [];
            recovery = recoveryHandover({
              provider: 'OpenCode',
              transcript,
              plan: this.store?.getPlanState(this.id, handle.threadId),
              omitTrailingUserText: visibleText
            });
            this.events.fire({
              type: 'notice',
              backendId: this.id,
              threadId: handle.threadId,
              level: 'info',
              message: recovery
                ? threadRecoveredNotice('OpenCode')
                : 'The saved opencode session was not available, so a new one was started.'
            });
            result = await runOnce(promptFor(), undefined);
          }
        } finally {
          quietWatch.stop();
        }

        if (result.sessionId) {
          sessionId = result.sessionId;
          await this.store?.setOpencodeSession(this.id, handle.threadId, result.sessionId);
        }

        const next =
          result.outcome === 'canceled' || result.outcome === 'completed' ? this.drainSteers(handle.threadId) : undefined;
        const quiet = this.quietStops.delete(handle.threadId);
        if (next) {
          // Keep this turn open. A live session already has the original prompt,
          // so the continuation is the steer text alone. Without a session id
          // the next child is fresh and must see both. A steer wins over a
          // quiet stop: the user already said what to do next.
          if (sessionId) {
            turnAttachments = undefined;
            visibleText = next;
            barePrompt = true;
          } else {
            visibleText = `${visibleText}\n\n${next}`;
            barePrompt = false;
          }
          controller = this.beginFlight(handle.threadId);
          continue;
        }

        if (result.outcome === 'canceled' && quiet) {
          const failure = { code: 'stream' as const, message: quietTurnMessage() };
          this.failTurn(handle, '', turnId, failure);
          throw new BackendError('provider', failure.message);
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
        return;
      }
    } finally {
      this.endFlight(handle.threadId, controller);
      this.steerQueues.delete(handle.threadId);
      this.quietStops.delete(handle.threadId);
    }
  }

  /**
   * Hold one opencode `ask` until the user answers, or for {@link APPROVAL_WAIT_MS}.
   * A stored session or always rule is applied immediately, with the same reply
   * a manual choice of that scope would send. A timeout refuses the action so
   * the agent can try something else; it does not end the turn.
   */
  private decideOpencodePermission(
    threadId: string,
    ask: OpencodePermissionAsk,
    signal: AbortSignal
  ): Promise<'once' | 'always' | 'reject'> {
    if (this.store?.isInternalThread(this.id, threadId)) {
      return Promise.resolve('reject');
    }
    const request = approvalFromOpencode(ask, this.cwd);
    // Safety precedes stored rules: a destructive command must not be answered
    // by a broad first-token rule. `block` refuses before a card exists; `ask`
    // skips the rule lookup and forces the user decision with the risk reason.
    const safety = safeModeDecision(request);
    if (safety.action === 'block') {
      this.publishRefusal(threadId, request, safety.reason);
      return Promise.resolve('reject');
    }
    if (safety.action === 'ask') {
      request.reason = safety.reason;
    }
    const matched = storedRuleUnlessAsk(safety, () => this.approvals?.match(this.id, threadId, request));
    if (matched) {
      const decision: ApprovalDecision = matched.scope === 'session' ? 'allow-session' : 'allow-always';
      this.events.fire({
        type: 'approval/decided',
        backendId: this.id,
        threadId,
        outcome: { requestId: request.id, decision, subject: describeApproval(request) }
      });
      return Promise.resolve(opencodeReplyFor(decision));
    }
    return awaitUserDecision<'once' | 'always' | 'reject'>({
      signal,
      onRequest: (settle) => {
        this.pendingApprovals.set(request.id, {
          threadId,
          request,
          settle: (decision) => {
            this.rememberApproval(threadId, request, decision);
            const subject = describeApproval(request);
            this.events.fire({
              type: 'approval/decided',
              backendId: this.id,
              threadId,
              outcome: { requestId: request.id, decision, subject }
            });
            if (decision === 'reject') {
              this.events.fire({
                type: 'approval/denied',
                backendId: this.id,
                threadId,
                requestId: request.id,
                subject,
                reason: 'The user denied this request.'
              });
            }
            settle(opencodeReplyFor(decision));
          }
        });
        this.events.fire({ type: 'approval/requested', backendId: this.id, threadId, approval: request });
      },
      onTimeout: () => {
        this.pendingApprovals.delete(request.id);
        this.publishRefusal(threadId, request, APPROVAL_TIMEOUT_REASON);
        return 'reject';
      },
      onAbort: () => {
        this.pendingApprovals.delete(request.id);
        this.publishRefusal(threadId, request, 'The turn was stopped.');
        return 'reject';
      }
    });
  }

  /**
   * Hold one opencode question until the card is answered or the turn is
   * stopped. There is no timer: Skip on the card is what unblocks a question
   * the user does not want to answer.
   */
  private decideOpencodeQuestion(
    threadId: string,
    ask: OpencodeQuestionAsk,
    signal: AbortSignal
  ): Promise<string[][] | 'reject'> {
    if (signal.aborted) {
      return Promise.resolve('reject');
    }
    const request: QuestionRequest = {
      id: ask.id,
      backendId: this.id,
      threadId,
      questions: ask.questions
    };
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: string[][] | 'reject'): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        this.pendingQuestions.delete(ask.id);
        resolve(value);
      };
      const onAbort = (): void => finish('reject');
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingQuestions.set(ask.id, { threadId, questions: ask.questions, settle: finish });
      this.events.fire({ type: 'question/requested', backendId: this.id, threadId, request });
    });
  }

  private rememberApproval(threadId: string, request: ApprovalRequest, decision: ApprovalDecision): void {
    const scope = ruleScopeFor(decision);
    if (scope === 'none' || !this.approvals) {
      return;
    }
    void this.approvals.addRule(ruleFor(request, this.id), scope, threadId);
  }

  private publishRefusal(threadId: string, request: ApprovalRequest, reason: string): void {
    const subject = describeApproval(request);
    this.events.fire({
      type: 'approval/decided',
      backendId: this.id,
      threadId,
      outcome: { requestId: request.id, decision: 'reject', subject }
    });
    this.events.fire({
      type: 'approval/denied',
      backendId: this.id,
      threadId,
      requestId: request.id,
      subject,
      reason
    });
  }

  /** An approval or a question card is the user, not a stuck runtime. */
  private waitingOnUser(threadId: string): boolean {
    for (const pending of this.pendingApprovals.values()) {
      if (pending.threadId === threadId) {
        return true;
      }
    }
    for (const pending of this.pendingQuestions.values()) {
      if (pending.threadId === threadId) {
        return true;
      }
    }
    return false;
  }

  /**
   * Reset the quiet clock. A command that is still running does not count as
   * silence. A model step, or a tool that has not reached a finished step, is
   * a slow call: the 90s look keeps it until the cap.
   */
  private noteOpencodeActivity(
    event: OpencodeEvent,
    openTools: Set<string>,
    pace: { slowCall: boolean },
    watch: { activity: () => void }
  ): void {
    if (event.kind === 'malformed') {
      return;
    }
    if (event.kind === 'tool') {
      if (event.status === 'pending' || event.status === 'running') {
        openTools.add(event.callId);
      } else {
        openTools.delete(event.callId);
      }
      pace.slowCall = true;
    } else if (event.kind === 'step-start') {
      pace.slowCall = true;
    } else if (event.kind === 'step-finish') {
      pace.slowCall = !isTerminalStepReason(event.reason);
    }
    watch.activity();
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
        if (!event.streaming) {
          this.events.fire({ type: 'item/completed', backendId: this.id, threadId, itemId: event.partId, status: 'completed' });
        }
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
            changes: [
              {
                absPath: isAbsolute(reported.absPath) ? reported.absPath : resolve(cwd, reported.absPath),
                status: reported.status,
                ...(reported.diff ? { diff: reported.diff } : {}),
                ...(reported.replacement ? { replacement: reported.replacement } : {}),
                ...(reported.beforeText !== undefined ? { beforeText: reported.beforeText } : {}),
                ...(reported.afterText !== undefined ? { afterText: reported.afterText } : {})
              }
            ]
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
                tool: event.tool,
                files: event.filePath ? [{ path: event.filePath }] : [],
                text: output
              }
            : {
                id: itemId,
                kind: 'tool',
                title: friendlyToolTitle(event.tool, target),
                tool: event.tool,
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
        return { code: 'unauthenticated', message: `${this.label} token was rejected. It may be expired or revoked.` };
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
   * Summary carried from another provider. Present only when the leading
   * transcript items are the previous chat, which the model must not see again.
   */
  private handoverSummary(threadId: string): string | undefined {
    const ref = this.store?.listThreads(this.id).find((entry) => entry.threadId === threadId);
    if (!ref?.handoverHistoryCount) {
      return undefined;
    }
    const summary = ref.handoverSummary?.trim();
    return summary || undefined;
  }

  /**
   * Emit the failed item + interruption pair that leaves the transcript coherent.
   */
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
    return { code: 'provider', message: `${this.label} request failed.` };
  }

  onEvent(listener: (event: AgentEvent) => void): Disposable {
    return this.events.event(listener);
  }

  dispose(): void {
    this.cancel();
    this.threads.clear();
    this.appliedModes.clear();
    this.events.dispose();
  }
}
