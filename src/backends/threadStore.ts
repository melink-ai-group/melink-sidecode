import * as vscode from 'vscode';
import { stampTurnWorked } from './turnTiming.ts';
import { mergeTranscriptTool } from './transcriptTool.ts';
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
  /**
   * Summary carried in from another provider. A resumed thread sends it again
   * as standing context, because the destination runtime did not see the
   * earlier turns.
   */
  handoverSummary?: string;
  /**
   * How many leading transcript items were copied from the previous provider
   * so the chat stays on screen. The model receives `handoverSummary` instead
   * of those items.
   */
  handoverHistoryCount?: number;
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
  /**
   * True once a fully completed plan was followed by another user message, so
   * the "Plan complete" row stays hidden after a reload.
   */
  completedDismissed?: boolean;
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
/**
 * How many items `workspaceState` keeps as a fallback. The full transcript is
 * written beside it, under the workspace storage directory, so a long Ollama
 * chat is not cut off at this count when the window reloads.
 */
const MAX_ITEMS_PER_TRANSCRIPT = 200;
const TRANSCRIPT_DIR = 'transcripts';
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
    const key = transcriptKey(backendId, threadId);
    delete transcripts[key];
    this.markDirty(key);
    const file = this.transcriptFile(key);
    if (file) {
      await ignoreFsError(vscode.workspace.fs.delete(file));
    }
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

  /**
   * Every persisted thread, so a send-time snapshot can record each thread's
   * plan and a restore preview can name the other chats.
   */
  listKnownThreads(): { backendId: string; threadId: string; title?: string }[] {
    const index = this.loadThreadIndex();
    const threads: { backendId: string; threadId: string; title?: string }[] = [];
    for (const [backendId, entries] of Object.entries(index)) {
      for (const entry of entries ?? []) {
        threads.push({
          backendId,
          threadId: entry.threadId,
          ...(entry.title ? { title: entry.title } : {})
        });
      }
    }
    return threads;
  }

  /**
   * Drop a user message and everything after it. Returns the transcript as it
   * was, so the caller can put it back. Returns `undefined` when the message
   * is not in the transcript and leaves it unchanged.
   */
  truncateBeforeMessage(backendId: string, threadId: string, messageId: string): TranscriptItem[] | undefined {
    const items = this.getTranscript(backendId, threadId);
    const index = items.findIndex((item) => item.id === messageId);
    if (index === -1) {
      return undefined;
    }
    this.setTranscript(backendId, threadId, items.slice(0, index));
    return items;
  }

  /** Replaces a thread's stored transcript; used when resuming from a live source. */
  setTranscript(backendId: string, threadId: string, items: TranscriptItem[]): void {
    const index = this.loadTranscripts();
    index[transcriptKey(backendId, threadId)] = items.slice();
    this.markDirty(transcriptKey(backendId, threadId));
  }

  /**
   * Load full transcripts from workspace storage. `workspaceState` only keeps
   * a tail, so this must finish before a chat is painted or a flush would
   * write that tail back over the file. A file that is shorter than what is
   * already in memory is left alone.
   */
  async hydrate(): Promise<void> {
    const dir = this.transcriptDirectory();
    if (!dir) {
      return;
    }
    let names: [string, vscode.FileType][];
    try {
      names = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return;
    }
    const index = this.loadTranscripts();
    for (const [name, type] of names) {
      if (type !== vscode.FileType.File || !name.endsWith('.json')) {
        continue;
      }
      const key = decodeURIComponent(name.slice(0, -'.json'.length));
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name));
        const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
        if (!Array.isArray(parsed)) {
          continue;
        }
        const current = index[key] ?? [];
        if (parsed.length < current.length) {
          continue;
        }
        const ids = new Set(parsed.map((item: TranscriptItem) => item?.id));
        const extra = current.filter((item) => item && !ids.has(item.id));
        index[key] = extra.length > 0 ? [...(parsed as TranscriptItem[]), ...extra] : (parsed as TranscriptItem[]);
      } catch {
        // Keep the workspaceState tail when a file cannot be read.
      }
    }
  }

  /**
   * Appends a local user turn so a reload repaints the prompt the user typed.
   * `orchestration` marks an injected continuation so the transcript can render
   * it as its own entry while it still anchors the turn it opens. Returns the
   * created item's id, which is the message id a checkpoint for the turn it
   * opens is addressed by.
   */
  appendUserMessage(
    backendId: string,
    threadId: string,
    text: string,
    attachments?: TranscriptItem['attachments'],
    opensTurn = true,
    sentAt = Date.now(),
    orchestration = false
  ): string {
    const stored = this.getTranscript(backendId, threadId);
    const item: TranscriptItem = {
      id: `user_${sentAt}_${stored.length}`,
      kind: 'message',
      role: 'user',
      text,
      attachments,
      status: 'completed',
      // A steer or a mid-turn answer is not the start of the clock.
      ...(opensTurn ? { sentAt } : {}),
      ...(orchestration ? { orchestration: true } : {})
    };
    this.setTranscript(backendId, threadId, [...stored, item]);
    return item.id;
  }

  /**
   * Folds a normalized event into the stored transcript so a reload can repaint
   * the conversation. Item events carry the rows. A finished or interrupted
   * turn also records how long it ran, on the user message that opened it.
   */
  applyEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'item/started': {
        const stored = this.getTranscript(event.backendId, event.threadId);
        const existing = stored.find((item) => item.id === event.item.id);
        if (existing) {
          // OpenCode repeats a call id as pending, running, then completed.
          // Keep the final file paths/output just as the live renderer does.
          if (existing.kind === 'tool' || existing.kind === 'file-change') {
            this.setTranscript(event.backendId, event.threadId, stored.map((item) =>
              item.id === event.item.id ? mergeTranscriptTool(item, event.item) : item
            ));
          }
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
      case 'turn/completed':
      case 'turn/interrupted': {
        const stored = this.getTranscript(event.backendId, event.threadId);
        const stamped = stampTurnWorked(stored, Date.now());
        if (stamped !== stored) {
          this.setTranscript(event.backendId, event.threadId, stamped);
        }
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
    const dirty = [...this.dirty];
    this.dirty.clear();
    const transcripts = this.loadTranscripts();
    await this.writeTranscriptFiles(dirty, transcripts);
    const tails: TranscriptIndex = {};
    for (const [key, items] of Object.entries(transcripts)) {
      tails[key] = items.slice(-MAX_ITEMS_PER_TRANSCRIPT);
    }
    await this.context.workspaceState.update(TRANSCRIPTS_KEY, tails);
  }

  private transcriptDirectory(): vscode.Uri | undefined {
    const root = this.context.storageUri;
    return root ? vscode.Uri.joinPath(root, TRANSCRIPT_DIR) : undefined;
  }

  private transcriptFile(key: string): vscode.Uri | undefined {
    const dir = this.transcriptDirectory();
    return dir ? vscode.Uri.joinPath(dir, `${encodeURIComponent(key)}.json`) : undefined;
  }

  /** Write the full transcript for each dirty key. A missing storage root keeps the workspaceState tail only. */
  private async writeTranscriptFiles(keys: readonly string[], transcripts: TranscriptIndex): Promise<void> {
    const dir = this.transcriptDirectory();
    if (!dir) {
      return;
    }
    await ignoreFsError(vscode.workspace.fs.createDirectory(dir));
    for (const key of keys) {
      const file = this.transcriptFile(key);
      if (!file) {
        continue;
      }
      const items = transcripts[key];
      if (!items) {
        await ignoreFsError(vscode.workspace.fs.delete(file));
        continue;
      }
      await ignoreFsError(vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(items), 'utf8')));
    }
  }

  dispose(): void {
    void this.flush();
  }
}

/** A missing transcript file is not a failure. The workspaceState tail remains. */
async function ignoreFsError(work: Thenable<void>): Promise<void> {
  try {
    await work;
  } catch {
    return;
  }
}
