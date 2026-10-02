import * as vscode from 'vscode';
import { Emitter } from './base';
import type { ThreadStore } from './threadStore';
import type { ApprovalStore } from './approvalStore';
import {
  AgentBackend,
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRule,
  AuthStatusReport,
  BackendError,
  BackendModel,
  CompactRequest,
  CompactResult,
  ConnectionTestResult,
  DefaultMode,
  Disposable,
  ModelCapabilities,
  PermissionLevel,
  ReportedChange,
  ResumeResult,
  ResumeThreadOptions,
  SendTurnRequest,
  StartThreadOptions,
  ThreadHandle,
  ThreadStatus,
  ThreadSummary,
  TranscriptItem
} from './types';
import { codexCapabilities, codexNativeRequest } from './capabilities';
import { ruleFor, ruleScopeFor, describeApproval } from './approvals';
import { APPROVAL_TIMEOUT_REASON, APPROVAL_WAIT_MS } from './approvalWait';
import { codexPermissionMapping, codexSandboxPolicy, DEFAULT_PERMISSION_LEVEL } from './permissions';
import {
  effectivePermissionLevel,
  isDefaultMode,
  modeForcesReadOnly,
  modeInstructions,
  modeRefusalReason
} from './modes';
import { questionRequestFromToolParams, SKIPPED_ANSWER, type QuestionAnswer } from '../questions';
import { todoStepsFromNative } from './plan';
import { readDefaultMode, readDefaultPermissionLevel } from './defaults';
import { DICTATION_INSTRUCTIONS, dictationText } from '../dictation/prompt';
import { isItemTerminal, translateItem, translateTurnItems } from './appserver/items';
import { itemDeltaFor } from './appserver/deltas';
import {
  changesFromApplyPatch,
  changesFromPatchUpdated,
  changesFromThreadItem
} from './appserver/reportedChanges';
import { logDiagnostic } from './diagnostics';
import { AppServerConnection, ConnectionError } from './appserver/connection';
import { isServerOverloaded, JsonRpcError } from './appserver/jsonrpc';
import {
  authFailureMessage,
  classifyCodexAuthFailure,
  describeCodexAuth
} from './codex/auth';
import type { Thread } from '../../schemas/v2/Thread';
import type { ThreadItem } from '../../schemas/v2/ThreadItem';
import type { Turn } from '../../schemas/v2/Turn';
import type { ThreadStatus as WireThreadStatus } from '../../schemas/v2/ThreadStatus';
import type { UserInput } from '../../schemas/v2/UserInput';
import type { ItemStartedNotification } from '../../schemas/v2/ItemStartedNotification';
import type { ItemCompletedNotification } from '../../schemas/v2/ItemCompletedNotification';
import type { TurnStartedNotification } from '../../schemas/v2/TurnStartedNotification';
import type { TurnCompletedNotification } from '../../schemas/v2/TurnCompletedNotification';
import type { TurnPlanUpdatedNotification } from '../../schemas/v2/TurnPlanUpdatedNotification';
import type { ApplyPatchApprovalParams } from '../../schemas/ApplyPatchApprovalParams';
import type { ThreadStartedNotification } from '../../schemas/v2/ThreadStartedNotification';
import type { ThreadStatusChangedNotification } from '../../schemas/v2/ThreadStatusChangedNotification';
import type { ErrorNotification } from '../../schemas/v2/ErrorNotification';
import type { ThreadTokenUsageUpdatedNotification } from '../../schemas/v2/ThreadTokenUsageUpdatedNotification';
import type { ContextCompactedNotification } from '../../schemas/v2/ContextCompactedNotification';
import { codexContextUsed, finiteTokenCount } from './contextUsage';
import type { FileChangePatchUpdatedNotification } from '../../schemas/v2/FileChangePatchUpdatedNotification';
import type { PermissionsRequestApprovalParams } from '../../schemas/v2/PermissionsRequestApprovalParams';
import type { RequestPermissionProfile } from '../../schemas/v2/RequestPermissionProfile';
import {
  commandDecision,
  fileChangeDecision,
  legacyReviewDecision,
  permissionsResponse,
  translateApprovalRequest
} from './appserver/approvalRequests';

/** A live turn the adapter is currently awaiting. */
interface PendingTurn {
  threadId: string;
  /** Server-assigned turn id, filled from the response or from `turn/started`. */
  turnId?: string;
  /** True when this wait is a compaction rather than a user turn. */
  compact?: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * A server request the adapter is holding open until the user decides. The
 * request is answered exactly once; `settled` guards a double decision.
 */
interface PendingApproval {
  threadId: string;
  requestId: string;
  /** The JSON-RPC request id used to answer the server. */
  rpcId: number;
  request: ApprovalRequest;
  settled: boolean;
  /** True when this request is a `permissions/requestApproval` grant profile. */
  permissions?: RequestPermissionProfile;
  /** Refuses the request when the user has not answered within {@link APPROVAL_WAIT_MS}. */
  timer?: ReturnType<typeof setTimeout>;
}

/** Cap for spawn + handshake, so a wedged server cannot block the sidebar. */
const START_TIMEOUT_MS = 15_000;

/**
 * OpenAI Codex CLI adapter, speaking the `codex app-server` JSON-RPC protocol.
 *
 * `codex app-server` is the same interface the official Codex VS Code extension
 * drives, so cloud features and fast mode survive, unlike shelling out to
 * `codex exec`. The CLI runs as one long-lived child process per workspace; the
 * connection is created lazily on first use and torn down on `dispose()`.
 *
 * A missing binary surfaces as `unavailable` before anything is written, which
 * is what keeps Codex noise out of an Ollama-only sidebar.
 */
export class CodexBackend implements AgentBackend {
  readonly id = 'codex';
  readonly label = 'OpenAI Codex CLI';
  readonly badge = 'Codex';

  /** Codex has a real approval channel. */
  readonly hasApprovalChannel = true;

  /**
   * Levels Codex can serve: `unrestricted` is listed because it is a real Codex
   * mode, but the UI will not let it be selected without the labelled
   * confirmation.
   */
  readonly permissionLevels: readonly PermissionLevel[] = ['read-only', 'default', 'unrestricted'];

  /**
   * Every mode. Codex is the backend that can *enforce* read-only for Ask;
   * Plan follows the selected permission level.
   */
  readonly modes: readonly DefaultMode[] = ['agent', 'plan', 'ask'];

  private readonly events = new Emitter<AgentEvent>();
  private readonly threads = new Set<string>();
  /** Thread ids already announced, so the notification cannot double the event. */
  private readonly announcedThreads = new Set<string>();
  /** Item ids already opened as cards, so a re-sent `item/started` cannot duplicate. */
  private readonly openedItems = new Set<string>();
  /** Server requests held open until the user decides, keyed by request id. */
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingQuestions = new Map<
    string,
    { threadId: string; rpcId: number; questionIds: string[]; settled: boolean }
  >();
  /** The permission level each thread runs at, keyed by thread id. */
  private readonly threadPermissions = new Map<string, PermissionLevel>();
  /** Mode each live thread was started in, so a turn re-applies it. */
  private readonly threadModes = new Map<string, DefaultMode>();
  private connection?: AppServerConnection;
  private connecting?: Promise<AppServerConnection>;
  private pendingTurn?: PendingTurn;
  private disposing?: Promise<void>;
  /** Threads used only to clean a transcript. Their events never reach the chat. */
  private readonly quietThreads = new Set<string>();
  /** Set while `thread/start` for a cleanup turn is in flight, before its id is known. */
  private expectQuietThread = false;
  private quietCapture?: {
    threadId: string;
    text: string;
    settled: boolean;
    resolve: (text: string) => void;
    reject: (error: Error) => void;
  };

  constructor(
    private readonly store?: ThreadStore,
    private readonly approvals?: ApprovalStore
  ) {}

  /**
   * Stored `always` rules. Read-only data: a caller listing them cannot mutate
   * them, and revoking is a separate, explicit call.
   */
  async listApprovalRules(): Promise<ApprovalRule[]> {
    return this.approvals?.listGlobalRules().filter((rule) => rule.backendId === this.id) ?? [];
  }

  /** Removes one stored `always` rule. The host re-reads the list afterwards. */
  async revokeApprovalRule(ruleId: string): Promise<void> {
    await this.approvals?.revokeRule(ruleId);
  }

  /**
   * Answer a pending approval. The map is the single source of truth: a request
   * id that is unknown, or already settled, is ignored, so a double click and a
   * late click after the wait can never answer twice. The only automatic answer
   * is a refusal after {@link APPROVAL_WAIT_MS}, which lets the agent try a
   * different approach instead of leaving the turn blocked.
   */
  answerQuestion(threadId: string, requestId: string, answers: QuestionAnswer[]): void {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending || pending.settled || pending.threadId !== threadId) {
      return;
    }
    pending.settled = true;
    this.pendingQuestions.delete(requestId);
    this.connection?.respond(pending.rpcId, userInputResponse(pending.questionIds, answers));
  }

  decideApproval(threadId: string, requestId: string, decision: ApprovalDecision): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending || pending.settled || pending.threadId !== threadId) {
      return;
    }
    this.clearApprovalTimer(pending);
    pending.settled = true;
    this.pendingApprovals.delete(requestId);
    this.answerApproval(pending, decision);
    const outcome = { requestId, decision, subject: describeApproval(pending.request) };
    // A lasting or session allow becomes a stored rule at the scope it claims;
    // `allow-once` and `reject` store nothing. This happens *before* the
    // decision is announced: `addRule` updates its in-memory rule set
    // synchronously, so any listener that reads the rules while reacting to
    // `approval/decided` (the sidebar refreshing the revocation route) already
    // sees the rule this decision created.
    const scope = ruleScopeFor(decision);
    if (scope !== 'none' && this.approvals) {
      const rule = ruleFor(pending.request, this.id);
      void this.approvals.addRule(rule, scope, threadId);
    }
    this.events.fire({ type: 'approval/decided', backendId: this.id, threadId, outcome });
    if (decision === 'reject') {
      const reason = 'The user denied this request.';
      this.events.fire({ type: 'approval/denied', backendId: this.id, threadId, requestId, subject: outcome.subject, reason });
    }
  }


  private get executable(): string {
    return vscode.workspace.getConfiguration('melink.codex').get<string>('path', 'codex') || 'codex';
  }

  private get defaultModel(): string {
    return vscode.workspace.getConfiguration('melink.codex').get<string>('defaultModel', '');
  }

  private get cwd(): string {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : process.cwd();
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.authStatus()).authenticated;
  }

  /**
   * The CLI's own auth report: whether a credential is usable, the reported
   * auth method, and a distinct status when an API key is in use where the user
   * expects the ChatGPT login. `getAuthStatus` is asked without a token, so no
   * credential value is read, held, or returned.
   */
  async authStatus(): Promise<AuthStatusReport> {
    const connection = await this.connect();
    const status = await connection
      .getAuthStatus({ includeToken: false, refreshToken: false })
      .catch((error: unknown) => this.fail(error));
    const verdict = describeCodexAuth(status);
    if (!verdict.authenticated) {
      return { authenticated: false, detail: verdict.detail };
    }
    // An API key is a usable credential, so `available` would be technically
    // true — but it is not the auth the user chose in Codex, so it is reported
    // as a distinct state that names the mismatch rather than a healthy one.
    if (verdict.apiKeyMode) {
      return {
        authenticated: true,
        status: 'auth-mismatch',
        detail: verdict.detail,
        authMode: verdict.mode ?? undefined
      };
    }
    return { authenticated: true, detail: verdict.detail, authMode: verdict.mode ?? undefined };
  }

  /**
   * The settings screen's on-demand probe: starts the CLI, asks for auth status,
   * and reports login state in plain language. Never throws and never returns a
   * token, a stack, or a raw protocol id.
   */
  async testConnection(): Promise<ConnectionTestResult> {
    let connection: AppServerConnection;
    try {
      connection = await this.connect();
    } catch (error) {
      const failure = this.toBackendError(error);
      if (failure.code === 'unavailable') {
        return {
          backendId: this.id,
          outcome: 'host',
          message: `Could not start the Codex CLI at "${this.executable}". Check the CLI path, then test again.`
        };
      }
      if (failure.code === 'incompatible') {
        // The version is named so the drift is diagnosable rather than a
        // generic "did not answer".
        return {
          backendId: this.id,
          outcome: 'provider',
          message: failure.version
            ? `The Codex CLI reports version ${failure.version}, outside the supported protocol range. Update or re-pin the extension, then test again.`
            : 'The Codex CLI started but did not answer the pinned handshake. Update the CLI or the extension, then test again.'
        };
      }
      return {
        backendId: this.id,
        outcome: 'provider',
        message: 'The Codex CLI started but did not answer. Check the CLI path, then test again.'
      };
    }
    try {
      const status = await connection.getAuthStatus({ includeToken: false, refreshToken: false });
      const verdict = describeCodexAuth(status);
      if (!verdict.authenticated) {
        return {
          backendId: this.id,
          outcome: 'invalid-key',
          message: 'The CLI is installed but not signed in. Sign in with the CLI, then test again.'
        };
      }
      if (verdict.apiKeyMode) {
        // A usable credential, but not the one the user believes they are on:
        // named as such rather than a generic success.
        return {
          backendId: this.id,
          outcome: 'invalid-key',
          message: `${verdict.detail} Re-run the Codex CLI sign-in and remove any API-key setting from the environment, then test again.`
        };
      }
      return {
        backendId: this.id,
        outcome: 'ok',
        message: verdict.detail
      };
    } catch {
      return {
        backendId: this.id,
        outcome: 'provider',
        message: 'The Codex CLI did not report an auth state. Check the CLI path, then test again.'
      };
    }
  }

  async listModels(): Promise<BackendModel[]> {
    const connection = await this.connect();
    const result = await connection.listModels({}).catch((error: unknown) => this.fail(error));
    // The descriptor is built from each model's own generated fields
    // (`supportedReasoningEfforts`, `defaultReasoningEffort`), so a server-side
    // change to a model's reasoning tiers is reflected with no code change.
    return result.data
      .filter((model) => !model.hidden)
      .map((model) => ({
        id: model.id,
        label: model.displayName || model.model,
        description: model.description || undefined,
        capabilities: codexCapabilities(
          {
            supportedReasoningEfforts: model.supportedReasoningEfforts,
            defaultReasoningEffort: model.defaultReasoningEffort
          },
          this.modes
        )
      }));
  }

  /**
   * The capability descriptor for one Codex model, read from the app-server's
   * model list. `undefined` when the model is not currently listed, so the caller
   * degrades to all-unknown rather than guessing.
   */
  async modelCapabilities(modelId: string): Promise<ModelCapabilities | undefined> {
    const models = await this.listModels().catch(() => undefined);
    return models?.find((model) => model.id === modelId)?.capabilities;
  }

  async startThread(options?: StartThreadOptions): Promise<ThreadHandle> {
    const connection = await this.connect();
    const model = options?.model ?? this.defaultModel;
    // An explicit level wins; otherwise the stored default applies, so the
    // settings screen's default is what a new conversation actually uses.
    const requestedLevel = options?.permissionLevel ?? readDefaultPermissionLevel();
    const mode = isDefaultMode(options?.mode) ? options.mode : readDefaultMode();
    // The mode's enforcement runs here, before any wire field is built: Ask is
    // clamped to read-only, while Plan and Agent honor the selected level.
    const level = effectivePermissionLevel(mode, requestedLevel);
    const mapping = codexPermissionMapping(level);
    const response = await connection
      .startThread({
        model: model || null,
        // The workspace root is the thread's cwd, so Codex's own file access and
        // `AGENTS.md` discovery work from the right place. The snapshot service's
        // root wins when the host supplied it; `this.cwd` is only a fallback so a
        // start with no context still has a working directory.
        cwd: options?.context?.workspaceRoot ?? this.cwd,
        // Policy and sandbox come from the shared level mapping: the sandbox is
        // Codex's own enforcement, the approval policy only decides when the
        // user is asked. `never` is reached only for `unrestricted`, and never
        // in Ask mode.
        approvalPolicy: mapping.approvalPolicy,
        // Route every approval to this sidebar. An automatic reviewer would
        // decide without showing a prompt.
        approvalsReviewer: 'user',
        sandbox: mapping.sandbox,
        // The pinned Codex schema exposes a native `developerInstructions` field
        // on `thread/start` (verified against codex-cli 0.156.1 bindings in
        // `schemas/`), so the mode instructions and the rendered project snapshot
        // are delivered natively rather than as a synthetic first turn.
        developerInstructions: combineInstructions(modeInstructions(mode), options?.context?.snapshot) ?? null
      })
      .catch((error: unknown) => this.fail(error));
    const threadId = response.thread.id;
    this.threads.add(threadId);
    this.threadPermissions.set(threadId, requestedLevel);
    this.threadModes.set(threadId, mode);
    const resolvedModel = response.model || model || undefined;
    const handle: ThreadHandle = {
      backendId: this.id,
      threadId,
      model: resolvedModel,
      // The native `developerInstructions` field carried the snapshot, so the
      // host sends only a delta from here on rather than re-sending it.
      contextPrimed: Boolean(options?.context?.snapshot)
    };
    this.announceThread(threadId, resolvedModel);
    return handle;
  }

  /**
   * Reconnects to a thread the app-server has persisted and replays its prior
   * turns. `thread/resume` loads the conversation from Codex's own store, so the
   * replay is authoritative rather than a render-cache approximation.
   *
   * The thread is re-primed through the native `developerInstructions` field on
   * `thread/resume`: the upstream context may be gone after a resume, so the
   * snapshot is sent again rather than assumed to have survived.
   */
  async resumeThread(threadId: string, options?: ResumeThreadOptions): Promise<ResumeResult> {
    const connection = await this.connect();
    const response = await connection
      .resumeThread({
        threadId,
        // Prefer the snapshot service's root as cwd, mirroring `startThread`.
        cwd: options?.context?.workspaceRoot ?? this.cwd,
        developerInstructions: options?.context?.snapshot ?? null,
        approvalsReviewer: 'user'
      })
      .catch((error: unknown) => {
        const failure = this.toBackendError(error);
        if (failure.code === 'provider') {
          throw new BackendError('provider', `Codex thread ${threadId} is no longer available.`);
        }
        throw failure;
      });
    this.threads.add(threadId);
    const model = response.model || undefined;
    this.announceThread(threadId, model);
    return {
      handle: {
        backendId: this.id,
        threadId,
        model,
        // The resume re-primed through the native instructions field.
        contextPrimed: Boolean(options?.context?.snapshot)
      },
      model,
      // Prefer Codex's own turn history; fall back to the render cache only when
      // the server returns no turns (for example an ephemeral thread).
      items: replayTranscript(response.thread, this.store)
    };
  }

  async listThreads(): Promise<ThreadSummary[]> {
    const connection = await this.connect();
    const response = await connection
      .listThreads({ cwd: this.cwd, sortKey: 'updated_at', sortDirection: 'desc', limit: 25 })
      .catch((error: unknown) => this.fail(error));
    return response.data.map((thread) => ({
      threadId: thread.id,
      title: thread.name ?? thread.preview ?? undefined,
      model: thread.model ?? undefined,
      updatedAt: thread.updatedAt * 1000
    }));
  }

  cancel(): void {
    this.refuseOpenQuestions('The turn was stopped.');
    const pending = this.pendingTurn;
    if (pending) {
      this.refuseOpenApprovals(pending.threadId, 'The turn was stopped.');
    }
    const connection = this.connection;
    if (!pending || !connection || !pending.turnId) {
      return;
    }
    // Fire the interrupt; the server answers with a `turn/completed` whose status
    // is `interrupted`, which resolves the turn as canceled. The result is not
    // awaited so `cancel()` stays synchronous, as the interface requires.
    void connection.interruptTurn({ threadId: pending.threadId, turnId: pending.turnId });
  }

  /**
   * Clean a transcript on a throwaway read-only thread. The thread is deleted
   * afterwards and none of its events are shown in the conversation.
   */
  async cleanDictation(model: string, text: string): Promise<string> {
    if (this.pendingTurn) {
      throw new BackendError('provider', 'Codex is busy. The transcript was left in the draft.');
    }
    const selected = model.trim();
    const source = text.trim();
    if (!selected) {
      throw new BackendError('provider', 'Choose a dictation model in Settings.');
    }
    if (!source) {
      throw new BackendError('provider', 'No speech was heard.');
    }
    const connection = await this.connect();
    const mapping = codexPermissionMapping('read-only');
    this.expectQuietThread = true;
    let threadId: string | undefined;
    try {
      const started = await connection
        .startThread({
          model: selected,
          cwd: this.cwd,
          approvalPolicy: mapping.approvalPolicy,
          approvalsReviewer: 'user',
          sandbox: mapping.sandbox,
          developerInstructions: DICTATION_INSTRUCTIONS
        })
        .catch((error: unknown) => this.fail(error));
      threadId = started.thread.id;
      this.quietThreads.add(threadId);
      this.threadModes.set(threadId, 'ask');
      const cleaned = await new Promise<string>((resolve, reject) => {
        this.quietCapture = { threadId: threadId as string, text: '', settled: false, resolve, reject };
        const timer = setTimeout(() => {
          this.finishQuiet(threadId as string, 'failed', 'Dictation cleanup did not finish.');
        }, 90_000);
        void connection
          .startTurn({
            threadId: threadId as string,
            input: [{ type: 'text', text: source, text_elements: [] }],
            model: selected,
            approvalPolicy: mapping.approvalPolicy,
            approvalsReviewer: 'user',
            sandboxPolicy: codexSandboxPolicy('read-only', this.cwd),
            ...codexNativeRequest({ thinking: 'low' })
          })
          .catch((error: unknown) => {
            clearTimeout(timer);
            this.finishQuiet(threadId as string, 'failed', error instanceof Error ? error.message : 'Dictation cleanup failed.');
          });
        const capture = this.quietCapture;
        const settle = (action: () => void) => {
          clearTimeout(timer);
          action();
        };
        const originalResolve = resolve;
        const originalReject = reject;
        capture.resolve = (value) => settle(() => originalResolve(value));
        capture.reject = (error) => settle(() => originalReject(error));
      });
      const text = dictationText(cleaned);
      if (!text) {
        throw new BackendError('provider', 'Dictation cleanup returned nothing.');
      }
      return text;
    } finally {
      this.expectQuietThread = false;
      if (threadId) {
        await connection.deleteThread(threadId).catch(() => undefined);
        this.quietThreads.delete(threadId);
        this.threadModes.delete(threadId);
        if (this.quietCapture?.threadId === threadId) {
          this.quietCapture = undefined;
        }
      }
    }
  }

  async sendTurn(handle: ThreadHandle, request: SendTurnRequest): Promise<void> {
    const connection = await this.connect();
    const model = request.model ?? this.defaultModel;

    // Project context. The pinned Codex app-server (verified against the
    // `schemas/` bindings for codex-cli 0.156.1) exposes native
    // `baseInstructions`/`developerInstructions` only on `thread/start` and
    // `thread/resume`, and no per-turn instructions field on `turn/start`. The
    // snapshot is therefore primed natively at session start and re-primed on
    // resume (see `startThread` / `resumeThread`); mid-thread workspace changes
    // are left to Codex's own file access, which is rooted at the workspace cwd.
    // `request.context.delta` is deliberately unused here: `thread/inject_items`
    // would append to the model-visible history and could resurface on replay,
    // and fabricating a user-role turn would be both wrong and visible. This is
    // a deliberate limitation of the pinned protocol, not an oversight.

    const mode = isDefaultMode(request.mode) ? request.mode : this.threadModes.get(handle.threadId) ?? 'agent';
    this.threadModes.set(handle.threadId, mode);
    // Mode instructions exist on thread/start only. This turn's provider input
    // carries the current mode so a later switch still reaches the model.
    // The stored user message stays `request.text`.
    const input: UserInput[] = [
      {
        type: 'text',
        text: providerTurnText(mode, request.text, request.context?.attachedFile),
        text_elements: []
      }
    ];

    // A level change applies to this turn and subsequent ones, and both the
    // approval policy and the sandbox policy are overridden together so a level
    // can never be half-applied (a new sandbox with a stale prompt policy and
    // vice versa). The request's level wins over the thread's remembered one.
    const requestedLevel =
      request.permissionLevel ?? this.threadPermissions.get(handle.threadId) ?? DEFAULT_PERMISSION_LEVEL;
    const level = effectivePermissionLevel(mode, requestedLevel);
    const mapping = codexPermissionMapping(level);
    if (request.permissionLevel) {
      this.threadPermissions.set(handle.threadId, requestedLevel);
    }

    const turnDone = new Promise<void>((resolve, reject) => {
      this.pendingTurn = { threadId: handle.threadId, resolve, reject };
    });

    let response;
    try {
      response = await connection
        .startTurn({
          threadId: handle.threadId,
          input,
          model: model || null,
          approvalPolicy: mapping.approvalPolicy,
          approvalsReviewer: 'user',
          sandboxPolicy: codexSandboxPolicy(level, this.cwd),
          // The host resolved and clamped the thinking level; the pure,
          // unit-tested `codexNativeRequest` maps it onto Codex's own tier. `off`
          // emits no `effort` key, leaving the model's own default in place.
          ...codexNativeRequest(request.modelSettings)
        })
        .catch((error: unknown) => this.fail(error));
    } catch (error) {
      this.pendingTurn = undefined;
      throw error;
    }
    // Record the turn id so a fast `cancel()` can interrupt before `turn/started`
    // arrives; `turn/started` overwrites it with the same value.
    if (this.pendingTurn) {
      this.pendingTurn.turnId = response.turn.id;
    }
    return turnDone;
  }

  /**
   * Ask the app-server to compact this thread. The call starts a compact turn;
   * this waits until that turn finishes so the host stays busy for the whole
   * shrink. Token-usage notifications during the turn update the ring.
   */
  async compact(handle: ThreadHandle, _request: CompactRequest): Promise<CompactResult> {
    const connection = await this.connect();
    const turnDone = new Promise<void>((resolve, reject) => {
      this.pendingTurn = { threadId: handle.threadId, resolve, reject, compact: true };
    });
    const timer = setTimeout(() => {
      if (this.pendingTurn?.compact && this.pendingTurn.threadId === handle.threadId) {
        const pending = this.pendingTurn;
        this.pendingTurn = undefined;
        pending.reject(new BackendError('provider', 'Compaction did not finish.'));
      }
    }, 120_000);
    try {
      await connection.compactThread({ threadId: handle.threadId }).catch((error: unknown) => this.fail(error));
      await turnDone;
    } catch (error) {
      if (this.pendingTurn?.threadId === handle.threadId && this.pendingTurn.compact) {
        this.pendingTurn = undefined;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return {};
  }

  async steerTurn(handle: ThreadHandle, text: string, clientUserMessageId?: string): Promise<void> {
    const pending = this.pendingTurn;
    if (!pending || pending.threadId !== handle.threadId || !pending.turnId) {
      throw new BackendError('provider', 'There is no active Codex turn to steer.');
    }
    const connection = await this.connect();
    await connection.steerTurn({
      threadId: handle.threadId,
      expectedTurnId: pending.turnId,
      clientUserMessageId,
      input: [{ type: 'text', text, text_elements: [] }]
    });
  }

  onEvent(listener: (event: AgentEvent) => void): Disposable {
    return this.events.event(listener);
  }

  dispose(): Promise<void> {
    // Memoized: VS Code may dispose the registry through `context.subscriptions`
    // as well as through `deactivate`, and both callers must observe the same
    // teardown so the awaited one actually waits for the child to exit.
    if (this.disposing) {
      return this.disposing;
    }
    // Closing stdin, then signalling, then a bounded kill happens inside the
    // connection. Returning that promise lets `deactivate` await a clean exit so
    // no `codex` child outlives the extension host.
    const connection = this.connection;
    const connecting = this.connecting;
    this.connection = undefined;
    const pending = this.pendingTurn;
    this.pendingTurn = undefined;
    pending?.resolve();
    this.threads.clear();
    this.announcedThreads.clear();
    this.openedItems.clear();
    for (const approval of this.pendingApprovals.values()) {
      this.clearApprovalTimer(approval);
    }
    this.pendingApprovals.clear();
    this.threadPermissions.clear();
    this.events.dispose();
    this.disposing = (async () => {
      // A connection that is still starting must be awaited first, or its spawn
      // could land after teardown and be orphaned.
      await connecting?.catch(() => undefined);
      await (connection?.dispose() ?? Promise.resolve());
    })();
    return this.disposing;
  }

  /**
   * Lazily create and initialize the app-server connection. Reuses a live one so
   * a workspace keeps a single child process. Concurrent callers share one spawn:
   * two `connect()` calls must never race into two `codex` processes, one of
   * which would be orphaned. A spawn or handshake failure is normalized to
   * `BackendError('unavailable')`, and the connection is dropped so the next
   * probe retries from scratch.
   */
  private connect(): Promise<AppServerConnection> {
    if (this.connection?.ready) {
      return Promise.resolve(this.connection);
    }
    if (this.connecting) {
      return this.connecting;
    }
    this.connecting = this.openConnection().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async openConnection(): Promise<AppServerConnection> {
    const connection = new AppServerConnection({
      executable: this.executable,
      cwd: this.cwd,
      startTimeoutMs: START_TIMEOUT_MS,
      // Diagnostics only: records which argument form started, so an argument
      // drift is visible rather than falling silently into `unavailable`.
      log: logDiagnostic
    });
    this.connection = connection;
    connection.onNotification((notification) => this.handleNotification(notification));
    connection.onServerRequest((request) => this.handleServerRequest(request));
    connection.onClose((info) => this.handleClose(info.expected));
    try {
      await connection.start();
      return connection;
    } catch (error) {
      this.connection = undefined;
      void connection.dispose();
      this.fail(error);
    }
  }

  /** Normalize any transport failure into a typed `BackendError`, without throwing. */
  private toBackendError(error: unknown): BackendError {
    if (error instanceof BackendError) {
      return error;
    }
    if (error instanceof ConnectionError) {
      if (error.kind === 'unavailable') {
        return new BackendError('unavailable', error.message, error);
      }
      if (error.kind === 'incompatible') {
        // A handshake disagreement or an out-of-range server version is a
        // distinct, diagnosable state carrying the version, never a generic
        // dead backend.
        return new BackendError('incompatible', error.message, error, error.serverVersion);
      }
      return new BackendError('provider', error.message, error);
    }
    if (error instanceof JsonRpcError) {
      // An exhausted overload retry is reported with the documented wording, so
      // the UI stays honest without leaking a raw protocol id.
      if (isServerOverloaded(error)) {
        return new BackendError('provider', 'Codex is overloaded right now. Try again shortly.', error);
      }
      return new BackendError('provider', error.message, error);
    }
    if (error instanceof Error) {
      return new BackendError('provider', error.message, error);
    }
    return new BackendError('provider', String(error));
  }

  /** Normalize and rethrow; used from `.catch()` so the promise rejects typed. */
  private fail(error: unknown): never {
    throw this.toBackendError(error);
  }

  private handleClose(expected: boolean): void {
    if (expected) {
      return;
    }
    // A crash after startup ends any turn and marks the backend unusable so the
    // next probe re-spawns rather than talking to a dead pipe.
    this.connection = undefined;
    const pending = this.pendingTurn;
    this.pendingTurn = undefined;
    pending?.reject(new BackendError('provider', 'The Codex app-server stopped unexpectedly.'));
  }

  /** Emit `thread/started` at most once per thread id for this backend. */
  /** Keep a cleanup thread out of the chat. Returns true when the notification was consumed. */
  private swallowQuiet(method: string, params: unknown): boolean {
    const record = params && typeof params === 'object' ? (params as { threadId?: string; thread?: { id?: string } }) : undefined;
    const threadId = method === 'thread/started' ? record?.thread?.id : record?.threadId;
    if (method === 'thread/started' && this.expectQuietThread && threadId) {
      this.quietThreads.add(threadId);
      return true;
    }
    if (!threadId || !this.quietThreads.has(threadId)) {
      return false;
    }
    if (method === 'item/agentMessage/delta') {
      const delta = itemDeltaFor(method, params);
      if (delta && this.quietCapture?.threadId === threadId) {
        this.quietCapture.text += delta.delta;
      }
    } else if (method === 'turn/completed') {
      const turn = (params as { turn?: { status?: string; error?: { message?: string } } }).turn;
      this.finishQuiet(threadId, turn?.status, turn?.error?.message);
    } else if (method === 'error') {
      const message = (params as { error?: { message?: string } }).error?.message;
      this.finishQuiet(threadId, 'failed', message);
    }
    return true;
  }

  private finishQuiet(threadId: string, status: string | undefined, errorMessage?: string): void {
    const capture = this.quietCapture;
    if (!capture || capture.threadId !== threadId || capture.settled) {
      return;
    }
    capture.settled = true;
    if (status === 'completed') {
      const text = capture.text.trim();
      if (text) {
        capture.resolve(text);
      } else {
        capture.reject(new BackendError('provider', 'Dictation cleanup returned nothing.'));
      }
      return;
    }
    capture.reject(new BackendError('provider', errorMessage || 'Dictation cleanup failed.'));
  }

  private announceThread(threadId: string, model?: string): void {
    if (this.announcedThreads.has(threadId)) {
      return;
    }
    this.announcedThreads.add(threadId);
    this.events.fire({ type: 'thread/started', backendId: this.id, threadId, model });
  }

  private handleNotification(notification: { method: string; params?: unknown }): void {
    const params = notification.params ?? {};
    if (this.swallowQuiet(notification.method, params)) {
      return;
    }
    switch (notification.method) {
      case 'thread/started': {
        const { thread } = params as ThreadStartedNotification;
        this.threads.add(thread.id);
        this.announceThread(thread.id, thread.model ?? undefined);
        break;
      }
      case 'thread/status/changed': {
        const { threadId, status } = params as ThreadStatusChangedNotification;
        this.events.fire({
          type: 'thread/status/changed',
          backendId: this.id,
          threadId,
          status: translateThreadStatus(status)
        });
        break;
      }
      case 'turn/started': {
        const { threadId, turn } = params as TurnStartedNotification;
        if (this.pendingTurn && this.pendingTurn.threadId === threadId) {
          this.pendingTurn.turnId = turn.id;
        }
        this.events.fire({ type: 'turn/started', backendId: this.id, threadId, turnId: turn.id });
        break;
      }
      case 'turn/completed': {
        const { threadId, turn } = params as TurnCompletedNotification;
        this.finishTurn(threadId, turn);
        break;
      }
      case 'turn/plan/updated': {
        // Native plan tracking. The CLI's own bullet list is the source of truth
        // for the todo list, so it is forwarded verbatim through the neutral
        // event stream. This is observation of a real wire notification, not the
        // prompt-plus-policy Plan implementation (which `modes.ts` documents).
        const notification = params as TurnPlanUpdatedNotification;
        this.events.fire({
          type: 'plan/updated',
          backendId: this.id,
          threadId: notification.threadId,
          turnId: notification.turnId,
          explanation: notification.explanation ?? undefined,
          steps: todoStepsFromNative(notification.plan)
        });
        break;
      }
      case 'item/started': {
        const { threadId, item } = params as ItemStartedNotification;
        const { id, item: translated } = translateItem(item);
        this.reportItemChanges(threadId, item);
        if (translated.kind === 'message' && translated.role === 'user') {
          // The webview renders the user's own turn optimistically, so echoing
          // the server's userMessage item here would double it.
          break;
        }
        if (this.openedItems.has(id)) {
          break;
        }
        this.openedItems.add(id);
        this.events.fire({ type: 'item/started', backendId: this.id, threadId, item: translated });
        // A started item can already be terminal on the wire (for example a
        // command that finished before its start notification was flushed), so
        // close it here rather than leaving a card stuck on "Running".
        if (isItemTerminal(item)) {
          this.events.fire({
            type: 'item/completed',
            backendId: this.id,
            threadId,
            itemId: id,
            status: translated.status === 'failed' ? 'failed' : 'completed'
          });
        }
        break;
      }
      case 'item/completed': {
        const { threadId, item } = params as ItemCompletedNotification;
        const { id, item: translated } = translateItem(item);
        this.reportItemChanges(threadId, item);
        if (translated.kind === 'message' && translated.role === 'user') {
          break;
        }
        // Open the card if the matching `item/started` was missed, so content
        // can never land with no card to render it.
        if (!this.openedItems.has(id)) {
          this.openedItems.add(id);
          this.events.fire({ type: 'item/started', backendId: this.id, threadId, item: translated });
        }
        // `item/completed` is the completion signal for every item kind, so the
        // turn can never leave a card stuck on "Running".
        this.events.fire({
          type: 'item/completed',
          backendId: this.id,
          threadId,
          itemId: id,
          status: translated.status === 'failed' ? 'failed' : 'completed'
        });
        break;
      }
      case 'item/agentMessage/delta':
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/commandExecution/outputDelta': {
        // Every streaming delta method is normalized by the pure `deltas.ts`
        // table, so a renamed method is a visible edit there (and a test) rather
        // than a silent empty transcript. `item/agentMessage/delta` is the
        // assistant-message stream the current CLI sends.
        const delta = itemDeltaFor(notification.method, params);
        if (delta) {
          this.fireDelta(delta.threadId, delta.itemId, delta.delta);
        }
        break;
      }
      case 'item/fileChange/patchUpdated': {
        // The current structured edit notification. It carries the file paths an
        // `apply_patch` touched; the content side is recorded for the change
        // journal (the approval path is untouched and unchanged).
        const notification = params as FileChangePatchUpdatedNotification;
        this.reportChanges(notification.threadId, notification.turnId, changesFromPatchUpdated(notification, this.cwd));
        break;
      }
      case 'thread/tokenUsage/updated': {
        const notification = params as ThreadTokenUsageUpdatedNotification;
        const used = codexContextUsed(notification.tokenUsage);
        if (used === undefined) {
          break;
        }
        const windowTokens = finiteTokenCount(notification.tokenUsage.modelContextWindow);
        this.events.fire({
          type: 'context/usage',
          backendId: this.id,
          threadId: notification.threadId,
          usedTokens: used,
          ...(windowTokens ? { windowTokens } : {})
        });
        break;
      }
      case 'thread/compacted': {
        // A compact turn ends on this notification when the server does not
        // also emit `turn/completed`. Either signal releases the waiter.
        const notification = params as ContextCompactedNotification;
        const pending = this.pendingTurn;
        if (pending?.compact && pending.threadId === notification.threadId) {
          this.pendingTurn = undefined;
          pending.resolve();
        }
        break;
      }
      case 'error': {
        const { error, threadId } = params as ErrorNotification;
        this.events.fire({
          type: 'error',
          backendId: this.id,
          threadId,
          message: this.errorMessage(error.message, 'The Codex turn failed.'),
          recoverable: true,
          code: errorCodeFor(error.message)
        });
        break;
      }
      default:
        // Unhandled notification methods are ignored on purpose: a newer Codex
        // release adding a method must not disrupt the transcript.
        break;
    }
  }

  private fireDelta(threadId: string, itemId: string, delta: string): void {
    if (!delta) {
      return;
    }
    this.events.fire({ type: 'item/delta', backendId: this.id, threadId, itemId, delta });
  }

  /**
   * Record the content side of a Codex file-change notification. The event is
   * informational: the approval request still goes to the user exactly as
   * before, and nothing here answers or delays it.
   */
  private reportChanges(threadId: string, turnId: string | undefined, changes: ReportedChange[]): void {
    if (changes.length === 0) {
      return;
    }
    this.events.fire({ type: 'changes/reported', backendId: this.id, threadId, turnId, changes });
  }

  /**
   * Extract file changes from a `fileChange` thread item, which arrives on both
   * `item/started` and `item/completed`. Only that item type carries changes;
   * every other kind is a no-op.
   */
  private reportItemChanges(threadId: string, item: ThreadItem): void {
    if (item.type !== 'fileChange') {
      return;
    }
    this.reportChanges(threadId, undefined, changesFromThreadItem(item.changes, this.cwd));
  }

  /**
   * The message for any Codex error body. A recognized auth-failure body is
   * replaced with its fixed, secret-free sentence; anything else is forwarded
   * unchanged (provider wording, not a credential).
   */
  private errorMessage(message: string | undefined, fallback: string): string {
    const failure = classifyCodexAuthFailure(message);
    return failure ? authFailureMessage(failure) : message ?? fallback;
  }

  /**
   * Map a completed turn to the exact transcript terminal state. `interrupted`
   * (after a user cancel) is distinct from `failed`, and both are distinct from
   * a clean `completed`.
   */
  private finishTurn(threadId: string, turn: Turn): void {
    switch (turn.status) {
      case 'completed':
        this.events.fire({ type: 'turn/completed', backendId: this.id, threadId, turnId: turn.id });
        break;
      case 'interrupted':
        this.events.fire({
          type: 'turn/interrupted',
          backendId: this.id,
          threadId,
          turnId: turn.id,
          reason: 'Response stopped.',
          canceled: true
        });
        break;
      case 'failed':
        this.events.fire({
          type: 'error',
          backendId: this.id,
          threadId,
          // A failed-turn body that names an API-key rejection, a missing
          // credential, or an unrefreshable OAuth session maps to a distinct,
          // secret-free sentence and (for the API-key case) its own code. The
          // raw body is never forwarded: it can carry an `sk-...` fragment.
          message: this.errorMessage(turn.error?.message, 'The Codex turn failed.'),
          recoverable: true,
          code: errorCodeFor(turn.error?.message)
        });
        this.events.fire({ type: 'turn/interrupted', backendId: this.id, threadId, turnId: turn.id });
        break;
      case 'inProgress':
      default:
        return;
    }
    // A user cancel arrives as a normal completion for the pending turn.
    const pending = this.pendingTurn;
    if (pending && pending.threadId === threadId) {
      this.pendingTurn = undefined;
      pending.resolve();
    }
  }

  /**
   * The app-server asks the client to make a decision (an approval). The request
   * is held open and surfaced as a pending decision; the turn stays blocked until
   * `decideApproval` answers or {@link APPROVAL_WAIT_MS} elapses. A timeout
   * refuses the action so the agent can try a different approach. Nothing is
   * allowed automatically except a stored rule the user already chose.
   *
   * A request that is already covered by a stored rule is answered immediately
   * with the same native shape a manual allow would use — that is the *only*
   * automatic path, and it exists solely because the user previously said
   * "always" or "session" for exactly this request.
   */
  private handleServerRequest(request: { id: number; method: string; params?: unknown }): void {
    if (request.method === 'item/tool/requestUserInput') {
      this.handleUserInputRequest(request.id, request.params);
      return;
    }
    const origin = this.cwd;
    const translated = translateApprovalRequest(request.method, request.params, origin);
    if (!translated) {
      // A method we do not know is answered method-not-found rather than left
      // hanging, so an unsupported request can never wedge the server.
      this.connection?.respondError(request.id, -32601, `Unsupported request: ${request.method}`);
      return;
    }
    const { threadId, request: approval } = translated;
    if (this.quietThreads.has(threadId)) {
      this.answerApproval(
        { threadId, requestId: approval.id, rpcId: request.id, request: approval, settled: true },
        'reject'
      );
      return;
    }
    // The legacy apply-patch payload already carries the changed files. Report
    // the content side for the change journal, then continue to present the
    // approval exactly as before: the decision path below is untouched.
    if (request.method === 'applyPatchApproval') {
      this.reportChanges(
        threadId,
        undefined,
        changesFromApplyPatch(request.params as ApplyPatchApprovalParams, origin)
      );
    }
    const pending: PendingApproval = {
      threadId,
      requestId: approval.id,
      rpcId: request.id,
      request: approval,
      settled: false
    };
    if (request.method === 'item/permissions/requestApproval') {
      pending.permissions = (request.params as PermissionsRequestApprovalParams).permissions;
    }

    // Mode enforcement. In Ask mode the agent is asking to escalate past
    // the read-only sandbox, which is the only route to a write. The request is
    // refused outright and the agent is told why, rather than surfaced as a
    // decision card. This precedes the stored-rule match on purpose: a rule
    // saved in Agent mode must not become a write path in Plan or Ask.
    const mode = this.threadModes.get(threadId) ?? 'agent';
    if (modeForcesReadOnly(mode)) {
      const reason = modeRefusalReason(mode);
      pending.settled = true;
      this.answerApproval(pending, 'reject');
      const subject = describeApproval(approval);
      this.events.fire({
        type: 'approval/decided',
        backendId: this.id,
        threadId,
        outcome: { requestId: approval.id, decision: 'reject', subject }
      });
      this.events.fire({
        type: 'approval/denied',
        backendId: this.id,
        threadId,
        requestId: approval.id,
        subject,
        reason
      });
      return;
    }

    // A previously stored rule (session, then global) answers without prompting.
    // The decision mirrors the scope the user originally chose, so a session
    // rule answers `allow-session` and an always rule `allow-always`.
    const matched = this.approvals?.match(this.id, threadId, approval);
    if (matched) {
      const decision: ApprovalDecision = matched.scope === 'session' ? 'allow-session' : 'allow-always';
      pending.settled = true;
      this.answerApproval(pending, decision);
      this.events.fire({
        type: 'approval/decided',
        backendId: this.id,
        threadId,
        outcome: { requestId: approval.id, decision, subject: describeApproval(approval) }
      });
      return;
    }

    this.pendingApprovals.set(approval.id, pending);
    pending.timer = setTimeout(() => {
      this.refuseApproval(pending, APPROVAL_TIMEOUT_REASON);
    }, APPROVAL_WAIT_MS);
    this.events.fire({ type: 'approval/requested', backendId: this.id, threadId, approval });
  }

  /**
   * Hold a Codex user-input request on the same card as a reply fence.
   * Ask mode declines it so the turn is not left waiting.
   */
  private handleUserInputRequest(rpcId: number, params: unknown): void {
    const request = questionRequestFromToolParams(this.id, `input_${rpcId}`, params);
    if (!request) {
      this.connection?.respond(rpcId, { answers: {} });
      return;
    }
    const mode = this.threadModes.get(request.threadId) ?? 'agent';
    const questionIds = request.questions.map((question) => question.id);
    if (mode === 'ask') {
      this.connection?.respond(rpcId, userInputResponse(questionIds, [], modeRefusalReason('ask')));
      return;
    }
    this.pendingQuestions.set(request.id, { threadId: request.threadId, rpcId, questionIds, settled: false });
    this.events.fire({ type: 'question/requested', backendId: this.id, threadId: request.threadId, request });
  }

  /** Unblock every open user-input request so a stopped turn cannot stay hung. */
  private refuseOpenQuestions(reason: string): void {
    for (const [requestId, pending] of [...this.pendingQuestions.entries()]) {
      if (pending.settled) {
        continue;
      }
      pending.settled = true;
      this.pendingQuestions.delete(requestId);
      this.connection?.respond(pending.rpcId, userInputResponse(pending.questionIds, [], reason));
    }
  }

  /** Refuse one still-open approval and tell the agent why. */
  private refuseApproval(pending: PendingApproval, reason: string): void {
    if (pending.settled || !this.pendingApprovals.has(pending.requestId)) {
      return;
    }
    this.clearApprovalTimer(pending);
    pending.settled = true;
    this.pendingApprovals.delete(pending.requestId);
    this.answerApproval(pending, 'reject');
    const subject = describeApproval(pending.request);
    this.events.fire({
      type: 'approval/decided',
      backendId: this.id,
      threadId: pending.threadId,
      outcome: { requestId: pending.requestId, decision: 'reject', subject }
    });
    this.events.fire({
      type: 'approval/denied',
      backendId: this.id,
      threadId: pending.threadId,
      requestId: pending.requestId,
      subject,
      reason
    });
  }

  private refuseOpenApprovals(threadId: string, reason: string): void {
    for (const pending of [...this.pendingApprovals.values()]) {
      if (pending.threadId === threadId) {
        this.refuseApproval(pending, reason);
      }
    }
  }

  private clearApprovalTimer(pending: PendingApproval): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
  }

  /**
   * Send the native decision for a held request exactly once. `allow-session`
   * and `allow-always` map onto the native per-session accept where the protocol
   * offers one, so the CLI does not re-ask within the same session; our stored
   * rule carries the persistence across a reload.
   */
  private answerApproval(pending: PendingApproval, decision: ApprovalDecision): void {
    const connection = this.connection;
    if (!connection) {
      return;
    }
    const rejection = 'The user denied this request.';
    switch (pending.request.method) {
      case 'item/commandExecution/requestApproval': {
        connection.respond(
          pending.rpcId,
          commandDecision(pending.request, decision)
        );
        return;
      }
      case 'item/fileChange/requestApproval': {
        connection.respond(pending.rpcId, fileChangeDecision(pending.request, decision));
        return;
      }
      case 'item/permissions/requestApproval': {
        const profile = pending.permissions ?? { network: null, fileSystem: null };
        connection.respond(pending.rpcId, permissionsResponse(profile, decision));
        return;
      }
      case 'execCommandApproval':
      case 'applyPatchApproval': {
        // The legacy methods answer with a single `ReviewDecision`.
        connection.respond(pending.rpcId, legacyReviewDecision(pending.request, decision, rejection));
        return;
      }
      default:
        return;
    }
  }
}

/**
 * Combine a mode's developer instructions with the rendered project snapshot
 * into the single native `developerInstructions` string.
 *
 * A native instructions field exists on `thread/start` and `thread/resume` in
 * the pinned bindings, so context is delivered natively rather than as a
 * synthetic first turn. Either part may be absent; both absent yields
 * `undefined`, which leaves the CLI default untouched.
 */
/** Provider-only turn text. Mode instructions are not written into the transcript. */
function providerTurnText(mode: DefaultMode, text: string, attachedFile?: string): string {
  const instructions = modeInstructions(mode);
  const parts = [instructions, attachedFile, text].filter(
    (part): part is string => Boolean(part && part.trim().length > 0)
  );
  return parts.join('\n\n');
}

/** One answer string per question id, in the Codex user-input response shape. */
function userInputResponse(
  questionIds: readonly string[],
  answers: readonly QuestionAnswer[],
  fallback = SKIPPED_ANSWER
): { answers: Record<string, { answers: string[] }> } {
  const body: Record<string, { answers: string[] }> = {};
  for (const id of questionIds) {
    const found = answers.find((entry) => entry.questionId === id);
    const text = found?.text.trim() || fallback;
    body[id] = { answers: [text] };
  }
  return { answers: body };
}

function combineInstructions(mode: string | undefined, snapshot: string | undefined): string | undefined {
  const parts = [mode, snapshot].filter((part): part is string => Boolean(part && part.trim().length > 0));
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * Build replay items from the app-server's own turn history, falling back to the
 * render cache when the server returns no turns (for example an ephemeral
 * thread). Historical user messages are skipped: the host persists and repaints
 * those itself, so including them here would double them.
 */
function replayTranscript(thread: Thread, store?: ThreadStore): TranscriptItem[] {
  const fromServer = thread.turns.flatMap((turn) => translateTurnItems(turn.items));
  if (fromServer.length > 0) {
    return fromServer;
  }
  return store?.getTranscript('codex', thread.id) ?? [];
}

/** Normalize the app-server's discriminated `ThreadStatus` union. */
function translateThreadStatus(status: WireThreadStatus): ThreadStatus {
  switch (status.type) {
    case 'idle':
      return 'idle';
    case 'active':
      return 'active';
    case 'systemError':
      return 'systemError';
    case 'notLoaded':
    default:
      return 'notLoaded';
  }
}

/**
 * Best-effort classification of a Codex error message into the UI taxonomy.
 * Provider wording is not trusted for the sentence, only for the category. An
 * `Incorrect API key provided` body is its own category, so the API-key-vs-
 * ChatGPT mismatch is named rather than flattened into a plain sign-out.
 */
function errorCodeFor(message: string | undefined): 'unauthenticated' | 'auth-mismatch' | 'network' | 'provider' {
  if (classifyCodexAuthFailure(message) === 'api-key-mismatch') {
    return 'auth-mismatch';
  }
  const value = (message ?? '').toLowerCase();
  if (value.includes('unauthor') || value.includes('401') || value.includes('login')) {
    return 'unauthenticated';
  }
  if (value.includes('connect') || value.includes('network') || value.includes('timeout')) {
    return 'network';
  }
  return 'provider';
}
