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
  OlderHistoryPage,
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
import { safeModeDecision, storedRuleUnlessAsk } from './safeMode.ts';
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
import { readTrustedCodexExecutable } from '../config/settings.ts';
import { DICTATION_INSTRUCTIONS, dictationText } from '../dictation/prompt';
import {
  COMPACTION_INSTRUCTIONS,
  compactionSource,
  fitCompactionSource,
  instructionsWithHandover
} from './compaction';
import { isItemTerminal, translateItem, translateTurnItems } from './appserver/items';
import { chronological, cursorsAfterPage, historyCursors, nextOlderQuery, type HistoryCursors } from './codex/history.ts';
import { itemDeltaFor } from './appserver/deltas';
import {
  changesFromApplyPatch,
  changesFromPatchUpdated,
  changesFromThreadItem
} from './appserver/reportedChanges';
import { logDiagnostic } from './diagnostics';
import { AppServerConnection, ConnectionError } from './appserver/connection';
import { CODEX_VERSION_VALIDATION_HINT } from './appserver/version';
import { isServerOverloaded, JsonRpcError } from './appserver/jsonrpc';
import {
  authFailureMessage,
  classifyCodexAuthFailure,
  describeCodexAuth
} from './codex/auth';
import { buildCodexTurnInput } from './codex/turnInput';
import { isRetryableCodexFailure } from './codex/turnFailure.ts';
import { isMissingThreadError, recoveryHandover, recoveryInstructions, threadRecoveredNotice } from './threadRecovery';
import { refreshStoredChatgptAuth } from './codex/tokenRefresh';
import { browserCommand } from '../browser/skill.ts';
import { codexBrowserConfig } from '../browser/config.ts';
import type { Thread } from '../../schemas/v2/Thread';
import type { ThreadItem } from '../../schemas/v2/ThreadItem';
import type { Turn } from '../../schemas/v2/Turn';
import type { ThreadStatus as WireThreadStatus } from '../../schemas/v2/ThreadStatus';
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
import type { ChatgptAuthTokensRefreshParams } from '../../schemas/v2/ChatgptAuthTokensRefreshParams';
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
  /**
   * Mode last written into `developerInstructions`. Absent after a resume, which
   * replaces that field with the snapshot alone.
   */
  private readonly bakedMode = new Map<string, DefaultMode>();
  /**
   * Host thread ids whose saved history still contains the Plan-mode developer
   * instruction. A fork keeps that history, so the next Agent turn starts a
   * new thread that does not.
   */
  private readonly needsPlanEscape = new Set<string>();
  /** Host thread id to the Codex thread that actually receives turns. */
  private readonly liveThreads = new Map<string, string>();
  /** Codex thread id back to the host thread id the sidebar is showing. */
  private readonly hostThreads = new Map<string, string>();
  /** Snapshot last written into `developerInstructions`, so a refresh can replace it. */
  private readonly bakedSnapshot = new Map<string, string>();
  /**
   * Replacement thread starts in flight. Their `thread/started` is hidden so the
   * open chat is not given a second conversation. Other chats keep their events.
   */
  private replacementStarts = 0;
  /** Delay native startup announcements until the response identifies its owner. */
  private managedThreadStarts = 0;
  /** Codex thread ids whose lifecycle is hidden until they are mapped onto a chat. */
  private readonly hiddenThreadIds = new Set<string>();
  /** Backwards cursors for a resumed thread, so older turns can load on scroll. */
  private readonly historyCursors = new Map<string, HistoryCursors>();
  private connection?: AppServerConnection;
  private connecting?: Promise<AppServerConnection>;
  /** One waiter per chat. A second tab does not replace the first chat's turn. */
  private readonly pendingTurns = new Map<string, PendingTurn>();
  /**
   * Turn ids already shown as a failure. Codex reports the same limit or
   * provider error on the `error` notification and again on `turn/completed`,
   * and both would otherwise become a banner.
   */
  private readonly reportedFailures = new Set<string>();
  private disposing?: Promise<void>;
  /** Threads used only to clean a transcript. Their events never reach the chat. */
  private readonly quietThreads = new Set<string>();
  /** Set while `thread/start` for a cleanup turn is in flight, before its id is known. */
  private expectQuietThread = false;
  private quietCapture?: {
    threadId: string;
    text: string;
    settled: boolean;
    emptyMessage: string;
    failedMessage: string;
    resolve: (text: string) => void;
    reject: (error: Error) => void;
  };

  constructor(
    private readonly store?: ThreadStore,
    private readonly approvals?: ApprovalStore,
    private readonly allowedVersions: () => readonly string[] = () => []
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


  /**
   * The Codex CLI the app-server child is spawned from.
   *
   * Read from the user's own settings only, so a workspace cannot choose the
   * binary that runs. A relative path with a separator — or a Windows
   * drive-relative path — is refused: it would resolve against the workspace
   * working directory.
   */
  private get executable(): string {
    return readTrustedCodexExecutable();
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
            ? `The Codex CLI reports version ${failure.version}, outside the supported protocol range. ${CODEX_VERSION_VALIDATION_HINT}`
            : `The Codex CLI started but did not answer the pinned handshake. ${CODEX_VERSION_VALIDATION_HINT}`
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

  /**
   * MCP server for the editor browser, when the skill is on.
   * Quiet turns do not call this, so compaction and dictation stay as they are.
   */
  private async browserThreadFields(): Promise<{ config?: { [key: string]: import('../../schemas/serde_json/JsonValue.ts').JsonValue } }> {
    const config = codexBrowserConfig(await browserCommand('codex'));
    return config ? { config } : {};
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
    const browserFields = options?.internalSubagent ? {} : await this.browserThreadFields();
    this.managedThreadStarts += 1;
    const response = await connection
      .startThread({
        ...(options?.internalSubagent ? { ephemeral: true } : {}),
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
        // Mode is not stored here. Codex keeps `developerInstructions` for the
        // life of the loaded thread and ignores a later replacement, so a Plan
        // instruction written at start would still block Build. The snapshot
        // is the only persisted instruction. The mode is sent on each turn.
        developerInstructions: instructionsWithHandover(options?.context?.snapshot, options?.handover),
        // Browser control is one MCP server on the thread. Quiet turns never
        // call this, and an off skill omits the field entirely.
        ...browserFields
      })
      .catch((error: unknown) => this.fail(error))
      .finally(() => { this.managedThreadStarts -= 1; });
    const threadId = response.thread.id;
    if (options?.internalSubagent) {
      this.store?.markInternalThread(this.id, threadId);
    }
    this.hiddenThreadIds.delete(threadId);
    this.threads.add(threadId);
    this.threadPermissions.set(threadId, requestedLevel);
    this.threadModes.set(threadId, mode);
    this.bakedMode.set(threadId, mode);
    this.needsPlanEscape.delete(threadId);
    if (options?.context?.snapshot) {
      this.bakedSnapshot.set(threadId, options.context.snapshot);
    }
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
    let response;
    try {
      response = await connection.resumeThread({
        threadId,
        // Prefer the snapshot service's root as cwd, mirroring `startThread`.
        cwd: options?.context?.workspaceRoot ?? this.cwd,
        developerInstructions: instructionsWithHandover(options?.context?.snapshot, options?.handover),
        approvalsReviewer: 'user',
        ...(await this.browserThreadFields())
      });
    } catch (error) {
      const failure = this.toBackendError(error);
      if (failure.code === 'provider' && isMissingThreadError(failure)) {
        const recovered = await this.rebindMissingThread(connection, threadId, {
          snapshot: options?.context?.snapshot,
          workspaceRoot: options?.context?.workspaceRoot
        });
        if (recovered) {
          return recovered;
        }
        throw new BackendError('provider', `Codex thread ${threadId} is no longer available.`);
      }
      throw failure;
    }
    this.threads.add(threadId);
    // A loaded thread keeps the developer message it was started with. Resume
    // does not remove it, and a fork keeps it in history. An Agent turn starts
    // a new thread only when that Plan text is actually present.
    this.bakedMode.delete(threadId);
    if (carriesPlanInstruction(response.collaborationMode?.settings?.developer_instructions, response.thread)) {
      this.needsPlanEscape.add(threadId);
    } else {
      this.needsPlanEscape.delete(threadId);
    }
    if (options?.context?.snapshot) {
      this.bakedSnapshot.set(threadId, options.context.snapshot);
    } else {
      this.bakedSnapshot.delete(threadId);
    }
    const model = response.model || undefined;
    this.announceThread(threadId, model);
    const cursors = historyCursors(response.itemsBackwardsCursor, response.turnsBackwardsCursor);
    this.historyCursors.set(threadId, cursors);
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
      items: replayTranscript(response.thread, this.store),
      // A paginated thread returns a recent window plus cursors into the rest.
      hasOlderHistory: nextOlderQuery(cursors) !== undefined
    };
  }

  /**
   * The next older page of a resumed thread. Item cursors are followed first:
   * that is the cut that leaves the painted history starting on a reasoning row.
   */
  async loadOlderHistory(threadId: string): Promise<OlderHistoryPage> {
    const connection = await this.connect();
    let cursors = this.historyCursors.get(threadId) ?? historyCursors(null, null);
    const collected: TranscriptItem[] = [];
    for (let attempt = 0; attempt < 3 && collected.length === 0; attempt += 1) {
      const query = nextOlderQuery(cursors);
      if (!query) {
        break;
      }
      if (query.kind === 'items') {
        const page = await connection
          .listItems({ threadId, cursor: query.cursor, limit: query.limit, sortDirection: 'desc' })
          .catch((error: unknown) => this.fail(error));
        collected.push(...chronological(page.data).flatMap((entry) => translateTurnItems([entry.item])));
        cursors = cursorsAfterPage(cursors, 'items', query.cursor, page.nextCursor);
      } else {
        const page = await connection
          .listTurns({
            threadId,
            cursor: query.cursor,
            limit: query.limit,
            sortDirection: 'desc',
            itemsView: 'full'
          })
          .catch((error: unknown) => this.fail(error));
        collected.push(...chronological(page.data).flatMap((turn) => translateTurnItems(turn.items)));
        cursors = cursorsAfterPage(cursors, 'turns', query.cursor, page.nextCursor);
      }
      this.historyCursors.set(threadId, cursors);
    }
    return { items: collected, hasMore: nextOlderQuery(cursors) !== undefined };
  }

  async listThreads(): Promise<ThreadSummary[]> {
    const connection = await this.connect();
    const response = await connection
      .listThreads({ cwd: this.cwd, sortKey: 'updated_at', sortDirection: 'desc', limit: 25 })
      .catch((error: unknown) => this.fail(error));
    return response.data.filter((thread) => !this.store?.isInternalThread(this.id, thread.id)).map((thread) => ({
      threadId: thread.id,
      title: thread.name ?? thread.preview ?? undefined,
      model: thread.model ?? undefined,
      updatedAt: thread.updatedAt * 1000
    }));
  }

  cancel(threadId?: string): void {
    const pending = threadId ? [this.pendingTurns.get(threadId)].filter((turn) => turn !== undefined) : [...this.pendingTurns.values()];
    this.refuseOpenQuestions('The turn was stopped.', threadId);
    for (const turn of pending) {
      this.refuseOpenApprovals(turn.threadId, 'The turn was stopped.');
    }
    const connection = this.connection;
    if (!connection) {
      return;
    }
    // Fire the interrupt; the server answers with a `turn/completed` whose status
    // is `interrupted`, which resolves the turn as canceled. The result is not
    // awaited so `cancel()` stays synchronous, as the interface requires.
    for (const turn of pending) {
      if (!turn.turnId) {
        continue;
      }
      void connection.interruptTurn({ threadId: this.liveThreadId(turn.threadId), turnId: turn.turnId });
    }
  }

  /**
   * Clean a transcript on a throwaway read-only thread. The thread is deleted
   * afterwards and none of its events are shown in the conversation.
   */
  async cleanDictation(model: string, text: string): Promise<string> {
    const selected = model.trim();
    const source = text.trim();
    if (!selected) {
      throw new BackendError('provider', 'Choose a dictation model in Settings.');
    }
    if (!source) {
      throw new BackendError('provider', 'No speech was heard.');
    }
    const cleaned = await this.completeQuiet({
      model: selected,
      instructions: DICTATION_INSTRUCTIONS,
      source,
      emptyMessage: 'Dictation cleanup returned nothing.',
      failedMessage: 'Dictation cleanup failed.',
      timeoutMessage: 'Dictation cleanup did not finish.',
      busyMessage: 'Codex is busy. The transcript was left in the draft.'
    });
    const value = dictationText(cleaned);
    if (!value) {
      throw new BackendError('provider', 'Dictation cleanup returned nothing.');
    }
    return value;
  }

  /**
   * Summarize the stored transcript on a throwaway read-only thread.
   * The open Codex thread is left as it is; the host carries the text onto
   * the next provider.
   */
  async summarize(request: CompactRequest): Promise<string> {
    const model = (request.model ?? this.defaultModel)?.trim();
    if (!model) {
      throw new BackendError('provider', 'No Codex model selected.');
    }
    const source = fitCompactionSource(
      compactionSource(request.transcript),
      request.maxTokens ?? request.modelSettings?.contextWindow
    );
    if (!source.trim()) {
      throw new BackendError('provider', 'There is no conversation to compact.');
    }
    const summary = await this.completeQuiet({
      model,
      instructions: COMPACTION_INSTRUCTIONS,
      source,
      modelSettings: request.modelSettings,
      emptyMessage: 'Compaction did not return a summary.',
      failedMessage: 'Compaction failed.',
      timeoutMessage: 'Compaction did not finish.',
      busyMessage: 'Codex is busy. Stay on this provider until the current request finishes.'
    });
    const text = summary.trim();
    if (!text) {
      throw new BackendError('provider', 'Compaction did not return a summary.');
    }
    return text;
  }

  /**
   * One read-only turn whose reply is returned and never shown in the chat.
   * The thread is deleted afterwards.
   */
  private async completeQuiet(options: {
    model: string;
    instructions: string;
    source: string;
    modelSettings?: CompactRequest['modelSettings'];
    emptyMessage: string;
    failedMessage: string;
    timeoutMessage: string;
    busyMessage: string;
  }): Promise<string> {
    const quietBusy = this.quietCapture;
    if (quietBusy) {
      throw new BackendError('provider', options.busyMessage);
    }
    const connection = await this.connect();
    const mapping = codexPermissionMapping('read-only');
    this.expectQuietThread = true;
    let threadId: string | undefined;
    try {
      const started = await connection
        .startThread({
          model: options.model,
          cwd: this.cwd,
          approvalPolicy: mapping.approvalPolicy,
          approvalsReviewer: 'user',
          sandbox: mapping.sandbox,
          developerInstructions: options.instructions
        })
        .catch((error: unknown) => this.fail(error));
      threadId = started.thread.id;
      this.quietThreads.add(threadId);
      this.threadModes.set(threadId, 'ask');
      return await new Promise<string>((resolve, reject) => {
        this.quietCapture = {
          threadId: threadId as string,
          text: '',
          settled: false,
          emptyMessage: options.emptyMessage,
          failedMessage: options.failedMessage,
          resolve,
          reject
        };
        const timer = setTimeout(() => {
          this.finishQuiet(threadId as string, 'failed', options.timeoutMessage);
        }, 90_000);
        void connection
          .startTurn({
            threadId: threadId as string,
            input: [{ type: 'text', text: options.source, text_elements: [] }],
            model: options.model,
            approvalPolicy: mapping.approvalPolicy,
            approvalsReviewer: 'user',
            sandboxPolicy: codexSandboxPolicy('read-only', this.cwd),
            ...codexNativeRequest(options.modelSettings ?? { thinking: 'low' })
          })
          .catch((error: unknown) => {
            clearTimeout(timer);
            this.finishQuiet(
              threadId as string,
              'failed',
              error instanceof Error ? error.message : options.failedMessage
            );
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
    } finally {
      this.expectQuietThread = false;
      if (threadId) {
        await connection.deleteThread(threadId).catch(() => undefined);
        this.quietThreads.delete(threadId);
        this.threadModes.delete(threadId);
        this.bakedMode.delete(threadId);
        this.bakedSnapshot.delete(threadId);
        if (this.quietCapture?.threadId === threadId) {
          this.quietCapture = undefined;
        }
      }
    }
  }

  async sendTurn(handle: ThreadHandle, request: SendTurnRequest): Promise<void> {
    const connection = await this.connect();
    const model = request.model ?? this.defaultModel;

    // Mode rides on this turn. A resumed thread can still be carrying the Plan
    // developer message in its history. That history is left behind before the
    // turn. The workspace delta, the viewed file, and attachments ride on this
    // turn's provider input. The stored user message stays `request.text`.
    const mode = isDefaultMode(request.mode) ? request.mode : this.threadModes.get(handle.threadId) ?? 'agent';
    const bakedMode = this.bakedMode.get(handle.threadId);
    const nextSnapshot = request.context?.snapshot;
    const requestedLevel =
      request.permissionLevel ?? this.threadPermissions.get(handle.threadId) ?? DEFAULT_PERMISSION_LEVEL;
    const level = effectivePermissionLevel(mode, requestedLevel);
    const mapping = codexPermissionMapping(level);
    if (request.permissionLevel) {
      this.threadPermissions.set(handle.threadId, requestedLevel);
    }
    // Build leaves Plan mode. The saved developer message still forbids
    // implementation, and a fork keeps that message. Start a thread that does not.
    let revokePlan = false;
    if (mode === 'agent' && this.needsPlanEscape.has(handle.threadId)) {
      revokePlan = true;
      try {
        await this.escapePlanInstruction(
          connection,
          handle.threadId,
          model,
          level,
          nextSnapshot ?? this.bakedSnapshot.get(handle.threadId),
          request.context?.workspaceRoot
        );
        this.needsPlanEscape.delete(handle.threadId);
      } catch {
        logDiagnostic('Codex could not leave the Plan-mode instruction.');
      }
    }
    this.bakedMode.set(handle.threadId, mode);
    this.threadModes.set(handle.threadId, mode);
    const input = buildCodexTurnInput({
      mode,
      text: request.text,
      frontendStack: request.context?.frontendStack,
      context: request.context,
      attachments: request.attachments,
      bakedMode,
      revokePlan,
      includeSnapshot: Boolean(request.context?.priming && nextSnapshot)
    });

    if (this.pendingTurns.has(handle.threadId)) {
      throw new BackendError('provider', 'This chat already has a request in progress.');
    }
    let pending: PendingTurn | undefined;
    const turnDone = new Promise<void>((resolve, reject) => {
      pending = { threadId: handle.threadId, resolve, reject };
      this.pendingTurns.set(handle.threadId, pending);
    });

    const start = () =>
      connection
        .startTurn({
          threadId: this.liveThreadId(handle.threadId),
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

    let response;
    try {
      response = await start();
    } catch (error) {
      if (!isMissingThreadError(error)) {
        this.dropPending(handle.threadId, pending);
        throw error;
      }
      const recovered = await this.rebindMissingThread(connection, handle.threadId, {
        snapshot: nextSnapshot ?? this.bakedSnapshot.get(handle.threadId),
        workspaceRoot: request.context?.workspaceRoot,
        model,
        mode,
        permissionLevel: requestedLevel,
        omitTrailingUserText: request.text
      });
      if (!recovered) {
        this.dropPending(handle.threadId, pending);
        throw error;
      }
      this.events.fire({
        type: 'notice',
        backendId: this.id,
        threadId: handle.threadId,
        level: 'info',
        message: threadRecoveredNotice('Codex')
      });
      try {
        response = await start();
      } catch (retryError) {
        this.dropPending(handle.threadId, pending);
        throw retryError;
      }
    }
    // Record the turn id so a fast `cancel()` can interrupt before `turn/started`
    // arrives; `turn/started` overwrites it with the same value.
    const waiting = this.pendingTurns.get(handle.threadId);
    if (waiting && waiting === pending) {
      waiting.turnId = response.turn.id;
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
      this.pendingTurns.set(handle.threadId, { threadId: handle.threadId, resolve, reject, compact: true });
    });
    const timer = setTimeout(() => {
      const pending = this.pendingTurns.get(handle.threadId);
      if (pending?.compact) {
        this.pendingTurns.delete(handle.threadId);
        pending.reject(new BackendError('provider', 'Compaction did not finish.'));
      }
    }, 120_000);
    try {
      await connection.compactThread({ threadId: this.liveThreadId(handle.threadId) }).catch((error: unknown) => this.fail(error));
      await turnDone;
    } catch (error) {
      const pending = this.pendingTurns.get(handle.threadId);
      if (pending?.compact) {
        this.pendingTurns.delete(handle.threadId);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return {};
  }

  async steerTurn(handle: ThreadHandle, text: string, clientUserMessageId?: string): Promise<void> {
    const pending = this.pendingTurns.get(handle.threadId);
    if (!pending?.turnId) {
      throw new BackendError('provider', 'There is no active Codex turn to steer.');
    }
    const connection = await this.connect();
    await connection.steerTurn({
      threadId: this.liveThreadId(handle.threadId),
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
    for (const pending of this.pendingTurns.values()) {
      pending.resolve();
    }
    this.pendingTurns.clear();
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
      allowedVersions: this.allowedVersions(),
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
    const failure = new BackendError('provider', 'The Codex app-server stopped unexpectedly.');
    for (const pending of this.pendingTurns.values()) {
      pending.reject(failure);
    }
    this.pendingTurns.clear();
  }

  /**
   * Accept the first failure report for a turn. Later reports of the same turn
   * — the error notification and the failed `turn/completed` — are dropped.
   */
  private claimTurnFailure(threadId: string, turnId: string | undefined): boolean {
    const key = `${threadId}:${turnId ?? ''}`;
    if (this.reportedFailures.has(key)) {
      return false;
    }
    this.reportedFailures.add(key);
    if (this.reportedFailures.size > 200) {
      const oldest = this.reportedFailures.values().next().value;
      if (oldest !== undefined) {
        this.reportedFailures.delete(oldest);
      }
    }
    return true;
  }

  /** Drop a waiter only when it is still the one this send registered. */
  private dropPending(threadId: string, pending: PendingTurn | undefined): void {
    if (pending && this.pendingTurns.get(threadId) === pending) {
      this.pendingTurns.delete(threadId);
    }
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
      const note = params as { error?: { message?: string }; willRetry?: boolean };
      // A retrying error is not the outcome. The later failed turn, or the
      // error that will not be retried, settles the cleanup.
      if (!note.willRetry) {
        this.finishQuiet(threadId, 'failed', note.error?.message);
      }
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
        capture.reject(new BackendError('provider', capture.emptyMessage));
      }
      return;
    }
    capture.reject(new BackendError('provider', errorMessage || capture.failedMessage));
  }

  private announceThread(threadId: string, model?: string): void {
    if (this.announcedThreads.has(threadId)) {
      return;
    }
    this.announcedThreads.add(threadId);
    this.events.fire({ type: 'thread/started', backendId: this.id, threadId, model });
  }

  private handleNotification(notification: { method: string; params?: unknown }): void {
    const rawThreadId = this.rawThreadId(notification.method, notification.params);
    // thread/started can precede thread/start's response. Announcing here would
    // persist a worker before startThread can mark it internal. Each managed
    // start explicitly announces after receiving and classifying its own id.
    if (notification.method === 'thread/started' && this.managedThreadStarts > 0 && rawThreadId && !this.threads.has(rawThreadId)) {
      return;
    }
    // A replacement thread's own startup must not open a second conversation.
    // Events for every other chat still pass through.
    if (
      notification.method === 'thread/started' &&
      this.replacementStarts > 0 &&
      rawThreadId &&
      !this.hostThreads.has(rawThreadId) &&
      !this.threads.has(rawThreadId)
    ) {
      this.hiddenThreadIds.add(rawThreadId);
      return;
    }
    if (rawThreadId && this.hiddenThreadIds.has(rawThreadId)) {
      return;
    }
    const params = this.retargetParams(notification.params ?? {});
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
        const pending = this.pendingTurns.get(threadId);
        if (pending) {
          pending.turnId = turn.id;
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
        const pending = this.pendingTurns.get(notification.threadId);
        if (pending?.compact) {
          this.pendingTurns.delete(notification.threadId);
          pending.resolve();
        }
        break;
      }
      case 'error': {
        const note = params as ErrorNotification;
        // This arrives while the turn is still open. Codex then completes the
        // turn with the same error, and it may send the notification once per
        // automatic retry. Only the final failure is a banner, and only once.
        // A transient host failure is not a banner at all: the failed
        // `turn/completed` hands it to the automatic continuation, so showing
        // it here would claim the turn stopped before it was retried.
        if (
          note.willRetry ||
          isRetryableCodexFailure(note.error) ||
          !this.claimTurnFailure(note.threadId, note.turnId)
        ) {
          break;
        }
        this.events.fire({
          type: 'error',
          backendId: this.id,
          threadId: note.threadId,
          message: this.errorMessage(note.error.message, 'The Codex turn failed.'),
          recoverable: true,
          code: errorCodeFor(note.error.message)
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
        // A transient host failure (the model host is full, an upstream rate
        // limit, a dropped response stream, an internal server error) is not a
        // finished turn. Codex has already retried it internally by now, so the
        // remaining recovery is the host's own bounded continuation: rejecting
        // the waiter makes `sendTurn` behave exactly like a provider failure
        // that never started, which re-runs the turn instead of leaving a Retry
        // card and a plan that looks stopped. A genuinely terminal failure
        // (usage limit, context window, auth, policy) keeps the banner.
        if (isRetryableCodexFailure(turn.error) && this.pendingTurns.has(threadId)) {
          this.events.fire({ type: 'turn/interrupted', backendId: this.id, threadId, turnId: turn.id });
          const pending = this.pendingTurns.get(threadId);
          if (pending) {
            this.pendingTurns.delete(threadId);
            const failure = new BackendError(
              'provider',
              this.errorMessage(turn.error?.message, 'The Codex turn failed.')
            );
            // The structured kind, not the provider wording, is what allows
            // the host to continue: a newer CLI may reword the message.
            failure.retryable = true;
            pending.reject(failure);
          }
          return;
        }
        // The `error` notification may already have reported this turn. A
        // second event would repeat the same sentence under the reply.
        if (this.claimTurnFailure(threadId, turn.id)) {
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
        }
        this.events.fire({ type: 'turn/interrupted', backendId: this.id, threadId, turnId: turn.id });
        break;
      case 'inProgress':
      default:
        return;
    }
    // A user cancel arrives as a normal completion for the pending turn.
    const pending = this.pendingTurns.get(threadId);
    if (pending) {
      this.pendingTurns.delete(threadId);
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
    const params = this.retargetParams(request.params);
    if (request.method === 'account/chatgptAuthTokens/refresh') {
      void this.handleAuthRefresh(request.id, params);
      return;
    }
    if (request.method === 'item/tool/requestUserInput') {
      this.handleUserInputRequest(request.id, params);
      return;
    }
    const origin = this.cwd;
    const translated = translateApprovalRequest(request.method, params, origin);
    if (!translated) {
      // A method we do not know is answered method-not-found rather than left
      // hanging, so an unsupported request can never wedge the server.
      this.connection?.respondError(request.id, -32601, `Unsupported request: ${request.method}`);
      return;
    }
    const { threadId, request: approval } = translated;
    if (this.quietThreads.has(threadId) || this.store?.isInternalThread(this.id, threadId)) {
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

    // Destructive-command safety runs before stored rules, so an always-allow
    // first-token rule (`git`, `rm`) cannot silently cover a force push, hard
    // reset, recursive delete or database drop. `block` refuses outright;
    // `ask` skips the rule match and surfaces the request with the risk reason.
    const safety = safeModeDecision(approval);
    if (safety.action === 'block') {
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
        reason: safety.reason
      });
      return;
    }
    if (safety.action === 'ask') {
      approval.reason = safety.reason;
    }

    // A previously stored rule (session, then global) answers without prompting.
    // The decision mirrors the scope the user originally chose, so a session
    // rule answers `allow-session` and an always rule `allow-always`. A
    // destructive `ask` deliberately bypasses this lookup.
    const matched = storedRuleUnlessAsk(safety, () => this.approvals?.match(this.id, threadId, approval));
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

  /** Codex thread id on a notification, before it is rewritten onto the host chat. */
  private rawThreadId(method: string, params: unknown): string | undefined {
    if (!params || typeof params !== 'object') {
      return undefined;
    }
    const record = params as { threadId?: string; thread?: { id?: string } };
    return method === 'thread/started' ? record.thread?.id : record.threadId;
  }

  /** The Codex thread that receives turns for a sidebar conversation. */
  private liveThreadId(hostThreadId: string): string {
    return this.liveThreads.get(hostThreadId) ?? hostThreadId;
  }

  /** Map a Codex thread id back to the conversation the sidebar is showing. */
  private hostThreadId(codexThreadId: string): string {
    return this.hostThreads.get(codexThreadId) ?? codexThreadId;
  }

  /**
   * Rewrite thread ids on a server payload so a forked Codex thread stays
   * attached to the conversation the user is looking at.
   */
  private retargetParams(params: unknown): unknown {
    if (!params || typeof params !== 'object') {
      return params;
    }
    const record = { ...(params as Record<string, unknown>) };
    if (typeof record.threadId === 'string') {
      record.threadId = this.hostThreadId(record.threadId);
    }
    if (record.thread && typeof record.thread === 'object') {
      const thread = { ...(record.thread as Record<string, unknown>) };
      if (typeof thread.id === 'string') {
        thread.id = this.hostThreadId(thread.id);
      }
      record.thread = thread;
    }
    return record;
  }

  /**
   * The Codex rollout is gone. Start a new thread for the same sidebar
   * conversation and give it the saved chat, file changes, and remaining work.
   * Events stay on the original thread id, so the open chat does not split.
   */
  private async rebindMissingThread(
    connection: AppServerConnection,
    hostThreadId: string,
    options: {
      snapshot?: string;
      workspaceRoot?: string;
      model?: string;
      mode?: DefaultMode;
      permissionLevel?: PermissionLevel;
      omitTrailingUserText?: string;
    }
  ): Promise<ResumeResult | undefined> {
    const transcript = this.store?.getTranscript(this.id, hostThreadId) ?? [];
    const plan = this.store?.getPlanState(this.id, hostThreadId);
    const handover = recoveryHandover({
      provider: 'Codex',
      transcript,
      plan,
      omitTrailingUserText: options.omitTrailingUserText
    });
    if (!handover) {
      return undefined;
    }
    const ref = this.store?.listThreads(this.id).find((entry) => entry.threadId === hostThreadId);
    const mode = options.mode ?? ref?.mode ?? this.threadModes.get(hostThreadId) ?? 'agent';
    const requestedLevel = options.permissionLevel ?? this.threadPermissions.get(hostThreadId) ?? readDefaultPermissionLevel();
    const level = effectivePermissionLevel(mode, requestedLevel);
    const mapping = codexPermissionMapping(level);
    const model = options.model || ref?.modelId || this.defaultModel || '';
    this.replacementStarts += 1;
    try {
      const response = await connection.startThread({
        model: model || null,
        cwd: options.workspaceRoot ?? this.cwd,
        approvalPolicy: mapping.approvalPolicy,
        approvalsReviewer: 'user',
        sandbox: mapping.sandbox,
        developerInstructions: recoveryInstructions(handover, options.snapshot),
        ...(await this.browserThreadFields())
      });
      const startedId = response.thread.id;
      this.hiddenThreadIds.delete(startedId);
      this.liveThreads.set(hostThreadId, startedId);
      this.hostThreads.set(startedId, hostThreadId);
      this.threads.add(startedId);
      this.threads.add(hostThreadId);
      this.threadPermissions.set(hostThreadId, requestedLevel);
      this.threadModes.set(hostThreadId, mode);
      this.bakedMode.set(hostThreadId, mode);
      this.needsPlanEscape.delete(hostThreadId);
      if (options.snapshot) {
        this.bakedSnapshot.set(hostThreadId, options.snapshot);
      }
      const resolvedModel = response.model || model || undefined;
      return {
        handle: {
          backendId: this.id,
          threadId: hostThreadId,
          model: resolvedModel,
          contextPrimed: Boolean(options.snapshot)
        },
        model: resolvedModel,
        items: transcript,
        hasOlderHistory: false,
        recovered: true
      };
    } catch (error) {
      logDiagnostic('Codex could not continue a missing thread on a new one.');
      logDiagnostic(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      this.replacementStarts -= 1;
    }
  }

  /**
   * Leave a saved Plan-mode developer message by starting a new thread.
   *
   * A fork copies the old history, including the developer message that says
   * not to implement, and Codex does not replace that message. The new thread
   * has only the Agent instruction. Events are translated back to the original
   * thread id so the sidebar conversation stays put.
   */
  private async escapePlanInstruction(
    connection: AppServerConnection,
    hostThreadId: string,
    model: string,
    level: PermissionLevel,
    snapshot: string | undefined,
    cwd?: string
  ): Promise<void> {
    const mapping = codexPermissionMapping(level);
    const instructions = [
      modeInstructions('agent'),
      'The planning phase is finished. Implement the approved plan in the workspace. No instruction prohibits implementation.',
      snapshot
    ]
      .filter((part): part is string => Boolean(part && part.trim().length > 0))
      .join('\n\n');
    this.replacementStarts += 1;
    try {
      const response = await connection.startThread({
        model: model || null,
        cwd: cwd ?? this.cwd,
        approvalPolicy: mapping.approvalPolicy,
        approvalsReviewer: 'user',
        sandbox: mapping.sandbox,
        developerInstructions: instructions,
        ...(await this.browserThreadFields())
      });
      const startedId = response.thread.id;
      this.hiddenThreadIds.delete(startedId);
      this.liveThreads.set(hostThreadId, startedId);
      this.hostThreads.set(startedId, hostThreadId);
      this.threads.add(startedId);
    } finally {
      this.replacementStarts -= 1;
    }
  }

  /**
   * Answer `account/chatgptAuthTokens/refresh` from the CLI's saved ChatGPT
   * login. The request is answered either way, so an expired token cannot
   * leave the turn waiting. The token itself is never logged or shown.
   */
  private async handleAuthRefresh(rpcId: number, params: unknown): Promise<void> {
    const previousAccountId = (params as ChatgptAuthTokensRefreshParams | undefined)?.previousAccountId;
    try {
      const refreshed = await refreshStoredChatgptAuth(previousAccountId);
      this.connection?.respond(rpcId, refreshed);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Codex could not refresh the ChatGPT login.';
      this.connection?.respondError(rpcId, -32000, message);
    }
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

  /** Unblock open user-input requests so a stopped turn cannot stay hung. */
  private refuseOpenQuestions(reason: string, threadId?: string): void {
    for (const [requestId, pending] of [...this.pendingQuestions.entries()]) {
      if (pending.settled || (threadId !== undefined && pending.threadId !== threadId)) {
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

const PLAN_LOCK = 'Do not implement the plan';

/** True when a saved thread still carries the Plan-mode developer text. */
function carriesPlanInstruction(saved: string | null | undefined, thread: Thread): boolean {
  if (saved?.includes(PLAN_LOCK)) {
    return true;
  }
  return JSON.stringify(thread.turns).includes(PLAN_LOCK);
}

/**
 * Build replay items from the app-server's own turn history, falling back to the
 * render cache when the server returns no turns (for example an ephemeral
 * thread). User messages stay in the list: the host overlays its stored ids
 * so a checkpoint still matches, and dropping them left the thread starting
 * at the reasoning row that follows the prompt.
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
