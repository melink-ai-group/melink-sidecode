import * as vscode from 'vscode';
import { isAbsolute, resolve } from 'node:path';
import { createId, Emitter } from './base';
import { OPENCODE_ZEN_TOKEN_SECRET_KEY } from './secrets';
import { ThreadStore } from './threadStore';
import { describeApproval, ruleFor, ruleScopeFor } from './approvals';
import { ApprovalStore } from './approvalStore';
import { APPROVAL_TIMEOUT_REASON, awaitUserDecision } from './approvalWait';
import { approvalFromOpencode, opencodeReplyFor, type OpencodePermissionAsk } from './opencode/approval';
import type { OpencodeQuestionAsk } from './opencode/runtime';
import { SKIPPED_ANSWER, type QuestionAnswer, type QuestionRequest } from '../questions';
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
  ErrorEventCode,
  ModelCapabilities,
  PermissionLevel,
  ResumeResult,
  SendTurnRequest,
  StartThreadOptions,
  ThreadHandle,
  ThreadSummary
} from './types';
import { effectivePermissionLevel, isDefaultMode, modeInstructions } from './modes';
import { isFileTool, isTerminalStepReason, reportedChangeOfTool } from './opencode/events';
import { readOpencodeCliSource, resolveOpencodeExecutable } from './opencode/resolve';
import { probeOpencode } from './opencode/status';
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
import type { OpencodeEvent } from './opencode/events';
import { quietTurnMessage, watchOpencodeQuiet } from './opencode/quiet';
import type { OpencodeOutcome } from './opencode/runtime';
import { fetchZenCatalog } from './opencode/zenCatalog';
import { ProviderTimeoutError } from './probeTimeout';
import { ZEN_API_KEY_ENV, ZEN_BASE_URL } from './opencode/zenConfig';
import { opencodeRequiresApproval } from './opencode/config';

interface CategorizedError {
  code: ErrorEventCode;
  message: string;
}

function opencodePrompt(
  request: SendTurnRequest,
  freshSession: boolean,
  summary?: string,
  recovery?: string
): string {
  const context = request.context;
  const block = freshSession ? context?.snapshot ?? context?.notice : context?.delta ?? context?.notice;
  const mode = isDefaultMode(request.mode) ? request.mode : 'agent';
  const instructions = modeInstructions(mode);
  const preface = !freshSession
    ? undefined
    : recovery?.trim()
      ? recovery.trim()
      : summary
        ? compactionPreface(summary)
        : undefined;
  const parts = [instructions, preface, block, context?.attachedFile, request.text].filter(
    (part): part is string => Boolean(part && part.trim().length > 0)
  );
  return parts.join('\n\n');
}

/**
 * OpenCode Zen provider: free models without a key, paid when a Zen API key is stored.
 * Turns run through the shared OpenCode CLI (same install as Ollama's nested runtime).
 */
export class OpencodeBackend implements AgentBackend {
  readonly id = 'opencode';
  readonly label = 'OpenCode Zen';
  readonly badge = 'OpenCode';
  readonly hasApprovalChannel = true;
  readonly permissionLevels: readonly PermissionLevel[] = ['read-only', 'default', 'unrestricted'];
  readonly modes: readonly DefaultMode[] = ['agent', 'plan', 'ask'];

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
  private readonly flights = new Map<string, AbortController>();
  private readonly steerQueues = new Map<string, string[]>();
  private readonly quietStops = new Set<string>();
  private sideFlight?: AbortController;
  private catalogCache?: { at: number; models: BackendModel[]; includePaid: boolean };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store?: ThreadStore,
    private readonly approvals?: ApprovalStore
  ) {}

  private get opencodePath(): string {
    const config = vscode.workspace.getConfiguration('melink.ollama.opencode');
    return resolveOpencodeExecutable({
      source: readOpencodeCliSource(config.get('cliSource')),
      path: config.get<string>('path', 'opencode') || 'opencode',
      roots: {
        extensionPath: this.context.extensionPath,
        globalStoragePath: this.context.globalStorageUri.fsPath
      }
    });
  }

  private get cwd(): string {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : process.cwd();
  }

  private get defaultModel(): string {
    return vscode.workspace.getConfiguration('melink.opencode').get<string>('defaultModel', '');
  }

  private async token(): Promise<string | undefined> {
    return this.context.secrets.get(OPENCODE_ZEN_TOKEN_SECRET_KEY);
  }

  async listApprovalRules(): Promise<ApprovalRule[]> {
    return this.approvals?.listGlobalRules().filter((rule) => rule.backendId === this.id) ?? [];
  }

  async revokeApprovalRule(ruleId: string): Promise<void> {
    await this.approvals?.revokeRule(ruleId);
  }

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

  /**
   * Available when the OpenCode CLI is present. A Zen key is optional (free models).
   */
  async isAuthenticated(): Promise<boolean> {
    const probe = await probeOpencode(this.opencodePath);
    if (probe.status !== 'detected') {
      throw new BackendError(
        'unavailable',
        'The opencode CLI was not found. Install it under Settings → CLI, then try again.'
      );
    }
    return true;
  }

  async authStatus(): Promise<AuthStatusReport> {
    const probe = await probeOpencode(this.opencodePath);
    if (probe.status !== 'detected') {
      return {
        authenticated: false,
        status: 'unavailable',
        detail: 'The opencode CLI was not found. Install it under Settings → CLI.'
      };
    }
    const token = await this.token();
    if (token) {
      return {
        authenticated: true,
        detail: 'OpenCode Zen API key stored. Free and paid models are available.'
      };
    }
    return {
      authenticated: true,
      detail: 'No Zen API key. Free OpenCode models are available; add a key for paid models.'
    };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const probe = await probeOpencode(this.opencodePath);
    if (probe.status !== 'detected') {
      return {
        backendId: this.id,
        outcome: 'host',
        message: 'The opencode CLI was not found. Install or fix the path under Settings → CLI.'
      };
    }
    try {
      const models = await this.loadCatalog(Boolean(await this.token()));
      if (models.length === 0) {
        return {
          backendId: this.id,
          outcome: 'provider',
          message: 'Connected to the CLI, but no OpenCode Zen models were returned.'
        };
      }
      const token = await this.token();
      return {
        backendId: this.id,
        outcome: 'ok',
        message: token
          ? `OpenCode ready (${models.length} models, Zen key stored).`
          : `OpenCode ready (${models.length} free models). Add a Zen API key for paid models.`
      };
    } catch (error) {
      if (error instanceof ProviderTimeoutError) {
        return {
          backendId: this.id,
          outcome: 'unavailable',
          message: error.message
        };
      }
      return {
        backendId: this.id,
        outcome: 'network',
        message: error instanceof Error ? error.message : 'Could not reach the OpenCode Zen catalog.'
      };
    }
  }

  async listModels(): Promise<BackendModel[]> {
    await this.isAuthenticated();
    return this.loadCatalog(Boolean(await this.token()));
  }

  async modelCapabilities(modelId: string): Promise<ModelCapabilities | undefined> {
    const models = await this.loadCatalog(Boolean(await this.token()));
    return models.find((model) => model.id === modelId)?.capabilities;
  }

  private async loadCatalog(includePaid: boolean): Promise<BackendModel[]> {
    const now = Date.now();
    if (
      this.catalogCache &&
      this.catalogCache.includePaid === includePaid &&
      now - this.catalogCache.at < 60_000
    ) {
      return this.catalogCache.models;
    }
    const models = await fetchZenCatalog({ includePaid });
    this.catalogCache = { at: now, models, includePaid };
    return models;
  }

  async startThread(options?: StartThreadOptions): Promise<ThreadHandle> {
    const threadId = createId('opencode_thread');
    this.threads.add(threadId);
    const model = options?.model ?? this.defaultModel;
    const handle: ThreadHandle = { backendId: this.id, threadId, model: model || undefined };
    this.events.fire({ type: 'thread/started', backendId: this.id, threadId, model: model || undefined });
    return handle;
  }

  async resumeThread(threadId: string): Promise<ResumeResult> {
    const ref = this.store?.listThreads(this.id).find((entry) => entry.threadId === threadId);
    if (!this.threads.has(threadId) && !ref) {
      throw new BackendError('provider', `OpenCode thread ${threadId} is no longer available.`);
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

  async compact(handle: ThreadHandle, request: CompactRequest): Promise<CompactResult> {
    const summary = await this.summarize(request);
    await this.store?.setOpencodeSession(this.id, handle.threadId, undefined);
    return { transcript: compactedTranscript(summary) };
  }

  async summarize(request: CompactRequest): Promise<string> {
    const model = request.model ?? this.defaultModel;
    if (!model) {
      throw new BackendError('provider', 'No OpenCode Zen model selected.');
    }
    const models = await this.loadCatalog(Boolean(await this.token()));
    const entry = models.find((item) => item.id === model);
    const hasToken = Boolean(await this.token());
    if (!entry) {
      throw new BackendError(
        hasToken ? 'provider' : 'unauthenticated',
        hasToken
          ? `OpenCode Zen no longer reports the model "${model}".`
          : 'That model needs an OpenCode Zen API key. Add one in Settings, or pick a free model.'
      );
    }
    if (!entry.free && !hasToken) {
      throw new BackendError(
        'unauthenticated',
        'That model needs an OpenCode Zen API key. Add one in Settings, or pick a free model.'
      );
    }
    const source = fitCompactionSource(
      compactionSource(request.transcript),
      request.maxTokens ?? request.modelSettings?.contextWindow
    );
    if (!source.trim()) {
      throw new BackendError('provider', 'There is no conversation to compact.');
    }

    const token = (await this.token()) ?? '';
    const controller = new AbortController();
    this.sideFlight = controller;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const response = await fetch(`${ZEN_BASE_URL}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            { role: 'system', content: COMPACTION_INSTRUCTIONS },
            { role: 'user', content: source }
          ]
        })
      });
      if (response.status === 401 || response.status === 403) {
        throw new BackendError('unauthenticated', 'Your OpenCode Zen API key was rejected.');
      }
      if (!response.ok) {
        throw new BackendError('provider', `OpenCode Zen returned ${response.status} during compaction.`);
      }
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };
      if (body.error?.message) {
        throw new BackendError('provider', body.error.message);
      }
      const summary = body.choices?.[0]?.message?.content?.trim() ?? '';
      if (!summary) {
        throw new BackendError('provider', 'Compaction did not return a summary.');
      }
      return summary;
    } catch (error) {
      if (error instanceof BackendError) {
        throw error;
      }
      if ((error as { name?: string }).name === 'AbortError') {
        throw new BackendError('provider', 'Compaction canceled.');
      }
      throw new BackendError(
        'provider',
        error instanceof Error ? error.message : 'OpenCode Zen compaction failed.'
      );
    } finally {
      if (this.sideFlight === controller) {
        this.sideFlight = undefined;
      }
    }
  }

  async sendTurn(handle: ThreadHandle, request: SendTurnRequest): Promise<void> {
    await this.isAuthenticated();
    const token = (await this.token()) ?? '';
    const turnId = createId('opencode_turn');
    const model = request.model ?? this.defaultModel;
    this.events.fire({ type: 'turn/started', backendId: this.id, threadId: handle.threadId, turnId });
    if (!model) {
      const failure = new BackendError('provider', 'No OpenCode Zen model selected.');
      this.events.fire({
        type: 'turn/interrupted',
        backendId: this.id,
        threadId: handle.threadId,
        turnId,
        reason: failure.message
      });
      throw failure;
    }

    const permissionLevel: PermissionLevel = effectivePermissionLevel(
      request.mode ?? 'agent',
      request.permissionLevel ?? 'default'
    );

    let models: BackendModel[];
    try {
      models = await this.loadCatalog(Boolean(token));
    } catch (error) {
      this.failTurn(handle, '', turnId, this.categorize(error));
      throw error;
    }
    const selected = models.find((entry) => entry.id === model);
    if (!selected) {
      const failure = new BackendError(
        token ? 'provider' : 'unauthenticated',
        token
          ? `OpenCode Zen no longer reports the model "${model}".`
          : 'That model needs an OpenCode Zen API key. Add one in Settings, or pick a free model.'
      );
      this.failTurn(handle, '', turnId, this.categorize(failure));
      throw failure;
    }
    if (!selected.free && !token) {
      const failure = new BackendError(
        'unauthenticated',
        'That model needs an OpenCode Zen API key. Add one in Settings, or pick a free model.'
      );
      this.failTurn(handle, '', turnId, this.categorize(failure));
      throw failure;
    }

    const { buildZenOpencodeConfig } = await import('./opencode/zenConfig.ts');
    const { runOpencodeTurn } = await import('./opencode/runtime.ts');
    const { browserCommand } = await import('../browser/skill.ts');
    const browser = await browserCommand('opencode');
    const { skillMcpForOpencodeTurn } = await import('../skills/resolveForTurn.ts');
    const skills = await skillMcpForOpencodeTurn({
      extensionPath: this.context.extensionPath,
      globalStoragePath: this.context.globalStorageUri.fsPath
    });
    const capabilities = selected.capabilities;

    const built = buildZenOpencodeConfig({
      modelIds: models.map((entry) => entry.id),
      modelId: model,
      settings: request.modelSettings,
      capabilities,
      mode: request.mode ?? 'agent',
      permissionLevel,
      ...(browser ? { browser } : {}),
      ...(skills.mcp ? { skillMcp: skills.mcp } : {}),
      ...(Object.keys(skills.permissions).length > 0 ? { skillPermissions: skills.permissions } : {})
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
    let sessionId = this.store?.getOpencodeSession(this.id, handle.threadId);
    const summary =
      this.handoverSummary(handle.threadId) ??
      compactedSummary(this.store?.getTranscript(this.id, handle.threadId) ?? []);
    let visibleText = request.text;
    let barePrompt = false;
    let recovery: string | undefined;
    const opencodeCwd = request.context?.workspaceRoot ?? this.cwd;

    const promptFor = (): string =>
      barePrompt
        ? visibleText
        : opencodePrompt(
            { ...request, text: visibleText },
            !sessionId,
            !sessionId && !recovery ? summary : undefined,
            !sessionId ? recovery : undefined
          );

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
              cwd: opencodeCwd,
              config: built.config,
              modelRef: built.modelRef,
              agent: built.agent,
              prompt,
              sessionId: resumeId,
              token,
              apiKeyEnv: ZEN_API_KEY_ENV,
              signal: controller.signal,
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
          result.outcome === 'canceled' || result.outcome === 'completed'
            ? this.drainSteers(handle.threadId)
            : undefined;
        const quiet = this.quietStops.delete(handle.threadId);
        if (next) {
          if (sessionId) {
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
          await this.store?.setOpencodeSession(this.id, handle.threadId, undefined);
          this.failTurn(handle, '', turnId, {
            code: 'provider',
            message: 'The opencode session could not be started or resumed.'
          });
          throw new BackendError('provider', 'The opencode session could not be started or resumed.');
        }
        if (result.outcome === 'permission') {
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

  private decideOpencodePermission(
    threadId: string,
    ask: OpencodePermissionAsk,
    signal: AbortSignal
  ): Promise<'once' | 'always' | 'reject'> {
    const request = approvalFromOpencode(ask, this.cwd);
    const matched = this.approvals?.match(this.id, threadId, request);
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
    return new Promise((resolvePromise) => {
      let settled = false;
      const finish = (value: string[][] | 'reject'): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        this.pendingQuestions.delete(ask.id);
        resolvePromise(value);
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

  private handleOpencodeEvent(event: OpencodeEvent, threadId: string, cwd: string): void {
    switch (event.kind) {
      case 'text':
        this.events.fire({
          type: 'item/started',
          backendId: this.id,
          threadId,
          item: { id: event.partId, kind: 'message', role: 'assistant' }
        });
        this.events.fire({ type: 'item/delta', backendId: this.id, threadId, itemId: event.partId, delta: event.text });
        this.events.fire({
          type: 'item/completed',
          backendId: this.id,
          threadId,
          itemId: event.partId,
          status: 'completed'
        });
        break;
      case 'reasoning':
        this.events.fire({
          type: 'item/started',
          backendId: this.id,
          threadId,
          item: { id: event.partId, kind: 'reasoning', role: 'assistant', title: 'Reasoning' }
        });
        this.events.fire({ type: 'item/delta', backendId: this.id, threadId, itemId: event.partId, delta: event.text });
        this.events.fire({
          type: 'item/completed',
          backendId: this.id,
          threadId,
          itemId: event.partId,
          status: 'completed'
        });
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

  private opencodeFailure(outcome: OpencodeOutcome, detail?: string): CategorizedError {
    switch (outcome) {
      case 'cli-missing':
        return {
          code: 'cli-missing',
          message:
            'The opencode CLI was not found. Install it under Settings → CLI, then try again.'
        };
      case 'spawn':
        return { code: 'spawn', message: detail ?? 'The opencode CLI could not be started.' };
      case 'invalid-config':
        return { code: 'invalid-config', message: 'The generated opencode config was rejected. Nothing was sent.' };
      case 'unauthenticated':
        return {
          code: 'unauthenticated',
          message: 'Your OpenCode Zen API key was rejected. It may be expired or revoked.'
        };
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

  private handoverSummary(threadId: string): string | undefined {
    const ref = this.store?.listThreads(this.id).find((entry) => entry.threadId === threadId);
    if (!ref?.handoverHistoryCount) {
      return undefined;
    }
    const summary = ref.handoverSummary?.trim();
    return summary || undefined;
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

  private drainSteers(threadId: string): string | undefined {
    const queued = this.steerQueues.get(threadId);
    if (!queued || queued.length === 0) {
      return undefined;
    }
    this.steerQueues.delete(threadId);
    return queued.join('\n\n');
  }

  private failTurn(handle: ThreadHandle, itemId: string, turnId: string, error: CategorizedError): void {
    if (error.code === 'canceled') {
      this.events.fire({
        type: 'item/completed',
        backendId: this.id,
        threadId: handle.threadId,
        itemId,
        status: 'completed'
      });
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
    this.events.fire({
      type: 'item/completed',
      backendId: this.id,
      threadId: handle.threadId,
      itemId,
      status: 'failed'
    });
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

  private categorize(error: unknown): CategorizedError {
    if (error instanceof BackendError) {
      if (error.code === 'unauthenticated') {
        return { code: 'unauthenticated', message: error.message };
      }
      if (error.code === 'unavailable') {
        return { code: 'network', message: error.message };
      }
      return { code: 'provider', message: error.message };
    }
    return { code: 'provider', message: 'OpenCode Zen request failed.' };
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
