import * as vscode from 'vscode';
import { CodexBackend } from './codex';
import { OllamaBackend } from './ollama';
import { ApprovalStore } from './approvalStore';
import { ThreadStore } from './threadStore';
import { ModelSettingsStore } from './modelSettings';
import type { AppDefaults } from './capabilities';
import {
  AgentBackend,
  AgentEvent,
  ApprovalDecision,
  ApprovalRule,
  BackendAvailability,
  BackendError,
  BackendModel,
  DefaultMode,
  Disposable,
  ModelCapabilities,
  ModelSettingField,
  ModelSettingOverrides,
  PermissionLevel,
  QuestionAnswer,
  ResolvedModelSettings,
  ThreadSummary
} from './types';

/**
 * Owns both adapters and publishes a provider-neutral availability snapshot.
 *
 * The UI reads *only* `snapshot()` and `onEvent()`: a backend that fails to
 * initialise is reported as a status, never thrown into a shared handler.
 *
 * It is also the single place capability data and effective per-model settings
 * are resolved, so the UI never touches a provider type: the registry returns
 * the neutral descriptor and the resolved values.
 */
export class BackendRegistry implements Disposable {
  private readonly backends: AgentBackend[];
  private readonly disposables: Disposable[] = [];
  private readonly store: ThreadStore;
  private readonly approvals: ApprovalStore;
  private readonly settings: ModelSettingsStore;
  /**
   * Capability descriptors read from a provider, keyed `providerId:modelId`.
   * Dropped on every refresh so a provider-side change is re-read rather than
   * served from a stale cache.
   */
  private readonly capabilityCache = new Map<string, ModelCapabilities>();
  private availability: BackendAvailability[] = [];

  private readonly availabilityEmitter = new vscode.EventEmitter<BackendAvailability[]>();
  readonly onDidChangeAvailability = this.availabilityEmitter.event;

  private readonly agentEventEmitter = new vscode.EventEmitter<AgentEvent>();
  readonly onEvent = this.agentEventEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.store = new ThreadStore(context);
    this.approvals = new ApprovalStore(context);
    this.settings = new ModelSettingsStore(context.globalState);
    this.backends = [
      new OllamaBackend(context, this.store, this.approvals),
      new CodexBackend(this.store, this.approvals)
    ];
    for (const backend of this.backends) {
      this.disposables.push(
        backend.onEvent((event) => {
          // Record renderable content so a reload can repaint the transcript.
          this.store.applyEvent(event);
          this.agentEventEmitter.fire(event);
          // A rejected credential is availability data, not just a transcript
          // line: re-probe so the picker flips to `unauthenticated` exactly once.
          // The same is true of an API-key-vs-ChatGPT mismatch, which is its own
          // availability state.
          if (event.type === 'error' && (event.code === 'unauthenticated' || event.code === 'auth-mismatch')) {
            void this.refresh();
          }
        })
      );
    }
  }

  /** Durable state shared with the view so it can restore across reloads. */
  get threads(): ThreadStore {
    return this.store;
  }

  /** Per-backend status for the UI. Never throws. */
  snapshot(): BackendAvailability[] {
    return this.availability;
  }

  get(id: string): AgentBackend | undefined {
    return this.backends.find((backend) => backend.id === id);
  }

  /** Threads a backend still offers, preferring the live list. Never throws. */
  async listThreads(id: string): Promise<ThreadSummary[]> {
    const backend = this.get(id);
    if (!backend) {
      return [];
    }
    try {
      return await backend.listThreads();
    } catch {
      return this.store.listThreads(id).map((ref) => ({
        threadId: ref.threadId,
        title: ref.title,
        model: ref.modelId,
        updatedAt: ref.updatedAt
      }));
    }
  }

  /** Re-probes every backend and publishes the resulting snapshot. */
  async refresh(): Promise<BackendAvailability[]> {
    // Capability data is provider-reported, so it is re-read on every refresh
    // rather than cached across one: a model added or changed server-side must
    // show up without a code change.
    this.capabilityCache.clear();
    const results = await Promise.all(this.backends.map((backend) => this.probe(backend)));
    this.availability = results;
    this.availabilityEmitter.fire(this.availability);
    return this.availability;
  }

  /**
   * Probes one backend, converting any failure into availability data.
   * This is the function that guarantees providers fail as data, not throws.
   */
  private async probe(backend: AgentBackend): Promise<BackendAvailability> {
    const base = { id: backend.id, label: backend.label, badge: backend.badge };
    try {
      // Prefer the backend's own richer auth report when it has one: it can name
      // the active auth mode and flag a mismatch (for example an API key where
      // the ChatGPT login was expected) instead of a bare available/signed-out.
      if (backend.authStatus) {
        const report = await backend.authStatus();
        const status = report.status ?? (report.authenticated ? 'available' : 'unauthenticated');
        return {
          ...base,
          status,
          ...(report.detail ? { detail: report.detail } : {}),
          ...(report.authMode ? { authMode: report.authMode } : {})
        };
      }
      const authenticated = await backend.isAuthenticated();
      return authenticated
        ? { ...base, status: 'available' }
        : { ...base, status: 'unauthenticated', detail: 'No usable credential.' };
    } catch (error) {
      if (error instanceof BackendError && error.code === 'unauthenticated') {
        return { ...base, status: 'unauthenticated', detail: error.message };
      }
      if (error instanceof BackendError && error.code === 'incompatible') {
        // A protocol-version drift is its own state, carrying the server's
        // reported version so the UI names the CLI it saw rather than a generic
        // dead backend.
        return { ...base, status: 'incompatible', detail: error.message, version: error.version };
      }
      return {
        ...base,
        status: 'unavailable',
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Lists a backend's models for the switcher. A failure is returned as data
   * (`error`) rather than swallowed, so the picker can show a retry affordance
   * instead of spinning forever on an empty list.
   */
  async listModels(id: string): Promise<{ models: BackendModel[]; error?: string }> {
    const backend = this.get(id);
    if (!backend) {
      return { models: [] };
    }
    try {
      const models = await backend.listModels();
      // Cache each descriptor so a later settings lookup does not re-read the
      // provider. The cache is cleared on every `refresh()`, so it can never
      // outlive the response it was derived from.
      for (const model of models) {
        if (model.capabilities) {
          this.capabilityCache.set(`${id}:${model.id}`, model.capabilities);
        }
      }
      return { models };
    } catch (error) {
      return { models: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Permission levels a backend can actually serve, in presentation order.
   * A backend with no approval channel returns a single level.
   */
  permissionLevels(id: string): readonly PermissionLevel[] {
    return this.get(id)?.permissionLevels ?? [];
  }

  /**
   * The provider-agnostic capability descriptor for one model. Read from the
   * provider on first use and cached until the next `refresh()`, so a burst of
   * per-model reads does not hammer the network while a server-side change is
   * still reflected after a refresh.
   *
   * Returns `undefined` when the provider has no data for the model; the caller
   * then resolves against an all-unknown descriptor rather than a fabricated one.
   * Never throws: a failed read is reported as no capability data.
   */
  async modelCapabilities(providerId: string, modelId: string): Promise<ModelCapabilities | undefined> {
    const key = `${providerId}:${modelId}`;
    const cached = this.capabilityCache.get(key);
    if (cached) {
      return cached;
    }
    const backend = this.get(providerId);
    if (!backend) {
      return undefined;
    }
    try {
      const capabilities = await backend.modelCapabilities(modelId);
      if (capabilities) {
        this.capabilityCache.set(key, capabilities);
      }
      return capabilities;
    } catch {
      return undefined;
    }
  }

  /**
   * Effective settings for one provider+model: user override (from
   * `globalState`) > provider default > app default. The override is clamped
   * against the model's reported range on read, so an out-of-range value is
   * never surfaced or sent.
   */
  async resolveModelSettings(
    providerId: string,
    modelId: string,
    appDefaults?: AppDefaults
  ): Promise<ResolvedModelSettings> {
    const capabilities = await this.modelCapabilities(providerId, modelId);
    return this.settings.resolve(providerId, modelId, capabilities, appDefaults);
  }

  /**
   * Persist a per-model override, clamped against the model's reported range
   * before it is stored, and return the freshly resolved settings.
   */
  async setModelSettings(
    providerId: string,
    modelId: string,
    patch: ModelSettingOverrides
  ): Promise<ResolvedModelSettings> {
    const capabilities = await this.modelCapabilities(providerId, modelId);
    return this.settings.set(providerId, modelId, patch, capabilities);
  }

  /** Clear every override for one model, so provider defaults apply again. */
  async resetModelSettings(providerId: string, modelId: string): Promise<ResolvedModelSettings> {
    await this.settings.clear(providerId, modelId);
    return this.resolveModelSettings(providerId, modelId);
  }

  /** Clear one field's override, so only that control returns to its default. */
  async resetModelSettingField(
    providerId: string,
    modelId: string,
    field: ModelSettingField
  ): Promise<ResolvedModelSettings> {
    await this.settings.clearField(providerId, modelId, field);
    return this.resolveModelSettings(providerId, modelId);
  }

  /**
   * Modes a backend can honour, in presentation order. The UI hides any mode a
   * backend does not list, so a mode that would silently behave like Agent is
   * never shown. An unknown backend reports none.
   */
  modes(id: string): readonly DefaultMode[] {
    return this.get(id)?.modes ?? [];
  }

  /** True when a backend has an approval channel the UI may surface. */
  hasApprovalChannel(id: string): boolean {
    return this.get(id)?.hasApprovalChannel ?? false;
  }

  /** Stored `always` rules for a backend, newest first. Never throws. */
  async listApprovalRules(id: string): Promise<ApprovalRule[]> {
    try {
      return (await this.get(id)?.listApprovalRules()) ?? [];
    } catch {
      return [];
    }
  }

  /** Revokes one stored rule, then re-reads the list so the caller can repaint. */
  async revokeApprovalRule(id: string, ruleId: string): Promise<ApprovalRule[]> {
    await this.get(id)?.revokeApprovalRule(ruleId);
    return this.listApprovalRules(id);
  }

  /**
   * Clears the session-scoped rules for a thread. Called when a conversation
   * ends, so a `session` allow can never leak into a different conversation.
   */
  async endThreadSession(id: string, threadId: string): Promise<void> {
    await this.approvals.clearSession(id, threadId);
  }

  /** Answers a pending approval on the owning backend. Never called on a timer. */
  decideApproval(id: string, threadId: string, requestId: string, decision: ApprovalDecision): void {
    this.get(id)?.decideApproval(threadId, requestId, decision);
  }

  /** Answers a pending clarifying question on the owning backend. */
  answerQuestion(id: string, threadId: string, requestId: string, answers: QuestionAnswer[]): void {
    this.get(id)?.answerQuestion(threadId, requestId, answers);
  }

  /** Aborts the in-flight turn on the given backend, if any. */
  cancel(id: string): void {
    this.get(id)?.cancel();
  }

  dispose(): Promise<void> {
    this.store.dispose();
    this.approvals.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    // Awaited so a caller (extension `deactivate`) can wait for every owned
    // child process to exit before the host goes away.
    const closings = this.backends.map((backend) => Promise.resolve(backend.dispose()));
    this.availabilityEmitter.dispose();
    this.agentEventEmitter.dispose();
    return Promise.all(closings).then(() => undefined);
  }
}
