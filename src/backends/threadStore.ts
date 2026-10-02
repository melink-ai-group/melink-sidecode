import * as vscode from 'vscode';
import { PERMISSION_LEVELS, type AgentEvent, type DefaultMode, type PermissionLevel, type TodoStep, type TranscriptItem } from './types';
import { mergeThreadRef } from './threadRef.ts';

/**
 * Persists the small amount of state needed to reconnect after a window reload:
 * the active `{ backendId, threadId, modelId }` reference, a per-workspace
 * thread index so a prior conversation stays reachable, and the rendered
 * transcript items required to repaint it.
 *
 * Credentials never cross this boundary. Every value written here is an
 * identifier, a model selection, or render-ready message text.
 *
 * Writes are debounced: the transcript lives in memory during streaming and is
 * flushed to `workspaceState` shortly after the stream settles, so a token-by-
 * token delta never triggers a storage write.
 */
export interface PersistedThreadRef {
  backendId: string;
  threadId: string;
  /** Model the thread is pinned to, when known. */
  modelId?: string;
  /** Mode the thread runs in, so a resumed thread keeps its mode. */
  mode?: DefaultMode;
  /** First-user-turn excerpt, for the history list. */
  title?: string;
  /** Epoch milliseconds of the last observed activity. */
  updatedAt?: number;
  /**
   * The optional agentic runtime's own session id for this thread, when one has
   * been observed. Persisted here so a later turn in the same thread resumes the
   * runtime session instead of starting a fresh one. Absent on the direct HTTP
   * path, which has no runtime session.
   */
  opencodeSessionId?: string;
}

export interface LastUsedModel {
  backendId: string;
  modelId: string;
}

/**
 * The persistent shape of one thread's plan and its tracked todo steps. Keyed by
 * `backendId:threadId`, so a reload restores the step status rather than
 * resetting progress.
 */
export interface PersistedPlanState {
  /** Workspace-relative path of the plan markdown file. */
  path: string;
  /** Plan title, for the review surface. */
  title: string;
  /** The plan's "what it will do" paragraph, when one was written. */
  summary?: string;
  /** Markdown between the title and the `## Steps` list. */
  body?: string;
  /** The plan's bullet list, with each step's live status. */
  steps: TodoStep[];
  /** True once the plan has been built (the thread moved to execution). */
  built?: boolean;
  /** Epoch milliseconds the plan was last written or updated. */
  updatedAt: number;
}

/** Key set. Centralised so host and adapters never repeat a string literal. */
const ACTIVE_THREAD_KEY = 'melink.activeThread';
const THREAD_INDEX_KEY = 'melink.threadIndex';
const TRANSCRIPTS_KEY = 'melink.transcripts';
const LAST_USED_MODEL_KEY = 'melink.lastUsedModel';
const LAST_PERMISSION_LEVEL_KEY = 'melink.lastPermissionLevel';
const PLANS_KEY = 'melink.plans';

/** Bounds so persisted state cannot grow without limit. */
const MAX_THREADS_PER_BACKEND = 25;
const MAX_ITEMS_PER_TRANSCRIPT = 200;
/** Milliseconds to coalesce transcript writes while a turn streams. */
const FLUSH_DELAY_MS = 750;

type ThreadIndex = Record<string, PersistedThreadRef[]>;
type TranscriptIndex = Record<string, TranscriptItem[]>;
type PlanStateIndex = Record<string, PersistedPlanState>;

/** Workspace-scoped key for a transcript, so backends never collide. */
function transcriptKey(backendId: string, threadId: string): string {
  return `${backendId}:${threadId}`;
}

export class ThreadStore implements vscode.Disposable {
  private transcripts?: TranscriptIndex;
  private threadIndex?: ThreadIndex;
  private plans?: PlanStateIndex;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private readonly dirty = new Set<string>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** The conversation the sidebar should reconnect to on activation. */
  getActiveThread(): PersistedThreadRef | undefined {
    return this.context.workspaceState.get<PersistedThreadRef>(ACTIVE_THREAD_KEY);
  }

  async setActiveThread(ref: PersistedThreadRef): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_THREAD_KEY, ref);
    await this.rememberThread(ref);
  }

  async clearActiveThread(): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_THREAD_KEY, undefined);
  }

  /**
   * Adds or refreshes a thread in the workspace index, so it stays reachable
   * after a reload or a switch to a new conversation.
   */
  async rememberThread(ref: PersistedThreadRef): Promise<void> {
    const index = this.loadThreadIndex();
    const existing = index[ref.backendId] ?? [];
    const previous = existing.find((thread) => thread.threadId === ref.threadId);
    index[ref.backendId] = [mergeThreadRef(previous, ref), ...existing.filter((thread) => thread.threadId !== ref.threadId)].slice(
      0,
      MAX_THREADS_PER_BACKEND
    );
    await this.persistThreadIndex();
  }

  /** Threads this workspace has seen for a backend, newest first. */
  listThreads(backendId: string): PersistedThreadRef[] {
    const index = this.loadThreadIndex();
    return [...(index[backendId] ?? [])].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  /** The persisted runtime session id for a thread, when one is recorded. */
  getOpencodeSession(backendId: string, threadId: string): string | undefined {
    return this.loadThreadIndex()[backendId]?.find((entry) => entry.threadId === threadId)?.opencodeSessionId;
  }

  /**
   * Record the optional agentic runtime's session id for a thread, merging into
   * the existing index entry so the model, mode and title are preserved. An empty
   * value clears the mapping, so a stale session id degrades to a fresh session
   * rather than being reused.
   */
  async setOpencodeSession(backendId: string, threadId: string, sessionId: string | undefined): Promise<void> {
    const index = this.loadThreadIndex();
    const threads = index[backendId] ?? [];
    index[backendId] = threads.map((entry) =>
      entry.threadId === threadId
        ? { ...entry, opencodeSessionId: sessionId || undefined, updatedAt: Date.now() }
        : entry
    );
    await this.persistThreadIndex();
  }

  /**
   * Drop a thread's persisted state — index entry, transcript and plan — so a
   * deleted conversation cannot leave a runtime session mapping behind.
   */
  async forgetThread(backendId: string, threadId: string): Promise<void> {
    const index = this.loadThreadIndex();
    index[backendId] = (index[backendId] ?? []).filter((entry) => entry.threadId !== threadId);
    await this.persistThreadIndex();
    const transcripts = this.loadTranscripts();
    delete transcripts[transcriptKey(backendId, threadId)];
    this.markDirty(transcriptKey(backendId, threadId));
    const plans = this.loadPlans();
    delete plans[transcriptKey(backendId, threadId)];
    await this.context.workspaceState.update(PLANS_KEY, plans);
  }

  getTranscript(backendId: string, threadId: string): TranscriptItem[] {
    const index = this.loadTranscripts();
    const items = index[transcriptKey(backendId, threadId)];
    return Array.isArray(items) ? items : [];
  }

  /**
   * Merge the approval markers this store recorded into a replay that came from
   * a live source. Approval requests are server *requests*, not thread items, so
   * a provider replay never contains them; merging keeps the audit trail and
   * drops any stored card that the replay already accounts for.
   */
  mergeApprovalMarkers(
    backendId: string,
    threadId: string,
    replay: TranscriptItem[]
  ): TranscriptItem[] {
    const stored = this.getTranscript(backendId, threadId).filter(
      (item) =>
        item.kind === 'approval-requested' ||
        item.kind === 'approval-decided' ||
        item.kind === 'approval-denied'
    );
    if (stored.length === 0) {
      return replay;
    }
    const replayedIds = new Set(replay.map((item) => item.id));
    const missing = stored.filter((item) => !replayedIds.has(item.id));
    return missing.length === 0 ? replay : [...replay, ...missing];
  }

  /** Replaces a thread's stored transcript; used when resuming from a live source. */
  setTranscript(backendId: string, threadId: string, items: TranscriptItem[]): void {
    const index = this.loadTranscripts();
    index[transcriptKey(backendId, threadId)] = items.slice(-MAX_ITEMS_PER_TRANSCRIPT);
    this.markDirty(transcriptKey(backendId, threadId));
  }

  /**
   * Appends a local user turn so a reload repaints the prompt the user typed.
   * Returns the created item's id, which is the message id a checkpoint for the
   * turn it opens is addressed by.
   */
  appendUserMessage(backendId: string, threadId: string, text: string, attachments?: TranscriptItem['attachments']): string {
    const stored = this.getTranscript(backendId, threadId);
    const item: TranscriptItem = {
      id: `user_${Date.now()}_${stored.length}`,
      kind: 'message',
      role: 'user',
      text,
      attachments,
      status: 'completed'
    };
    this.setTranscript(backendId, threadId, [...stored, item]);
    return item.id;
  }

  /**
   * Folds a normalized event into the stored transcript so a reload can repaint
   * the conversation. Only item events carry renderable content; turn and error
   * events are transient.
   */
  applyEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'item/started': {
        const stored = this.getTranscript(event.backendId, event.threadId);
        if (stored.some((item) => item.id === event.item.id)) {
          return;
        }
        this.setTranscript(event.backendId, event.threadId, [
          ...stored,
          { ...event.item, text: event.item.text ?? '' }
        ]);
        void this.touchThread(event.backendId, event.threadId);
        break;
      }
      case 'item/delta': {
        const stored = this.getTranscript(event.backendId, event.threadId);
        this.setTranscript(
          event.backendId,
          event.threadId,
          stored.map((item) =>
            item.id === event.itemId ? { ...item, text: (item.text ?? '') + event.delta } : item
          )
        );
        break;
      }
      case 'item/completed': {
        const stored = this.getTranscript(event.backendId, event.threadId);
        this.setTranscript(
          event.backendId,
          event.threadId,
          stored.map((item) => (item.id === event.itemId ? { ...item, status: event.status } : item))
        );
        break;
      }
      case 'approval/requested': {
        // Persist the open request so a reload can repaint one prompt. The
        // `pending` status is what marks it unresolved; nothing here decides it.
        const stored = this.getTranscript(event.backendId, event.threadId);
        if (stored.some((item) => item.id === event.approval.id)) {
          return;
        }
        this.setTranscript(event.backendId, event.threadId, [
          ...stored,
          {
            id: event.approval.id,
            kind: 'approval-requested',
            approval: event.approval,
            text: '',
            status: 'pending'
          }
        ]);
        break;
      }
      case 'approval/decided': {
        // Collapse the card to its resolved marker so a reload keeps the audit
        // trail and never resurrects a settled prompt.
        const denied = event.outcome.decision === 'reject';
        const stored = this.getTranscript(event.backendId, event.threadId);
        this.setTranscript(
          event.backendId,
          event.threadId,
          stored.map((item) =>
            item.id === event.outcome.requestId
              ? {
                  ...item,
                  kind: denied ? 'approval-denied' : 'approval-decided',
                  approvalDecision: event.outcome.decision,
                  status: 'completed'
                }
              : item
          )
        );
        break;
      }
      default:
        return;
    }
  }

  /** Advances a thread's activity timestamp without changing its title/model. */
  private async touchThread(backendId: string, threadId: string): Promise<void> {
    const index = this.loadThreadIndex();
    const threads = index[backendId] ?? [];
    if (!threads.some((entry) => entry.threadId === threadId)) {
      return;
    }
    index[backendId] = threads.map((entry) =>
      entry.threadId === threadId ? { ...entry, updatedAt: Date.now() } : entry
    );
    await this.persistThreadIndex();
  }

  /**
   * The last-used model selection, shared across workspaces so reopening a
   * window reconnects with the same model the user last chose.
   */
  getLastUsedModel(): LastUsedModel | undefined {
    return this.context.globalState.get<LastUsedModel>(LAST_USED_MODEL_KEY);
  }

  async setLastUsedModel(model: LastUsedModel): Promise<void> {
    await this.context.globalState.update(LAST_USED_MODEL_KEY, model);
  }

  /**
   * The permission level last chosen in the picker. Shared across chats and
   * windows, so a new conversation keeps the selection instead of falling back
   * to the settings default. `undefined` when the user has never chosen.
   */
  getLastPermissionLevel(): PermissionLevel | undefined {
    const value = this.context.globalState.get<string>(LAST_PERMISSION_LEVEL_KEY);
    return (PERMISSION_LEVELS as readonly string[]).includes(value ?? '')
      ? (value as PermissionLevel)
      : undefined;
  }

  async setLastPermissionLevel(level: PermissionLevel): Promise<void> {
    await this.context.globalState.update(LAST_PERMISSION_LEVEL_KEY, level);
  }

  /**
   * The persisted plan for a thread, or `undefined` before one exists. A reload
   * reads this to restore the plan's path and its per-step status, so progress
   * is not reset.
   */
  getPlanState(backendId: string, threadId: string): PersistedPlanState | undefined {
    return this.loadPlans()[transcriptKey(backendId, threadId)];
  }

  /**
   * Persist a thread's plan and todo steps. Called after the plan file is
   * written or revised and after any step-status change, so the store is always
   * the durable mirror of the plan artifact.
   */
  async setPlanState(backendId: string, threadId: string, state: PersistedPlanState): Promise<void> {
    const plans = this.loadPlans();
    plans[transcriptKey(backendId, threadId)] = state;
    await this.context.workspaceState.update(PLANS_KEY, plans);
  }

  /** Removes a thread's plan state, e.g. when a plan is rejected and discarded. */
  async clearPlanState(backendId: string, threadId: string): Promise<void> {
    const plans = this.loadPlans();
    delete plans[transcriptKey(backendId, threadId)];
    await this.context.workspaceState.update(PLANS_KEY, plans);
  }

  /** First line of a user turn, used as the history list label. */
  static titleFromText(text: string): string | undefined {
    const line = text.trim().split(/\r?\n/, 1)[0]?.trim();
    if (!line) {
      return undefined;
    }
    return line.length > 60 ? `${line.slice(0, 60)}...` : line;
  }

  private loadThreadIndex(): ThreadIndex {
    if (!this.threadIndex) {
      this.threadIndex = this.context.workspaceState.get<ThreadIndex>(THREAD_INDEX_KEY) ?? {};
    }
    return this.threadIndex;
  }

  private loadTranscripts(): TranscriptIndex {
    if (!this.transcripts) {
      this.transcripts = this.context.workspaceState.get<TranscriptIndex>(TRANSCRIPTS_KEY) ?? {};
    }
    return this.transcripts;
  }

  private loadPlans(): PlanStateIndex {
    if (!this.plans) {
      this.plans = this.context.workspaceState.get<PlanStateIndex>(PLANS_KEY) ?? {};
    }
    return this.plans;
  }

  private async persistThreadIndex(): Promise<void> {
    await this.context.workspaceState.update(THREAD_INDEX_KEY, this.loadThreadIndex());
  }

  private markDirty(key: string): void {
    this.dirty.add(key);
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      void this.flush();
    }, FLUSH_DELAY_MS);
  }

  /** Writes pending transcript changes to storage. Safe to call directly. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.dirty.size === 0) {
      return;
    }
    this.dirty.clear();
    await this.context.workspaceState.update(TRANSCRIPTS_KEY, this.loadTranscripts());
  }

  dispose(): void {
    void this.flush();
  }
}
