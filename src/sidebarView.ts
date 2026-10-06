import * as vscode from 'vscode';
import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BackendRegistry } from './backends/registry';
import { OllamaBackend } from './backends/ollama';
import { CodexBackend } from './backends/codex';
import { DictationController } from './dictation/controller';
import { parseDictationTarget } from './dictation/target';
import { OLLAMA_TOKEN_SECRET_KEY } from './backends/secrets';
import { SettingsService } from './settings';
import { PlanStore } from './planStore';
import { ThreadStore, type PersistedPlanState } from './backends/threadStore';
import {
  BackendError,
  denyInProgressStep,
  settleInProgressSteps,
  type ApprovalRequest,
  type Attachment,
  type AttachmentKind,
  type DefaultMode,
  type PermissionLevel,
  type PlanArtifact,
  type ThreadHandle,
  type TodoStep,
  type TodoStepStatus,
  type TranscriptItem
} from './backends/types';
import { permissionDescriptor } from './backends/permissions';
import { modeDescriptor, supportedModes } from './backends/modes';
import {
  extractSidecodeQuestions,
  formatQuestionAnswers,
  planDecisionLines,
  planUpdateFromAnswers,
  type QuestionAnswer,
  type QuestionRequest
} from './questions';
import { overridesFromResolved } from './backends/capabilities';
import { canCompactContext, contextUsagePercent } from './backends/contextUsage';
import { compactedSummary, compactedTranscript, compactionSource } from './backends/compaction';
import {
  adoptedPlanSteps,
  applyPlanDecisions,
  assistantProgressText,
  carriedPlanDismissal,
  completeStepsBeforeFrontier,
  continuePlanInstruction,
  decidePlanAutopilot,
  hasPlanStepsHeading,
  mergeCheckboxStatuses,
  mergeReportedStepStatuses,
  planDocumentFromReply,
  planRelativePath,
  planTurnWork,
  shouldAutoOpenPlanDocument,
  shouldDismissCompletedPlan,
  updateStepStatus,
  userAsksToRevisePlan
} from './backends/plan';
import { PlanPreview, planPreviewState } from './planPreview';
import { shouldAutoShowPlanPreview } from './planStepMarkdown';
import { readDefaultMode, readDefaultPermissionLevel, readDefaultThinking } from './backends/defaults';
import { ContextDelivery } from './context/delivery';
import { inferRequestedMode, modeIsMoreRestrictive } from './backends/modeIntent';
import { anyCategoryEnabled } from './context/contextView';
import type { ChangeHunkView } from './changes/changeStore';
import type { CheckpointPlanRecord, CheckpointPlanState } from './changes/journal';
import { VscodeChangeJournal } from './changes/vscodeJournal';
import { VscodeChangeStore } from './changes/vscodeChangeStore';
import { VscodeCheckpointStore } from './changes/vscodeCheckpoint';
import { WorkspaceChangeWatcher } from './changes/vscodeChanges';
import { NativeDiffService, type NativeDiffResult } from './changes/vscodeDiff';
import { OPEN_CHANGE_DIFF_COMMAND, OPEN_TURN_CHANGES_COMMAND } from './changes/nativeDiff';
import { ChangeTracker } from './changes/tracker';
import type { VscodeProjectContext } from './context/vscodeHost';
import type {
  HostToWebviewMessage,
  ModeSnapshot,
  PermissionSnapshot,
  RestorePreview,
  RestorePreviewMessage,
  WebviewToHostMessage
} from './protocol';
import {
  COMPOSER_DRAFT_LIMIT,
  DEFAULT_TAB_TITLE,
  parseChatTabState,
  parseDraftAttachments,
  resolveChatTarget,
  tabTitle,
  type ChatTabState,
  type OpenChatTab,
  reorderById
} from './chatTabs';

/**
 * One sidebar chat tab. Fields that used to live once on the provider move here
 * so two open conversations do not share a thread, a mode, or a pending prompt.
 */
interface ChatSession {
  id: string;
  title: string;
  restored: boolean;
  activeThread?: ThreadHandle;
  mode: DefaultMode;
  pendingApproval?: ApprovalRequest;
  pendingQuestion?: { source: 'fence' | 'native'; request: QuestionRequest };
  nativePlanThisTurn: boolean;
  revisePlanThisTurn: boolean;
  /** Answers already folded into this thread's plan, in ask order. */
  planDecisions: string[];
  /** Bumped on a user send so a late autopilot decision cannot start another turn. */
  planEpoch: number;
  /** True when the open turn was started to keep a built plan moving. */
  planRunAutomatic: boolean;
  /** Steps-and-work signature of the previous turn, for the loop check. */
  planRunSignature?: string;
  /** A refused approval this turn must not be retried automatically. */
  planHold: boolean;
  pendingTurnMessage?: { messageId: string; backendId: string; threadId: string };
  /** No conversation has been bound to this tab yet. */
  blank: boolean;
  /** Unsent composer text. Restored with the tab. */
  composerText: string;
  /** Unsent composer files. Inline bytes stay in memory; the saved record does not. */
  composerAttachments: Attachment[];
  /** Thread to resume the first time this tab is shown. */
  resume?: { backendId: string; threadId: string };
  disposed: boolean;
  /** True while this tab's turn is still running, including after the tab is closed. */
  turnOpen: boolean;
}

/** Open sidebar tabs, so a reload can put the same chats back. */
const OPEN_CHAT_TABS_KEY = 'melink.openChatTabs';

/**
 * Renders the SideCode sidebar. Each open conversation is a tab in that view.
 * This class is UI-facing glue: it forwards the registry's snapshot and
 * normalized events to the React webview and turns webview intents into
 * registry calls. It holds no provider types.
 */
export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'melinkAgent.chat';

  /**
   * The permission level the next turn and the next chat run at. Seeded from
   * the last picker choice, then from the settings default. A new conversation
   * keeps it. `unrestricted` arrives only after the webview's confirmation.
   */
  private permissionLevel: PermissionLevel = readDefaultPermissionLevel();
  /** Bumped whenever the selection is stored, so a late snapshot cannot revert it. */
  private permissionEpoch = 0;
  /** Per-tab state for the async call that is currently running. */
  private readonly sessionStore = new AsyncLocalStorage<ChatSession | undefined>();
  private sessions: ChatSession[] = [];
  /** The sidebar webview. Every tab paints into this one view. */
  private view?: vscode.WebviewView;
  /** True once the webview script has posted `ready`. */
  private webviewMounted = false;
  private webviewMountTimers: ReturnType<typeof setTimeout>[] = [];
  /** The tab whose transcript is on screen. */
  private visible?: ChatSession;
  private tabSeq = 0;
  /** Serializes draft blob writes so an older save cannot skip the latest text. */
  private readonly composerPersistChain = new WeakMap<ChatSession, Promise<void>>();
  private readonly settings: SettingsService;
  private readonly dictation: DictationController;
  private readonly plans = new PlanStore();
  /** Rendered plan document in the editor area. Build on that view runs the plan. */
  private readonly planPreview: PlanPreview;
  /** Thread whose plan was already auto-opened, so a revision does not steal focus. */
  private planPreviewOpenedFor?: string;
  /** Thread the open preview belongs to. A thread change closes a stale document. */
  private planPreviewThreadId?: string;
  /** Plan files already sent to Markdown Preview, so focusing the source does not loop. */
  private readonly shownPlanPreviews = new Set<string>();
  /** True while Preview is being opened, so that open does not trigger another one. */
  private showingPlanPreview = false;
  /** Built-plan turns waiting to start once the current turn has released the lock. */
  private readonly planAutopilotQueue = new Map<string, { session: ChatSession; text: string }>();
  /** The next sendTurn is an automatic plan continuation, not a user message. */
  private autopilotSend = false;
  /**
   * The per-turn change journal: the host-owned record of what each turn
   * changed. Owned here so it shares the turn lifecycle the view already drives
   * rather than adding a parallel one.
   */
  private readonly changeJournal: VscodeChangeJournal;
  private readonly changeTracker: ChangeTracker;
  /**
   * The post-hoc decision store: per-file and per-hunk accept/reject over the
   * journal's recorded bytes. It is deliberately separate from the approval
   * gate in the registry; the two never share state.
   */
  private readonly changeStore: VscodeChangeStore;
  /**
   * Per-message checkpoints over the journal's send-time snapshots. The store
   * reverts files. This view rewinds the transcript and the plans, and keeps
   * the undo point that puts them back.
   */
  private readonly checkpointStore: VscodeCheckpointStore;
  /**
   * A note for the next provider turn after this chat was rewound. Codex keeps
   * the discarded turns on the server; the note tells the model they are gone.
   */
  private readonly rewindNotes = new Map<string, string>();
  /**
   * The native workbench diff integration: the `melink-changes:` content
   * provider and the diff/changes commands the review surface invokes. Owned
   * here so it is disposed with the view on deactivate and never leaks across a
   * reload. Read-only with respect to the workspace: it serves only the
   * journal's recorded pre-turn bytes.
   */
  private readonly nativeDiff: NativeDiffService;
  /** Prevents overlapping sends and mode changes while one request is running. */
  private turnInProgress = false;
  /**
   * The fallback watcher for shell-driven edits that emit no structured event.
   * Started per turn and stopped when the turn ends, so no watcher outlives it.
   */
  private readonly changeWatcher: WorkspaceChangeWatcher;
  /**
   * Builds the rendered, per-thread context payload for every session. The
   * snapshot service stays the single source of the workspace root; this view
   * only asks it for a snapshot/delta and hands the text to the backend seam.
   */
  private readonly contextDelivery: ContextDelivery;
  /** Coalesces a burst of editor/selection events into one context read. */
  private contextViewTimer?: ReturnType<typeof setTimeout>;
  /** Serializes plan-file writes so a live status update cannot clobber another. */
  private planStepChain: Promise<void> = Promise.resolve();
  /** Latest thread whose running turn should refresh todo status. */
  private todoProgressTarget?: { backendId: string; threadId: string };
  private todoProgressQueued = false;
  private todoProgressAgain = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext,
    private readonly registry: BackendRegistry,
    private readonly projectContext: VscodeProjectContext
  ) {
    this.settings = new SettingsService(context, registry);
    this.dictation = new DictationController(
      extensionUri.fsPath,
      path.join(context.globalStorageUri.fsPath, 'whisper'),
      {
        status: (requestId, message) => this.post({ type: 'dictationStatus', requestId, message }),
        cleaned: (requestId, text) => this.post({ type: 'dictationCleaned', requestId, text }),
        failed: (requestId, message, raw) =>
          this.post({ type: 'dictationError', requestId, message, ...(raw ? { raw } : {}) })
      },
      (text) => this.cleanupTranscript(text)
    );
    this.contextDelivery = new ContextDelivery({ reads: projectContext.context });
    // The change journal is bound to the real workspace fs and workspace-scoped
    // storage here; the tracker and watcher only ever talk to the host-free
    // core, so the turn wiring below stays a thin translation layer.
    this.changeJournal = new VscodeChangeJournal(context);
    this.changeTracker = new ChangeTracker(this.changeJournal);
    this.changeWatcher = new WorkspaceChangeWatcher(this.changeTracker);
    context.subscriptions.push(this.changeWatcher);
    // The decision store annotates the journal's recorded bytes; it shares the
    // journal instance so a view read and a decision read agree on content.
    this.changeStore = new VscodeChangeStore(context, { artifacts: this.changeJournal });
    // Checkpoints share the same journal and the decision store, so a restore
    // can invalidate a superseded decision and use the recorded before/after
    // bytes the review path already reads.
    this.checkpointStore = new VscodeCheckpointStore({
      artifacts: this.changeJournal,
      decisions: this.changeStore
    });
    // The native diff integration reads the same journal bytes the review panel
    // diffs, so a single-file or whole-turn view can never disagree with the
    // inline summary. It registers its own content provider and command ids; a
    // dispose on deactivate removes both.
    this.nativeDiff = new NativeDiffService(this.changeJournal);
    this.planPreview = new PlanPreview(this.extensionUri, () => {
      const session = this.planPreviewThreadId
        ? this.sessions.find((entry) => entry.activeThread?.threadId === this.planPreviewThreadId)
        : undefined;
      void this.sessionStore.run(session, () => this.buildPlan());
    });
    context.subscriptions.push(
      this.nativeDiff,
      { dispose: () => this.planPreview.close() },
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor || this.showingPlanPreview) {
          return;
        }
        const uri = editor.document.uri;
        if (!shouldAutoShowPlanPreview(uri.fsPath, this.shownPlanPreviews.has(uri.toString()))) {
          return;
        }
        void this.showPlanMarkdownPreview(uri);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (!this.showingPlanPreview) {
          this.shownPlanPreviews.delete(document.uri.toString());
        }
      })
    );
    const planFiles = vscode.workspace.createFileSystemWatcher('**/.melink/plans/*.md');
    context.subscriptions.push(
      planFiles,
      planFiles.onDidChange((uri) => {
        this.adoptExternalPlanFile(uri);
      }),
      planFiles.onDidCreate((uri) => {
        this.adoptExternalPlanFile(uri);
      })
    );
    this.registry.onDidChangeAvailability((availability) => this.post({ type: 'snapshot', availability }));
    this.registry.onEvent((event) => {
      const owner = event.threadId ? this.sessionForThread(event.backendId, event.threadId) : undefined;
      this.sessionStore.run(owner, () => {
      // `changes/reported` is internal turn bookkeeping, not transcript content:
      // it is folded into the journal here and never forwarded to the webview,
      // which only ever receives the final `changes/changed` snapshot.
      if (event.type === 'changes/reported') {
        this.changeTracker.reportChanges(event.changes, event.threadId);
        return;
      }
      if (event.type === 'question/requested') {
        this.holdNativeQuestion(event.request);
        return;
      }
      this.post({ type: 'agentEvent', event });
      // A failed auth attempt is turned into a notice by the webview reducer,
      // which scopes it to the provider the user is actually driving. Posting a
      // second, unscoped notice here would surface a Codex failure while Ollama
      // is the selected provider, breaking the "no Codex noise" invariant.
      if (event.type === 'approval/requested') {
        // Track the open request so a reload repaints exactly this one prompt.
        // Nothing here answers it: only a user decision ever does.
        this.pendingApproval = event.approval;
      }
      if (event.type === 'approval/decided' || event.type === 'approval/denied') {
        // A settled request must never come back after a reload.
        this.pendingApproval = undefined;
      }
      if (event.type === 'approval/decided') {
        // An `always` decision stores a rule as part of deciding it. Push a
        // fresh permission read model so the revocation route lists the rule
        // the user just created, rather than waiting for a reload or a backend
        // switch.
        void this.postPermissions(event.backendId);
      }
      if (
        (event.type === 'turn/interrupted' || event.type === 'error') &&
        this.pendingQuestion?.source === 'native' &&
        event.threadId &&
        this.pendingQuestion.request.threadId === event.threadId
      ) {
        this.pendingQuestion = undefined;
        this.post({ type: 'question/cleared' });
      }
      if (event.type === 'turn/completed' || event.type === 'turn/interrupted' || event.type === 'error') {
        // A finished, interrupted, or failed turn cannot still be blocked on a
        // decision.
        this.pendingApproval = undefined;
        // A turn that ends while a step is still `inProgress` never resolves
        // that step on its own: the provider's plan update only ever marks it
        // running. Settle it in the persisted plan so the todo list shows honest
        // partial progress instead of a spinner that never stops. A denied step
        // (set by the `approval/denied` branch below) is terminal and left alone.
        if (event.threadId && !(event.type === 'turn/completed' && this.mode === 'agent')) {
          void this.flushBuiltPlanProgress(event.backendId, event.threadId);
        }
      }
      if (
        event.threadId &&
        (event.type === 'item/delta' || event.type === 'item/completed') &&
        this.mode === 'agent'
      ) {
        this.noteTodoProgress(event.backendId, event.threadId);
      }
      if (event.type === 'turn/completed' || event.type === 'turn/interrupted') {
        // Close the change boundary on a real turn terminus only: an `error`
        // event can be recoverable, so the turn may still be running and must
        // keep its watcher. The turn id guards against a racing new turn.
        void this.finishChangeTurn(event.turnId);
      }
      if (event.type === 'approval/denied') {
        // A refusal is the one signal that the step the agent was on never ran:
        // mark it denied, so it renders as partial rather than pending. Every
        // refusal path (a user decision or a mode enforcement) fires this event.
        if (this.session) {
          this.session.planHold = true;
        }
        void this.denyPlanStep(event.backendId, event.threadId);
      }
      if (event.type === 'turn/started') {
        // A new turn starts; a native plan update for it has not arrived yet.
        this.nativePlanThisTurn = false;
        if (this.session) {
          this.session.planHold = false;
        }
        // Open the change boundary and start the fallback watcher, reusing the
        // existing turn lifecycle rather than adding a parallel one.
        this.beginChangeTurn(event.backendId, event.threadId, event.turnId);
      }
      if (event.type === 'plan/updated') {
        // Native plan tracking: keep the persisted todo list in step with the
        // provider's own plan, and write the plan artifact so Plan mode always
        // produces the documented markdown file. Writing that file is the one
        // permitted host-side write in Plan mode; the provider follows its
        // selected permission level.
        this.nativePlanThisTurn = true;
        void this.enqueuePlanSteps(() =>
          this.recordNativePlan(event.backendId, event.threadId, event.steps, event.explanation)
        );
      }
      if (event.type === 'turn/completed' && event.threadId && (this.mode === 'plan' || this.mode === 'agent')) {
        // Strip a question fence before the plan is read from the same reply.
        this.captureFenceQuestions(event.backendId, event.threadId);
      }
      if (event.type === 'turn/completed' && this.mode === 'plan' && event.threadId) {
        // Derive the plan document from the reply. Native step updates that
        // already arrived stay the todo list; the reply still supplies the body.
        // capturePlanFromReply reads and clears revisePlanThisTurn synchronously.
        void this.capturePlanFromReply(event.backendId, event.threadId, this.nativePlanThisTurn);
      } else if (event.type === 'turn/completed') {
        this.revisePlanThisTurn = false;
      }
      if (
        event.threadId &&
        (event.type === 'turn/completed' || event.type === 'turn/interrupted' || event.type === 'error')
      ) {
        for (const session of [...this.sessions]) {
          const sameThread =
            session.activeThread?.backendId === event.backendId && session.activeThread.threadId === event.threadId;
          if (!sameThread) {
            continue;
          }
          session.turnOpen = false;
          if (session.disposed) {
            this.removeSession(session);
          }
        }
      }
      if (event.type === 'turn/completed' && this.mode === 'agent' && event.threadId) {
        void this.considerPlanAutopilot(event.backendId, event.threadId);
      }
      });
    });
    const storedPermission = this.store.getLastPermissionLevel();
    if (storedPermission) {
      this.permissionLevel = storedPermission;
    }
  }

  private get store(): ThreadStore {
    return this.registry.threads;
  }

  private get session(): ChatSession | undefined {
    return this.sessionStore.getStore();
  }

  private get activeThread(): ThreadHandle | undefined {
    return this.session?.activeThread;
  }

  private set activeThread(value: ThreadHandle | undefined) {
    if (this.session) {
      this.session.activeThread = value;
    }
  }

  private get mode(): DefaultMode {
    return this.session?.mode ?? readDefaultMode();
  }

  private set mode(value: DefaultMode) {
    if (this.session) {
      this.session.mode = value;
    }
  }

  private get pendingApproval(): ApprovalRequest | undefined {
    return this.session?.pendingApproval;
  }

  private set pendingApproval(value: ApprovalRequest | undefined) {
    if (this.session) {
      this.session.pendingApproval = value;
    }
  }

  private get pendingQuestion(): ChatSession['pendingQuestion'] {
    return this.session?.pendingQuestion;
  }

  private set pendingQuestion(value: ChatSession['pendingQuestion']) {
    if (this.session) {
      this.session.pendingQuestion = value;
    }
  }

  private get nativePlanThisTurn(): boolean {
    return this.session?.nativePlanThisTurn ?? false;
  }

  private set nativePlanThisTurn(value: boolean) {
    if (this.session) {
      this.session.nativePlanThisTurn = value;
    }
  }

  private get revisePlanThisTurn(): boolean {
    return this.session?.revisePlanThisTurn ?? false;
  }

  private set revisePlanThisTurn(value: boolean) {
    if (this.session) {
      this.session.revisePlanThisTurn = value;
    }
  }

  private get planDecisions(): string[] {
    return this.session?.planDecisions ?? [];
  }

  private set planDecisions(value: string[]) {
    if (this.session) {
      this.session.planDecisions = value;
    }
  }

  private get pendingTurnMessage(): ChatSession['pendingTurnMessage'] {
    return this.session?.pendingTurnMessage;
  }

  private set pendingTurnMessage(value: ChatSession['pendingTurnMessage']) {
    if (this.session) {
      this.session.pendingTurnMessage = value;
    }
  }

  /**
   * Open the change boundary for a turn. The candidate set is seeded with the
   * paths a pre-turn snapshot is worth taking of: the files currently open in
   * editors, plus every file this thread's earlier turns touched, so a later
   * turn in the same working set still gets a real before side. Paths the turn
   * is only observed touching later extend the set through the watcher and the
   * backends' structured reports. The watcher is started here and stopped at
   * turn end, so it never outlives one turn.
   */
  private beginChangeTurn(backendId: string, threadId: string, turnId: string): void {
    const pending = this.pendingTurnMessage;
    const messageId =
      pending && pending.backendId === backendId && pending.threadId === threadId ? pending.messageId : undefined;
    if (messageId !== undefined) {
      this.pendingTurnMessage = undefined;
    }
    void this.changeTracker.beginTurn({
      backendId,
      threadId,
      turnId,
      ...(messageId !== undefined ? { messageId } : {}),
      candidates: this.turnCandidates(threadId)
    });
    this.changeWatcher.start();
  }

  /**
   * The absolute paths worth a pre-turn snapshot. Open editors are the files
   * the user is looking at; previously touched paths are the working set an
   * agent turn is most likely to keep editing. Only paths inside a workspace
   * root are returned.
   */
  private turnCandidates(threadId: string): string[] {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const withinRoot = (absPath: string): boolean =>
      roots.some((root) => {
        const rel = path.relative(root, absPath);
        return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
      });
    const candidates = new Set<string>();
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme === 'file' && withinRoot(editor.document.uri.fsPath)) {
        candidates.add(editor.document.uri.fsPath);
      }
    }
    for (const turn of this.changeJournal.listTurns(threadId)) {
      for (const file of turn.files) {
        if (withinRoot(file.absPath)) {
          candidates.add(file.absPath);
        }
      }
    }
    return [...candidates];
  }

  /**
   * Close the change boundary for a turn: stop the watcher and snapshot-diff
   * what was observed. A set is pushed only when the turn actually observed
   * something; a turn with no observation pushes nothing, so the UI never reads
   * silence as "the agent changed nothing".
   *
   * The set is the whole thread, not this turn alone. A plan runs one turn per
   * step, and the surface has to keep every step's files.
   */
  private async finishChangeTurn(turnId: string): Promise<void> {
    // A terminus for a turn that is not the active one (a late event after a new
    // turn already started) must not stop the newer turn's watcher or end its
    // boundary.
    if (this.changeTracker.currentTurnId !== turnId) {
      return;
    }
    this.changeWatcher.stop();
    const set = await this.changeTracker.endTurn(turnId);
    if (!set) {
      return;
    }
    const session = await this.changeTracker.sessionFor(set.threadId);
    if (!session) {
      return;
    }
    // Only the active conversation's own turn is pushed: a background thread's
    // change set must not replace what the visible surface is showing.
    if (this.activeThread?.backendId !== session.backendId || this.activeThread?.threadId !== session.threadId) {
      return;
    }
    this.post({
      type: 'changes/changed',
      backendId: session.backendId,
      threadId: session.threadId,
      turnId: session.turnId,
      entries: session.entries
    });
    // A turn that just touched files makes its opening message a checkpoint, so
    // the per-message entry point offers it without waiting for a reload.
    await this.postCheckpoints(set.backendId, set.threadId);
  }

  /**
   * Push the active thread's session change set, so a webview reload repaints
   * every step, not only the latest turn. Nothing is pushed when the thread
   * never observed a change, so a reload cannot manufacture a verified empty set.
   */
  private async postLatestChanges(): Promise<void> {
    const thread = this.activeThread;
    if (!thread) {
      return;
    }
    const set = await this.changeTracker.sessionFor(thread.threadId);
    if (!set) {
      return;
    }
    this.post({
      type: 'changes/changed',
      backendId: set.backendId,
      threadId: set.threadId,
      turnId: set.turnId,
      entries: set.entries
    });
  }

  /**
   * The single path that pushes a change-review snapshot, mirroring
   * `postPermissions(backendId)`. A reload, an on-demand `changes/list`, and the
   * after-a-decision repaint all go through here, so the review surface can
   * never be left showing three different versions of the same turn.
   */
  private async postChangeReview(backendId: string, threadId: string, turnId: string): Promise<void> {
    const review =
      (await this.changeStore.viewSession(backendId, threadId)) ??
      (await this.changeStore.view(backendId, threadId, turnId));
    if (!review) {
      return;
    }
    this.post({
      type: 'changes/review',
      review: {
        ...review,
        files: review.files.map((file) =>
          file.hunks.length === 0
            ? file
            : {
                ...file,
                linesOmitted: true,
                hunks: file.hunks.map((hunk) => ({ ...hunk, lines: [] }))
              }
        )
      }
    });
  }

  /** Hunk lines for one expanded row, capped so a large file cannot fill the sidebar. */
  private async postChangeHunks(backendId: string, threadId: string, turnId: string, path: string): Promise<void> {
    const review =
      (await this.changeStore.viewSession(backendId, threadId)) ??
      (await this.changeStore.view(backendId, threadId, turnId));
    const file = review?.files.find((entry) => entry.path === path);
    if (!review || !file) {
      return;
    }
    const capped = capReviewLines(file.hunks, 120);
    this.post({ type: 'changes/hunks', turnId: review.turnId, path, hunks: capped.hunks, truncated: capped.truncated });
  }

  /**
   * Decide one file or hunk. Accept records the decision and writes nothing;
   * reject restores the pre-turn bytes, or reports a conflict or a failed write.
   * Every outcome is echoed and a partial failure is surfaced as a notice, so a
   * reject is never claimed to have succeeded when it did not.
   */
  private async decideChange(message: {
    backendId: string;
    threadId: string;
    turnId: string;
    path: string;
    hunkId?: string;
    decision: 'accepted' | 'rejected';
    conflictResolution?: import('./changes/changeStore').ConflictResolution;
  }): Promise<void> {
    const result = await this.changeStore.decide({
      backendId: message.backendId,
      threadId: message.threadId,
      turnId: message.turnId,
      relPath: message.path,
      ...(message.hunkId !== undefined ? { hunkId: message.hunkId } : {}),
      decision: message.decision,
      ...(message.conflictResolution !== undefined ? { conflictResolution: message.conflictResolution } : {})
    });
    const summary = describeDecisionOutcome(result);
    this.post({ type: 'changes/decisionResult', results: [result], ...(summary ? { message: summary } : {}) });
    await this.postChangeReview(message.backendId, message.threadId, message.turnId);
  }

  /**
   * Decide every file in a turn. All files are attempted; each outcome is
   * echoed and any failure is summarised, so accept-all/reject-all is
   * all-or-nothing only from the user's perspective and never silently partial.
   */
  private async decideAllChanges(message: {
    backendId: string;
    threadId: string;
    turnId: string;
    decision: 'accepted' | 'rejected';
    conflictResolution?: import('./changes/changeStore').ConflictResolution;
  }): Promise<void> {
    const results = await this.changeStore.decideAll({
      backendId: message.backendId,
      threadId: message.threadId,
      turnId: message.turnId,
      decision: message.decision,
      ...(message.conflictResolution !== undefined ? { conflictResolution: message.conflictResolution } : {})
    });
    const failed = results.filter((result) => !result.ok);
    const summary =
      failed.length === 0
        ? undefined
        : failed.length === results.length
          ? `None of the ${results.length} files could be ${message.decision === 'accepted' ? 'accepted' : 'rejected'}.`
          : `${failed.length} of ${results.length} files could not be ${message.decision === 'accepted' ? 'accepted' : 'rejected'}.`;
    this.post({ type: 'changes/decisionResult', results, ...(summary ? { message: summary } : {}) });
    await this.postChangeReview(message.backendId, message.threadId, message.turnId);
  }

  /**
   * Push the per-message checkpoints a thread offers. Every sent user message
   * is included, even when its turn touched no files.
   */
  private async postCheckpoints(backendId: string, threadId: string): Promise<void> {
    const checkpoints = await this.checkpointStore.listCheckpoints(threadId);
    this.post({ type: 'changes/checkpoints', backendId, threadId, checkpoints });
  }

  /** Push the active thread's checkpoint list, when a conversation is open. */
  private async postActiveCheckpoints(): Promise<void> {
    const thread = this.activeThread;
    if (!thread) {
      return;
    }
    await this.postCheckpoints(thread.backendId, thread.threadId);
  }

  /**
   * Restore a checkpoint to the moment before that message was sent. Files are
   * written by the checkpoint store, which aborts if it cannot save an undo
   * snapshot. This view then rewinds this chat's transcript and every thread's
   * plan to the snapshot. Other chats keep their messages.
   */
  private async restoreCheckpoint(message: {
    backendId: string;
    threadId: string;
    messageId?: string;
    restorePointId?: string;
    conflictResolution?: import('./changes/checkpoint').CheckpointConflictResolution;
  }): Promise<void> {
    if (message.restorePointId) {
      await this.undoCheckpointRestore(message);
      return;
    }
    if (!message.messageId) {
      return;
    }
    const checkpoint = this.changeJournal.getMessageCheckpoint(message.threadId, message.messageId);
    const priorTranscript = this.store.getTranscript(message.backendId, message.threadId);
    const priorPlans = this.collectPlanRecords();
    const result = await this.checkpointStore.restore({
      backendId: message.backendId,
      threadId: message.threadId,
      messageId: message.messageId,
      ...(message.conflictResolution !== undefined ? { conflictResolution: message.conflictResolution } : {})
    });
    if (!result.aborted && result.undoPointId && checkpoint) {
      const detached = await this.changeJournal.detachFromMessage(message.threadId, message.messageId);
      await this.changeJournal.attachRewind(result.undoPointId, {
        backendId: message.backendId,
        threadId: message.threadId,
        messageId: message.messageId,
        transcript: priorTranscript,
        plans: priorPlans,
        turns: detached.turns,
        checkpoints: detached.checkpoints
      });
      this.store.truncateBeforeMessage(message.backendId, message.threadId, message.messageId);
      await this.store.flush();
      await this.applyPlanSnapshot(checkpoint.plans);
      this.rewindNotes.set(
        rewindKey(message.backendId, message.threadId),
        'The conversation and workspace were restored to before an earlier prompt. Later turns were discarded. Continue from the restored files and do not redo that discarded work.'
      );
    }
    await this.repaintIfActive(message.backendId, message.threadId);
    await this.postCheckpoints(message.backendId, message.threadId);
    await this.refreshChanges(message.backendId, message.threadId);
    // Posted after the conversation repaint, which clears a previous result.
    this.post({ type: 'changes/restoreResult', result });
    this.post({
      type: 'notice',
      level: result.ok ? 'info' : 'warning',
      message: result.message
    });
  }

  /** Put files, this chat's transcript, and plans back to the moment before a restore. */
  private async undoCheckpointRestore(message: {
    backendId: string;
    threadId: string;
    restorePointId?: string;
    conflictResolution?: import('./changes/checkpoint').CheckpointConflictResolution;
  }): Promise<void> {
    const point = message.restorePointId ? this.changeJournal.getRestorePoint(message.restorePointId) : undefined;
    const result = await this.checkpointStore.restore({
      backendId: message.backendId,
      threadId: message.threadId,
      ...(message.restorePointId !== undefined ? { restorePointId: message.restorePointId } : {}),
      ...(message.conflictResolution !== undefined ? { conflictResolution: message.conflictResolution } : {})
    });
    const rewind = point?.rewind;
    if (!result.aborted && rewind) {
      await this.changeJournal.reinsert(rewind.turns, rewind.checkpoints);
      this.store.setTranscript(rewind.backendId, rewind.threadId, rewind.transcript as TranscriptItem[]);
      await this.store.flush();
      await this.applyPlanSnapshot(rewind.plans);
      this.rewindNotes.delete(rewindKey(rewind.backendId, rewind.threadId));
      await this.repaintIfActive(rewind.backendId, rewind.threadId);
      await this.refreshChanges(rewind.backendId, rewind.threadId);
    }
    await this.postCheckpoints(message.backendId, message.threadId);
    this.post({ type: 'changes/restoreResult', result });
    this.post({
      type: 'notice',
      level: result.ok ? 'info' : 'warning',
      message: result.message
    });
  }

  /** Describe a restore without writing, so the confirmation can name every affected chat. */
  private async previewRestore(message: { backendId: string; threadId: string; messageId: string }): Promise<void> {
    const impact = await this.checkpointStore.preview({
      threadId: message.threadId,
      messageId: message.messageId,
      plans: this.collectPlanRecords()
    });
    if (!impact) {
      this.post({
        type: 'notice',
        level: 'warning',
        message: 'That checkpoint is no longer available, so nothing was restored.'
      });
      return;
    }
    const known = this.store.listKnownThreads();
    const titleFor = (backendId: string, threadId: string): string =>
      known.find((thread) => thread.backendId === backendId && thread.threadId === threadId)?.title ?? 'Chat';
    const preview: RestorePreview = {
      messageId: message.messageId,
      thisChat: {
        backendId: message.backendId,
        threadId: message.threadId,
        title: titleFor(message.backendId, message.threadId),
        messages: this.removedMessagePreviews(message.backendId, message.threadId, message.messageId),
        paths: impact.paths,
        planChanges: impact.thisPlanChanged
      },
      otherChats: impact.others.map((chat) => ({
        backendId: chat.backendId,
        threadId: chat.threadId,
        title: titleFor(chat.backendId, chat.threadId),
        messages: this.userMessagesAfter(chat.backendId, chat.threadId, impact.createdAt),
        paths: chat.paths,
        planChanges: chat.planChanged
      }))
    };
    this.post({ type: 'changes/restorePreview', preview });
  }

  /** Snapshot files and plans for a user message, then tell the live bubble its id. */
  private async captureSentMessage(backendId: string, threadId: string, messageId: string): Promise<void> {
    try {
      const paths = new Set(this.changeJournal.trackedAbsPaths());
      for (const document of vscode.workspace.textDocuments) {
        if (document.uri.scheme === 'file') {
          paths.add(document.uri.fsPath);
        }
      }
      await this.changeJournal.captureMessageCheckpoint({
        messageId,
        threadId,
        backendId,
        paths: [...paths],
        plans: this.collectPlanRecords()
      });
    } catch (error) {
      this.post({
        type: 'notice',
        level: 'warning',
        message: `A checkpoint could not be saved (${error instanceof Error ? error.message : String(error)}).`
      });
    }
    this.post({ type: 'userMessageId', backendId, threadId, messageId });
    if (this.activeThread?.backendId === backendId && this.activeThread.threadId === threadId) {
      await this.postCheckpoints(backendId, threadId);
    }
  }

  private collectPlanRecords(): CheckpointPlanRecord[] {
    const records: CheckpointPlanRecord[] = [];
    const seen = new Set<string>();
    const add = (backendId: string, threadId: string): void => {
      const key = `${backendId}\0${threadId}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      const state = this.store.getPlanState(backendId, threadId);
      records.push({
        backendId,
        threadId,
        ...(state ? { state: planSnapshot(state) } : {})
      });
    };
    for (const thread of this.store.listKnownThreads()) {
      add(thread.backendId, thread.threadId);
    }
    if (this.activeThread) {
      add(this.activeThread.backendId, this.activeThread.threadId);
    }
    return records;
  }

  /** Write snapshot plans back, and drop plans that did not exist at that moment. */
  private async applyPlanSnapshot(snapshot: readonly CheckpointPlanRecord[]): Promise<void> {
    const covered = new Set(snapshot.map((record) => `${record.backendId}\0${record.threadId}`));
    for (const record of snapshot) {
      await this.writePlanRecord(record);
    }
    for (const current of this.collectPlanRecords()) {
      const key = `${current.backendId}\0${current.threadId}`;
      if (!covered.has(key) && current.state) {
        await this.writePlanRecord({ backendId: current.backendId, threadId: current.threadId });
      }
    }
  }

  private async writePlanRecord(record: CheckpointPlanRecord): Promise<void> {
    if (!record.state) {
      await this.store.clearPlanState(record.backendId, record.threadId);
      await this.plans.remove(record.threadId);
      return;
    }
    const steps = record.state.steps as TodoStep[];
    await this.plans.write({
      threadId: record.threadId,
      title: record.state.title,
      summary: record.state.summary,
      body: record.state.body,
      steps
    });
    await this.store.setPlanState(record.backendId, record.threadId, {
      path: record.state.path,
      title: record.state.title,
      summary: record.state.summary,
      body: record.state.body,
      steps,
      built: record.state.built,
      completedDismissed: record.state.completedDismissed,
      updatedAt: record.state.updatedAt
    });
  }

  private removedMessagePreviews(backendId: string, threadId: string, messageId: string): RestorePreviewMessage[] {
    const items = this.store.getTranscript(backendId, threadId);
    const index = items.findIndex((item) => item.id === messageId);
    if (index === -1) {
      return [];
    }
    return items
      .slice(index)
      .filter((item) => item.kind === 'message')
      .map((item) => ({ id: item.id, preview: messagePreview(item.text, item.role === 'user' ? 'Message' : 'Reply') }));
  }

  private userMessagesAfter(backendId: string, threadId: string, createdAt: number): RestorePreviewMessage[] {
    const after = new Set(
      this.changeJournal
        .listMessageCheckpoints(threadId)
        .filter((checkpoint) => checkpoint.createdAt >= createdAt)
        .map((checkpoint) => checkpoint.messageId)
    );
    return this.store
      .getTranscript(backendId, threadId)
      .filter((item) => {
        if (item.kind !== 'message' || item.role !== 'user') {
          return false;
        }
        const time = userMessageTime(item.id);
        return (time !== undefined && time >= createdAt) || after.has(item.id);
      })
      .map((item) => ({ id: item.id, preview: messagePreview(item.text, 'Message') }));
  }

  private async repaintIfActive(backendId: string, threadId: string): Promise<void> {
    if (this.activeThread?.backendId === backendId && this.activeThread.threadId === threadId) {
      this.repaintSession();
    }
  }

  /** Repaint the change strip from the journal turns that survived a restore. */
  private async refreshChanges(backendId: string, threadId: string): Promise<void> {
    if (this.activeThread?.backendId !== backendId || this.activeThread.threadId !== threadId) {
      return;
    }
    const set = await this.changeTracker.sessionFor(threadId);
    if (!set) {
      this.post({ type: 'changes/changed', backendId, threadId, turnId: '', entries: [] });
      return;
    }
    this.post({
      type: 'changes/changed',
      backendId: set.backendId,
      threadId: set.threadId,
      turnId: set.turnId,
      entries: set.entries
    });
    await this.postChangeReview(set.backendId, set.threadId, set.turnId);
  }

  /** Prefix the next provider turn once, then forget the note. */
  private consumeRewindNote(backendId: string, threadId: string, text: string): string {
    const note = this.rewindNotes.get(rewindKey(backendId, threadId));
    if (!note) {
      return text;
    }
    this.rewindNotes.delete(rewindKey(backendId, threadId));
    return `${note}\n\n${text}`;
  }

  resolveWebviewView(
    view: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ): void {
    this.view = view;
    this.webviewMounted = false;
    this.clearWebviewMountTimers();
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')]
    };
    const messages = view.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      if (message.type === 'ready') {
        this.webviewMounted = true;
        this.clearWebviewMountTimers();
        // No tab exists yet on a cold start, so this cannot wait for `visible`.
        void this.handle(message);
        return;
      }
      if (message.type === 'newChat') {
        this.openBlank({ text: message.text ?? '', attachments: message.attachments ?? [] });
        return;
      }
      if (message.type === 'openThread') {
        this.openThread(message.backendId, message.threadId);
        return;
      }
      if (message.type === 'selectChatTab') {
        const session = this.liveSessions().find((entry) => entry.id === message.tabId);
        if (session) {
          void this.showSession(session);
        }
        return;
      }
      if (message.type === 'closeChatTab') {
        this.closeSession(message.tabId);
        return;
      }
      if (message.type === 'reorderChatTab') {
        this.reorderSession(message.tabId, message.toIndex);
        return;
      }
      const session = this.visible;
      if (!session) {
        return;
      }
      void this.sessionStore.run(session, () => this.handle(message));
    });
    view.onDidDispose(() => {
      messages.dispose();
      this.dictation.dispose();
      this.clearWebviewMountTimers();
      if (this.view === view) {
        this.view = undefined;
      }
    });
    // VS Code registers a service worker in the webview iframe before our HTML
    // is shown. Writing the document on this same turn navigates that iframe
    // while registration is in flight, and Chromium then rejects the worker
    // with InvalidStateError ("The document is in an invalid state"). Wait
    // until the host document exists, and replace it once more if the script
    // never reports ready.
    const mount = (): void => {
      if (token.isCancellationRequested || this.webviewMounted || this.view !== view) {
        return;
      }
      view.webview.html = this.render(view.webview);
    };
    this.webviewMountTimers.push(setTimeout(mount, 0), setTimeout(mount, 750));
  }

  private clearWebviewMountTimers(): void {
    for (const timer of this.webviewMountTimers) {
      clearTimeout(timer);
    }
    this.webviewMountTimers = [];
  }

  /** Open a blank sidebar tab, or focus one that has not been used yet. */
  openBlank(incoming?: { text: string; attachments: Attachment[] }): void {
    const source = this.visible;
    const text = (incoming?.text ?? source?.composerText ?? '').slice(0, COMPOSER_DRAFT_LIMIT);
    const attachments = (incoming?.attachments ?? source?.composerAttachments ?? []).map((attachment) => ({
      ...attachment
    }));
    const carry = text.trim().length > 0 || attachments.length > 0;
    if (source) {
      this.rememberComposer(source, text, attachments.map((attachment) => ({ ...attachment })));
    }
    const target = resolveChatTarget(this.openTabRecords(), { kind: 'new' });
    if (target.action === 'reveal') {
      const existing = this.liveSessions()[target.index];
      if (!existing) {
        return;
      }
      if (existing !== source && carry) {
        this.rememberComposer(existing, text, attachments.map((attachment) => ({ ...attachment })));
      }
      void this.showSession(existing);
      return;
    }
    const created = this.createSession({
      blank: true,
      title: DEFAULT_TAB_TITLE,
      ...(carry ? { draftText: text } : {})
    });
    if (carry) {
      this.rememberComposer(created, text, attachments);
    }
    void this.showSession(created);
  }

  /** Show the tab for a thread, or open one and resume that thread. */
  openThread(backendId: string, threadId: string): void {
    const target = resolveChatTarget(this.openTabRecords(), { kind: 'thread', backendId, threadId });
    if (target.action === 'reveal') {
      const existing = this.liveSessions()[target.index];
      if (existing) {
        void this.showSession(existing);
      }
      return;
    }
    const stored = this.store.listThreads(backendId).find((entry) => entry.threadId === threadId)?.title;
    void this.showSession(this.createSession({ blank: false, backendId, threadId, title: tabTitle(stored) }));
  }

  private reorderSession(tabId: string, toIndex: number): void {
    const next = reorderById(this.liveSessions(), tabId, toIndex);
    if (!next) {
      return;
    }
    const disposed = this.sessions.filter((session) => session.disposed);
    this.sessions = [...next, ...disposed];
    this.publishTabs();
  }

  private closeSession(tabId: string): void {
    const session = this.sessions.find((entry) => entry.id === tabId && !entry.disposed);
    if (!session) {
      return;
    }
    session.disposed = true;
    if (!session.turnOpen) {
      this.removeSession(session);
    }
    const live = this.liveSessions();
    if (this.visible === session || this.visible?.disposed) {
      if (live.length === 0) {
        void this.showSession(this.createSession({ blank: true, title: DEFAULT_TAB_TITLE }));
        return;
      }
      void this.showSession(live[live.length - 1]);
      return;
    }
    this.publishTabs();
  }

  private createSession(init: ChatTabState): ChatSession {
    this.tabSeq += 1;
    const session: ChatSession = {
      id: `tab_${this.tabSeq}`,
      title: init.title ?? DEFAULT_TAB_TITLE,
      restored: false,
      mode: readDefaultMode(),
      nativePlanThisTurn: false,
      revisePlanThisTurn: false,
      planDecisions: [],
      planEpoch: 0,
      planRunAutomatic: false,
      planHold: false,
      blank: init.blank,
      composerText: init.draftText?.slice(0, COMPOSER_DRAFT_LIMIT) ?? '',
      composerAttachments: (init.draftAttachments ?? []).map((attachment) => ({ ...attachment })),
      ...(init.backendId && init.threadId ? { resume: { backendId: init.backendId, threadId: init.threadId } } : {}),
      disposed: false,
      turnOpen: false
    };
    this.sessions.push(session);
    return session;
  }

  /** Put this tab's conversation on screen. */
  private async showSession(session: ChatSession): Promise<void> {
    if (session.disposed) {
      return;
    }
    this.visible = session;
    this.publishTabs();
    await this.sessionStore.run(session, async () => {
      const pending = session.resume;
      if (pending) {
        session.resume = undefined;
        session.blank = false;
        await this.resumeThread(pending.backendId, pending.threadId);
        return;
      }
      if (session.activeThread) {
        this.repaintSession();
        await this.postLatestChanges();
        await this.postActiveCheckpoints();
        return;
      }
      this.postFreshConversation();
      this.post({ type: 'restoring', value: false });
    });
    await this.postComposerDraft(session);
  }

  /** Re-send the visible tab's stored conversation without starting a new thread. */
  private repaintSession(): void {
    const thread = this.activeThread;
    if (!thread) {
      this.postFreshConversation();
      this.post({ type: 'restoring', value: false });
      return;
    }
    const { backendId, threadId, model } = thread;
    const ref = this.store.listThreads(backendId).find((entry) => entry.threadId === threadId);
    this.mode = this.resolveMode(backendId, ref?.mode ?? this.mode);
    this.post({
      type: 'conversation',
      backendId,
      threadId,
      model,
      permissionLevel: this.permissionLevel,
      mode: this.mode,
      replay: this.store.getTranscript(backendId, threadId),
      pendingApproval: this.pendingApproval,
      pendingQuestion: this.pendingQuestionPayload(backendId, threadId),
      plan: this.store.getPlanState(backendId, threadId) ? this.planArtifact(backendId, threadId) : undefined
    });
    this.post({ type: 'restoring', value: false });
  }

  private loadSavedSessions(): void {
    const saved = this.context.workspaceState.get<ChatTabState[]>(OPEN_CHAT_TABS_KEY);
    if (!Array.isArray(saved) || saved.length === 0) {
      this.visible = this.createSession({ blank: true, title: DEFAULT_TAB_TITLE });
      return;
    }
    let active: ChatSession | undefined;
    for (const tab of saved) {
      const session = this.createSession(parseChatTabState(tab));
      if (tab.active) {
        active = session;
      }
    }
    this.visible = active ?? this.liveSessions()[0];
  }

  private liveSessions(): ChatSession[] {
    return this.sessions.filter((session) => !session.disposed);
  }

  private openTabRecords(): OpenChatTab[] {
    return this.liveSessions().map((session) => ({
      blank: session.blank && !session.activeThread && !session.resume,
      backendId: session.activeThread?.backendId ?? session.resume?.backendId,
      threadId: session.activeThread?.threadId ?? session.resume?.threadId
    }));
  }

  private sessionForThread(backendId: string, threadId: string): ChatSession | undefined {
    const matches = this.sessions.filter(
      (session) =>
        (session.activeThread?.backendId === backendId && session.activeThread.threadId === threadId) ||
        (session.resume?.backendId === backendId && session.resume.threadId === threadId)
    );
    return matches.find((session) => session === this.visible) ?? matches.find((session) => !session.disposed) ?? matches[0];
  }

  private removeSession(session: ChatSession): void {
    this.sessions = this.sessions.filter((entry) => entry !== session);
    this.persistOpenTabs();
  }

  private persistOpenTabs(): void {
    const tabs: ChatTabState[] = this.liveSessions().map((session) => {
      const backendId = session.activeThread?.backendId ?? session.resume?.backendId;
      const threadId = session.activeThread?.threadId ?? session.resume?.threadId;
      const blank = session.blank && !threadId;
      const draftText = session.composerText.slice(0, COMPOSER_DRAFT_LIMIT);
      const draftAttachments = draftAttachmentsForStore(session.composerAttachments);
      return {
        blank,
        ...(backendId ? { backendId } : {}),
        ...(threadId ? { threadId } : {}),
        title: session.title,
        ...(session === this.visible ? { active: true } : {}),
        ...(draftText ? { draftText } : {}),
        ...(draftAttachments.length > 0 ? { draftAttachments } : {})
      };
    });
    void this.context.workspaceState.update(OPEN_CHAT_TABS_KEY, tabs);
  }

  private publishTabs(): void {
    this.persistOpenTabs();
    const tabs = this.liveSessions().map((session) => {
      const backendId = session.activeThread?.backendId ?? session.resume?.backendId;
      const threadId = session.activeThread?.threadId ?? session.resume?.threadId;
      return {
        id: session.id,
        title: session.title,
        active: session === this.visible,
        ...(backendId ? { backendId } : {}),
        ...(threadId ? { threadId } : {})
      };
    });
    void this.view?.webview.postMessage({ type: 'chatTabs', tabs });
  }

  /** Keep one tab's unsent composer and write it with the open tabs. */
  private rememberComposer(session: ChatSession, text: string, attachments: Attachment[]): void {
    const previous = session.composerAttachments;
    const clean = parseDraftAttachments(attachments);
    session.composerText = text.slice(0, COMPOSER_DRAFT_LIMIT);
    session.composerAttachments = clean.map((attachment) => {
      const source = attachments.find((item) => item.id === attachment.id);
      const prior = previous.find((item) => item.id === attachment.id);
      const path = attachment.path ?? prior?.path;
      const dataUrl = source?.dataUrl ?? prior?.dataUrl;
      return {
        ...attachment,
        ...(path ? { path } : {}),
        ...(dataUrl ? { dataUrl } : {})
      };
    });
    this.queueComposerPersist(session);
  }

  private queueComposerPersist(session: ChatSession): void {
    const previous = this.composerPersistChain.get(session) ?? Promise.resolve();
    const next = previous
      .then(() => this.writeMissingDraftBlobs(session))
      .then(() => {
        this.persistOpenTabs();
      })
      .catch(() => undefined);
    this.composerPersistChain.set(session, next);
  }

  /** Paste images have no path. Write their bytes beside the workspace so a reload can read them. */
  private async writeMissingDraftBlobs(session: ChatSession): Promise<void> {
    const root = this.context.storageUri;
    if (!root) {
      return;
    }
    const pending = session.composerAttachments.filter((attachment) => !attachment.path && attachment.dataUrl);
    if (pending.length === 0) {
      return;
    }
    const dir = vscode.Uri.joinPath(root, 'composer-drafts');
    await vscode.workspace.fs.createDirectory(dir);
    for (const attachment of pending) {
      const current = session.composerAttachments.find((item) => item.id === attachment.id);
      if (!current || current.path || !current.dataUrl) {
        continue;
      }
      const bytes = decodeDataUrl(current.dataUrl);
      if (!bytes || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        continue;
      }
      const file = vscode.Uri.joinPath(dir, safeDraftFileName(current.id));
      await vscode.workspace.fs.writeFile(file, bytes);
      const still = session.composerAttachments.find((item) => item.id === current.id);
      if (still && !still.path) {
        still.path = file.fsPath;
      }
    }
  }

  /** Send the visible tab's unsent composer, re-reading images so thumbnails survive a reload. */
  private async postComposerDraft(session: ChatSession): Promise<void> {
    if (session.disposed || this.visible !== session) {
      return;
    }
    const attachments = await this.withImageBytes(session.composerAttachments);
    if (session.disposed || this.visible !== session) {
      return;
    }
    session.composerAttachments = attachments;
    this.post({
      type: 'composerDraft',
      tabId: session.id,
      text: session.composerText,
      attachments
    });
  }

  private async withImageBytes(attachments: readonly Attachment[]): Promise<Attachment[]> {
    const next: Attachment[] = [];
    for (const attachment of attachments) {
      if (attachment.dataUrl || attachment.kind !== 'image' || !attachment.path) {
        next.push(attachment);
        continue;
      }
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(attachment.path)).then(
        (value) => value,
        () => undefined
      );
      if (!bytes || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        next.push(attachment);
        continue;
      }
      next.push({
        ...attachment,
        dataUrl: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString('base64')}`
      });
    }
    return next;
  }

  private post(message: HostToWebviewMessage): void {
    if (!this.view) {
      return;
    }
    const shared =
      message.type === 'agentEvent' ||
      message.type === 'busy' ||
      message.type === 'snapshot' ||
      message.type === 'context' ||
      message.type === 'threads' ||
      message.type === 'chatTabs';
    if (!shared && this.session && this.visible && this.session !== this.visible) {
      return;
    }
    void this.view.webview.postMessage(message);
  }

  private async handle(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case 'composerDraft': {
        const session =
          (message.tabId ? this.liveSessions().find((entry) => entry.id === message.tabId) : undefined) ?? this.visible;
        if (session) {
          this.rememberComposer(session, message.text, message.attachments);
        }
        break;
      }
      case 'ready': {
        this.post({ type: 'snapshot', availability: this.registry.snapshot() });
        if (this.liveSessions().length === 0) {
          this.loadSavedSessions();
        }
        const session = this.visible && !this.visible.disposed ? this.visible : this.liveSessions()[0];
        if (session) {
          await this.showSession(session);
        }
        await this.postContextView();
        break;
      }
      case 'refresh':
        this.post({ type: 'snapshot', availability: await this.registry.refresh() });
        break;
      case 'refreshContext':
        await this.refreshContext();
        break;
      case 'setContextExclusions':
        this.setContextExclusions(message.keys);
        break;
      case 'resetContextExclusions':
        this.setContextExclusions([]);
        break;
      case 'setIncludeViewedFile':
        this.setIncludeViewedFile(message.included);
        break;
      case 'openContextFile':
        await this.openContextFile(message.path);
        break;
      case 'openPlanFile':
        await this.openPlanFile();
        break;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'melink');
        break;
      case 'setToken':
        await this.setToken(message.backendId);
        break;
      case 'clearToken':
        await this.clearToken(message.backendId);
        break;
      case 'listModels': {
        const result = await this.registry.listModels(message.backendId);
        this.post({
          type: 'models',
          backendId: message.backendId,
          models: result.models,
          error: result.error
        });
        break;
      }
      case 'listThreads':
        this.post({
          type: 'threads',
          backendId: message.backendId,
          threads: await this.registry.listThreads(message.backendId)
        });
        break;
      case 'resumeThread':
        await this.resumeThread(message.backendId, message.threadId);
        break;
      case 'startThread':
        await this.startThread(
          message.backendId,
          message.model,
          message.permissionLevel,
          message.mode,
          true,
          message.modelSettings
        );
        break;
      case 'sendTurn':
        await this.sendTurn(
          message.text,
          message.model,
          message.permissionLevel,
          message.modelSettings,
          message.attachments,
          message.backendId,
          message.updatePlan
        );
        break;
      case 'steerTurn':
        await this.steerTurn(message.text);
        break;
      case 'startDictation':
        await this.dictation.start(message.requestId);
        break;
      case 'stopDictation':
        await this.dictation.stop(message.requestId);
        break;
      case 'attachFiles':
        await this.attachFiles(message.requestId);
        break;
      case 'readClipboard':
        await this.readClipboard(message.requestId);
        break;
      case 'cancelTurn':
        this.cancelTurn();
        break;
      case 'compactContext':
        await this.compactContext(message.usedTokens, message.maxTokens);
        break;
      case 'decideApproval':
        this.decideApproval(message.backendId, message.threadId, message.requestId, message.decision);
        break;
      case 'answerQuestion':
        await this.answerQuestion(message.requestId, message.answers);
        break;
      case 'getPermissions':
        await this.postPermissions(message.backendId);
        break;
      case 'selectPermission':
        await this.selectPermissionLevel(message.level);
        break;
      case 'getModes':
        this.post({ type: 'modes', modes: this.modeSnapshot(message.backendId) });
        break;
      case 'selectMode':
        await this.selectMode(message.mode, false, message.backendId);
        break;
      case 'buildPlan':
        await this.buildPlan();
        break;
      case 'rejectPlan':
        await this.rejectPlan();
        break;
      case 'writePlan':
        await this.writePlan(message.title, message.summary, message.steps, message.body);
        break;
      case 'setTodoStepStatus':
        await this.setTodoStepStatus(message.step, message.status);
        break;
      case 'revokeApprovalRule': {
        await this.registry.revokeApprovalRule(message.backendId, message.ruleId);
        await this.postPermissions(message.backendId);
        break;
      }
      case 'getSettings':
        this.post({ type: 'settings', settings: await this.settingsSnapshot() });
        break;
      case 'saveSettings':
        await this.saveSettings(message.patch);
        break;
      case 'setOllamaToken':
        await this.settings.setOllamaToken(message.value);
        this.post({ type: 'settings', settings: await this.settingsSnapshot() });
        this.post({ type: 'snapshot', availability: await this.registry.refresh() });
        break;
      case 'clearOllamaToken':
        await this.settings.clearOllamaToken();
        this.post({ type: 'settings', settings: await this.settingsSnapshot() });
        this.post({ type: 'snapshot', availability: await this.registry.refresh() });
        break;
      case 'testConnection':
        this.post({ type: 'connectionTest', result: await this.settings.testConnection(message.backendId) });
        break;
      case 'upgradeOpencode': {
        this.post({ type: 'opencodeUpgrade', pending: true });
        const upgraded = await this.settings.upgradeOpencode();
        this.post({
          type: 'opencodeUpgrade',
          pending: false,
          ok: upgraded.ok,
          message: upgraded.message
        });
        if (upgraded.ok) {
          this.post({ type: 'settings', settings: await this.settingsSnapshot() });
        }
        break;
      }
      case 'installOpencode': {
        this.post({ type: 'opencodeInstall', pending: true });
        const installed = await this.settings.installOpencode();
        if (installed.ok && installed.executablePath) {
          this.post({ type: 'settings', settings: await this.settingsSnapshot() });
        }
        this.post({
          type: 'opencodeInstall',
          pending: false,
          ok: installed.ok,
          message: installed.message,
          ...(installed.executablePath ? { path: installed.executablePath } : {})
        });
        break;
      }
      case 'getModelCapability':
        await this.postModelCapability(message.providerId, message.modelId);
        break;
      case 'setModelSettings':
        await this.setModelSettings(message.providerId, message.modelId, message.settings);
        break;
      case 'resetModelSettings':
        await this.resetModelSettings(message.providerId, message.modelId);
        break;
      case 'resetModelSettingField':
        await this.resetModelSettingField(message.providerId, message.modelId, message.field);
        break;
      case 'changes/list':
        await this.postChangeReview(message.backendId, message.threadId, message.turnId);
        break;
      case 'changes/hunks':
        await this.postChangeHunks(message.backendId, message.threadId, message.turnId, message.path);
        break;
      case 'changes/decide':
        await this.decideChange(message);
        break;
      case 'changes/decideAll':
        await this.decideAllChanges(message);
        break;
      case 'changes/listCheckpoints':
        await this.postCheckpoints(message.backendId, message.threadId);
        break;
      case 'changes/previewRestore':
        await this.previewRestore(message);
        break;
      case 'changes/restoreCheckpoint':
        await this.restoreCheckpoint(message);
        break;
      case 'changes/openDiff':
        await this.openChangeDiff(message.turnId, message.path);
        break;
      case 'changes/openView':
        await this.openTurnChanges(message.turnId);
        break;
      case 'changes/reveal':
        await this.nativeDiff.revealInSourceControl(message.path);
        break;
    }
  }

  /**
   * The capability descriptor + effective settings for one model, resolved by
   * the registry. The webview receives only the neutral vocabulary: it never
   * sees an Ollama or Codex field name.
   */
  private async postModelCapability(providerId: string, modelId: string): Promise<void> {
    try {
      const [capabilities, settings] = await Promise.all([
        this.registry.modelCapabilities(providerId, modelId),
        this.registry.resolveModelSettings(providerId, modelId, this.appDefaults())
      ]);
      this.post({ type: 'modelCapability', capability: { providerId, modelId, capabilities, settings } });
    } catch (error) {
      // A read that fails outright is reported as data, so the panel shows an
      // explanation and a retry rather than spinning forever.
      this.post({
        type: 'modelCapabilityError',
        providerId,
        modelId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Persist a per-model override and echo the resolved settings back. The value
   * is clamped against the model's reported range inside the registry, so an
   * out-of-range patch never persists and the echo is the value that will be
   * sent on the next turn.
   */
  private async setModelSettings(
    providerId: string,
    modelId: string,
    settings: import('./backends/types').ModelSettingOverrides
  ): Promise<void> {
    await this.registry.setModelSettings(providerId, modelId, settings);
    await this.postModelCapability(providerId, modelId);
  }

  /** Drop every override for one model and echo the re-resolved settings. */
  private async resetModelSettings(providerId: string, modelId: string): Promise<void> {
    await this.registry.resetModelSettings(providerId, modelId);
    await this.postModelCapability(providerId, modelId);
  }

  /** Drop one field's override only and echo the re-resolved settings. */
  private async resetModelSettingField(
    providerId: string,
    modelId: string,
    field: import('./backends/types').ModelSettingField
  ): Promise<void> {
    await this.registry.resetModelSettingField(providerId, modelId, field);
    await this.postModelCapability(providerId, modelId);
  }

  /** The app-level defaults a per-model setting falls back to. */
  private appDefaults(): import('./backends/capabilities').AppDefaults {
    return { thinking: readDefaultThinking() };
  }

  /**
   * The permission read model for one backend: only the levels it actually
   * serves, which one needs the labelled confirmation, and the stored `always`
   * rules so they can be listed and revoked.
   */
  /** Push a fresh permission read model, including the stored `always` rules. */
  private async postPermissions(backendId: string): Promise<void> {
    this.post({ type: 'permissions', permissions: await this.permissionSnapshot(backendId) });
  }

  private async permissionSnapshot(backendId: string): Promise<PermissionSnapshot> {
    const backend = this.registry.get(backendId);
    const levels = this.registry.permissionLevels(backendId);
    return {
      backendId,
      hasApprovalChannel: this.registry.hasApprovalChannel(backendId),
      options: levels.map((level) => {
        const descriptor = permissionDescriptor(level);
        return {
          level,
          label: descriptor.label,
          description: descriptor.description,
          requiresConfirmation: descriptor.requiresConfirmation
        };
      }),
      selected: this.permissionLevel,
      epoch: this.permissionEpoch,
      rules: backend ? await this.registry.listApprovalRules(backendId) : []
    };
  }

  /**
   * The mode read model for one backend: only the modes it reports it can
   * honour, so a mode that would silently behave like Agent is hidden. The
   * `selected` value is the mode the active conversation runs in, or the stored
   * default before a thread exists.
   */
  private modeSnapshot(backendId: string): ModeSnapshot {
    const supported = supportedModes(this.registry.modes(backendId));
    const selected = this.resolveMode(backendId, this.mode);
    return {
      backendId,
      options: supported.map((mode) => {
        const descriptor = modeDescriptor(mode);
        return { mode, label: descriptor.label, description: descriptor.description };
      }),
      selected
    };
  }

  /**
   * Resolve a requested mode against what the backend can serve. A mode the
   * backend cannot honour degrades to `agent` rather than being sent and
   * silently behaving like Agent.
   */
  private resolveMode(backendId: string, requested?: DefaultMode): DefaultMode {
    const supported = this.registry.modes(backendId);
    if (requested && supported.includes(requested)) {
      return requested;
    }
    return supported.includes('agent') ? 'agent' : supported[0] ?? 'agent';
  }

  /**
   * Select the mode for the active conversation. Applies to the next turn only:
   * nothing here touches the transcript. The mode is persisted with the thread
   * index so a resumed thread keeps it.
   */
  private async selectMode(requested: DefaultMode, fromInitialRequest = false, backendId?: string): Promise<void> {
    if (this.turnInProgress && !fromInitialRequest) {
      this.post({ type: 'notice', level: 'info', message: 'Mode changes apply after the current request finishes.' });
      return;
    }
    const target = backendId ?? this.activeThread?.backendId ?? this.defaultBackendId();
    const mode = this.resolveMode(target, requested);
    this.mode = mode;
    const thread = this.activeThread;
    if (thread && thread.backendId === target) {
      await this.store.setActiveThread({
        backendId: thread.backendId,
        threadId: thread.threadId,
        modelId: thread.model,
        mode,
        title: this.store.getActiveThread()?.title,
        updatedAt: Date.now()
      });
    }
    this.post({ type: 'modes', modes: this.modeSnapshot(target) });
  }

  /** The settings read model plus the live model lists, so the default-model
   * picker can offer real choices without a second round trip. A provider whose
   * list fails is simply absent; it is never shown as an empty list.
   */
  private async settingsSnapshot(): Promise<import('./protocol').SettingsSnapshot> {
    const snapshot = await this.settings.snapshot();
    for (const backend of this.registry.snapshot()) {
      if (backend.status === 'available') {
        const result = await this.registry.listModels(backend.id);
        snapshot.models[backend.id] = result.models;
      }
    }
    return snapshot;
  }

  /**
   * Persist the settings patch, then echo the fresh read model so the screen
   * reflects exactly what was stored (including any field the host refused).
   */
  private async saveSettings(patch: import('./protocol').SettingsPatch): Promise<void> {
    const result = await this.settings.save(patch);
    // A saved context change must apply to the next turn of an already-open
    // conversation, not just to a new one. The delivery layer holds a rendered
    // snapshot prefix per thread; drop it so the next turn rebuilds from the new
    // include flags, cap, and patterns. Rebuilding from the current settings is
    // correct even if an unrelated field in the same patch was refused, so this
    // is unconditional on a context patch.
    if (Object.keys(patch).some((key) => key.startsWith('context'))) {
      this.contextDelivery.invalidateAll();
    }
    // Echo any refused field back on the snapshot so the screen marks it not
    // saved inline; a refused value was never persisted.
    const snapshot = await this.settingsSnapshot();
    if (!result.ok) {
      snapshot.saveErrors = result.errors;
    }
    if (patch.permissionLevel && result.errors.permissionLevel === undefined) {
      const backendId = this.activeThread?.backendId ?? this.defaultBackendId();
      await this.rememberPermission(this.resolvePermission(backendId, patch.permissionLevel));
      await this.postPermissions(backendId);
    }
    this.post({ type: 'settings', settings: snapshot });
    this.post({ type: 'snapshot', availability: await this.registry.refresh() });
    if (Object.keys(patch).some((key) => key.startsWith('context'))) {
      await this.postContextView();
    }
  }

  /**
   * Re-arm context delivery after a `melink.context` configuration change made
   * outside this screen (the VS Code settings UI, a settings.json edit, or a
   * workspace switch). Without this, an open conversation would keep re-sending
   * the snapshot rendered under the previous settings.
   */
  invalidateContextDelivery(): void {
    this.contextDelivery.invalidateAll();
  }

  /**
   * Opens an empty conversation, re-applying the last-used model so reopening a
   * window still lands on the model the user last chose.
   */
  /**
   * Re-read and push the context view. Called when the active editor or the
   * selection changes, so the strip follows the user between files and
   * selections without a reload and without touching the transcript.
   *
   * Coalesced: selection events fire per cursor move, so a burst schedules one
   * read rather than one per event, and the read only rebuilds editor state
   * (the cached tree is untouched), so it stays cheap while typing.
   */
  refreshContextView(): void {
    if (this.contextViewTimer) {
      return;
    }
    this.contextViewTimer = setTimeout(() => {
      this.contextViewTimer = undefined;
      void this.postContextView();
    }, 120);
  }

  private postFreshConversation(): void {
    const last = this.store.getLastUsedModel();
    const backendId = last && this.registry.get(last.backendId) ? last.backendId : this.defaultBackendId();
    this.permissionLevel = this.resolvePermission(backendId, this.permissionLevel);
    this.mode = this.resolveMode(backendId, readDefaultMode());
    this.post({
      type: 'conversation',
      backendId,
      model: last?.modelId || undefined,
      permissionLevel: this.permissionLevel,
      mode: this.mode
    });
  }

  private defaultBackendId(): string {
    return this.registry.snapshot().find((backend) => backend.status === 'available')?.id ?? 'ollama';
  }

  /**
   * One-click route from an unauthenticated provider entry. Ollama collects a
   * bearer token; a provider without a token flow (Codex signs in through its
   * own CLI) falls through to settings rather than showing a raw 401.
   */
  private async setToken(backendId: string): Promise<void> {
    if (backendId !== 'ollama') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'melink');
      this.post({ type: 'snapshot', availability: await this.registry.refresh() });
      return;
    }
    const value = await vscode.window.showInputBox({
      title: 'Ollama Cloud token',
      prompt: 'Stored in VS Code secret storage and sent only to the configured base URL.',
      password: true,
      ignoreFocusOut: true
    });
    if (value === undefined) {
      return;
    }
    await this.context.secrets.store(OLLAMA_TOKEN_SECRET_KEY, value);
    this.post({ type: 'snapshot', availability: await this.registry.refresh() });
  }

  private async clearToken(backendId: string): Promise<void> {
    if (backendId !== 'ollama') {
      return;
    }
    await this.context.secrets.delete(OLLAMA_TOKEN_SECRET_KEY);
    this.post({ type: 'snapshot', availability: await this.registry.refresh() });
  }

  /**
   * Starts a new thread at the given permission level, updates the persisted
   * reference, and leaves the prior thread in the workspace index so
   * `thread/list` still surfaces it.
   *
   * `notify: false` is used for an implicit start on the first turn, where the
   * webview already shows the optimistic user message and a `conversation`
   * message would clear it.
   */
  private async startThread(
    backendId: string,
    model?: string,
    permissionLevel?: PermissionLevel,
    requestedMode?: DefaultMode,
    notify = true,
    requestedSettings?: import('./backends/types').ModelSettingOverrides,
    keepPendingUserMessage = false,
    handover?: string
  ): Promise<void> {
    const backend = this.registry.get(backendId);
    if (!backend) {
      this.post({ type: 'notice', level: 'error', message: `Backend ${backendId} is not registered.` });
      return;
    }
    // An explicit level wins. Otherwise keep the last picker choice, which is
    // seeded from the settings default until the user picks one. A new chat
    // does not drop that choice. The mode still falls back to its stored default.
    const level = this.resolvePermission(backendId, permissionLevel ?? this.permissionLevel);
    const mode = this.resolveMode(backendId, requestedMode ?? readDefaultMode());
    // The effective per-model settings are resolved and clamped here, in the
    // host, against the provider's own descriptor. The webview never computes a
    // value, so a stale value can never reach the provider.
    const modelSettings = await this.resolveTurnSettings(backendId, model, requestedSettings);
    // Starting a new conversation ends the previous one, so its session allows
    // are dropped here rather than lingering into unrelated work. Any request
    // still open on the old thread is abandoned with it.
    this.pendingApproval = undefined;
    const previous = this.activeThread;
    if (previous) {
      await this.registry.endThreadSession(previous.backendId, previous.threadId);
      this.contextDelivery.forget(ContextDelivery.key(previous.backendId, previous.threadId));
    }
    try {
      await this.store.flush();
      // Open the session's context: a full snapshot, consumed natively by an
      // adapter that can, or queued for the first turn otherwise. A failed
      // snapshot degrades to a notice and never blocks the start.
      const prime = await this.contextDelivery.snapshot();
      const handle = await backend.startThread({
        model,
        permissionLevel: level,
        mode,
        modelSettings,
        context: prime.payload,
        handover
      });
      this.activeThread = handle;
      this.syncPlanPreviewThread(handle.threadId);
      this.contextDelivery.begin(ContextDelivery.key(backendId, handle.threadId), prime, Boolean(handle.contextPrimed));
      await this.rememberPermission(level);
      this.mode = mode;
      const seeded = handover?.trim() ? compactedTranscript(handover) : undefined;
      if (seeded) {
        this.store.setTranscript(backendId, handle.threadId, seeded);
      }
      if (handover?.trim() && previous) {
        const plan = this.store.getPlanState(previous.backendId, previous.threadId);
        if (plan) {
          await this.store.setPlanState(backendId, handle.threadId, { ...plan, updatedAt: Date.now() });
        }
      }
      await this.store.setActiveThread({
        backendId,
        threadId: handle.threadId,
        modelId: model ?? handle.model,
        mode,
        updatedAt: Date.now(),
        ...(handover?.trim() ? { handoverSummary: handover.trim() } : {})
      });
      await this.store.setLastUsedModel({ backendId, modelId: model ?? handle.model ?? '' });
      if (notify) {
        this.post({
          type: 'conversation',
          backendId,
          threadId: handle.threadId,
          model: model ?? handle.model,
          permissionLevel: level,
          mode,
          pendingQuestion: this.pendingQuestionPayload(backendId, handle.threadId),
          ...(seeded ? { replay: seeded } : {}),
          ...(this.store.getPlanState(backendId, handle.threadId)
            ? { plan: this.planArtifact(backendId, handle.threadId) }
            : {}),
          ...(keepPendingUserMessage ? { keepPendingUserMessage: true } : {})
        });
      }
    } catch (error) {
      this.post({ type: 'notice', level: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Resolve the per-model settings for the turn about to be sent.
   *
   * When the webview supplied an explicit patch it is persisted as an override;
   * otherwise the already-stored override (if any) is used. Either way the value
   * is clamped against the model's reported range, so what the adapter receives
   * is always something the model accepts.
   */
  private async resolveTurnSettings(
    backendId: string,
    model: string | undefined,
    requested?: import('./backends/types').ModelSettingOverrides
  ): Promise<import('./backends/types').ModelSettingOverrides> {
    if (!model) {
      return {};
    }
    const resolved = requested
      ? await this.registry.setModelSettings(backendId, model, requested)
      : await this.registry.resolveModelSettings(backendId, model, this.appDefaults());
    return overridesFromResolved(resolved);
  }

  /**
   * Resolve a requested level against what the backend can serve.
   *
   * `unrestricted` is honored only when the backend exposes it *and* the user
   * selected it; it can never be reached as a fallback. An unknown level, or a
   * level the backend does not offer, degrades to the safest supported one.
   */
  /**
   * Store the level the picker, a turn, or the settings screen just confirmed.
   * The next chat reads it back instead of the settings default.
   */
  private async rememberPermission(level: PermissionLevel): Promise<void> {
    this.permissionLevel = level;
    this.permissionEpoch += 1;
    await this.store.setLastPermissionLevel(level);
  }

  /** Apply a picker choice and echo it so the panel matches what the next chat will use. */
  private async selectPermissionLevel(requested: PermissionLevel): Promise<void> {
    const backendId = this.activeThread?.backendId ?? this.defaultBackendId();
    await this.rememberPermission(this.resolvePermission(backendId, requested));
    await this.postPermissions(backendId);
  }

  private resolvePermission(backendId: string, requested?: PermissionLevel): PermissionLevel {
    const supported = this.registry.permissionLevels(backendId);
    if (requested && supported.includes(requested)) {
      return requested;
    }
    return supported.includes('default') ? 'default' : supported[0] ?? 'default';
  }

  /** Reconnects to a listed thread and replays its stored turns. */
  private async resumeThread(backendId: string, threadId: string): Promise<void> {
    this.post({ type: 'restoring', value: true });
    try {
      const backend = this.registry.get(backendId);
      if (!backend) {
        this.post({
          type: 'notice',
          level: 'warning',
          message: 'That conversation could not be restored because its provider is not available.'
        });
        return;
      }
      // A resumed thread is re-primed with a fresh snapshot, because the upstream
      // context may be gone after the replay.
      const prime = await this.contextDelivery.snapshot();
      const stored = this.store.listThreads(backendId).find((entry) => entry.threadId === threadId);
      const result = await backend.resumeThread(threadId, {
        context: prime.payload,
        handover: stored?.handoverSummary
      });
      this.activeThread = result.handle;
      this.syncPlanPreviewThread(result.handle.threadId);
      this.contextDelivery.begin(
        ContextDelivery.key(backendId, threadId),
        prime,
        Boolean(result.handle.contextPrimed)
      );
      // The thread index carries the mode, so a resumed thread keeps its mode;
      // a mode the backend cannot serve degrades to `agent`.
      const ref = stored ?? this.store.listThreads(backendId).find((entry) => entry.threadId === threadId);
      this.mode = this.resolveMode(backendId, ref?.mode ?? this.mode);
      const titled =
        ref?.title ?? result.items.find((item) => item.role === 'user' && item.text?.trim())?.text;
      await this.store.setActiveThread({
        backendId,
        threadId,
        modelId: result.model,
        mode: this.mode,
        title: titled ? ThreadStore.titleFromText(titled) ?? titled : undefined,
        updatedAt: Date.now()
      });
      if (this.session) {
        this.session.blank = false;
        this.session.title = tabTitle(titled);
        this.publishTabs();
      }
      this.post({
        type: 'conversation',
        backendId,
        threadId,
        model: result.model,
        permissionLevel: this.permissionLevel,
        mode: this.mode,
        replay: this.store.mergeApprovalMarkers(
          backendId,
          threadId,
          ref?.handoverSummary && !compactedSummary(result.items)
            ? [...compactedTranscript(ref.handoverSummary), ...result.items]
            : result.items
        ),
        pendingApproval: this.pendingApproval,
        pendingQuestion: this.pendingQuestionPayload(backendId, threadId),
        plan: this.store.getPlanState(backendId, threadId)
          ? this.planArtifact(backendId, threadId)
          : undefined
      });
      // Repaint the resumed thread's own recorded change set, so the change
      // surface matches the thread now in view rather than carrying the previous
      // conversation's files.
      await this.postLatestChanges();
      await this.postActiveCheckpoints();
    } catch (error) {
      this.post({
        type: 'notice',
        level: 'warning',
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.post({ type: 'restoring', value: false });
    }
  }

  private async sendTurn(
    text: string,
    model?: string,
    permissionLevel?: PermissionLevel,
    requestedSettings?: import('./backends/types').ModelSettingOverrides,
    attachments?: Attachment[],
    backendId?: string,
    updatePlan?: boolean
  ): Promise<void> {
    if (this.turnInProgress) {
      this.autopilotSend = false;
      this.post({ type: 'notice', level: 'info', message: 'A request is already in progress. Wait for it to finish before sending another.' });
      return;
    }
    this.turnInProgress = true;
    try {
      await this.sendTurnCore(text, model, permissionLevel, requestedSettings, attachments, backendId, updatePlan);
    } finally {
      this.turnInProgress = false;
      this.flushPlanAutopilot();
    }
  }

  /**
   * Compact the open chat into a summary the next provider can continue from.
   * Returns the summary, `undefined` when there is nothing to carry, or
   * `'failed'` when the summary could not be produced. A failure leaves the
   * current thread in place.
   */
  private async compactHandover(thread: ThreadHandle): Promise<string | undefined | 'failed'> {
    const transcript = this.store.getTranscript(thread.backendId, thread.threadId);
    if (!compactionSource(transcript).trim()) {
      return undefined;
    }
    const backend = this.registry.get(thread.backendId);
    if (!backend) {
      return undefined;
    }
    this.post({ type: 'busy', value: true });
    this.post({
      type: 'notice',
      level: 'info',
      message: 'Compacting this chat so it can continue on the other provider.'
    });
    try {
      const modelSettings = await this.resolveTurnSettings(thread.backendId, thread.model);
      const summary = await backend.summarize({
        model: thread.model,
        modelSettings,
        transcript,
        maxTokens: modelSettings.contextWindow
      });
      const text = summary.trim();
      if (!text) {
        throw new BackendError('provider', 'Compaction did not return a summary.');
      }
      return text;
    } catch (error) {
      this.post({ type: 'busy', value: false });
      const message =
        error instanceof BackendError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Context could not be compacted.';
      this.post({
        type: 'notice',
        level: message === 'Compaction canceled.' ? 'info' : 'error',
        message
      });
      return 'failed';
    }
  }

  /**
   * Compact the active thread when the ring says the window is above 25% and
   * nothing else is running. Codex compacts in the app-server. Ollama returns
   * a replacement transcript, which is what the next turn is built from.
   */
  private async compactContext(usedTokens: number, maxTokens: number): Promise<void> {
    if (this.turnInProgress || !canCompactContext(contextUsagePercent(usedTokens, maxTokens), false)) {
      return;
    }
    const active = this.activeThread;
    if (!active) {
      this.post({ type: 'notice', level: 'info', message: 'Start a conversation before compacting context.' });
      return;
    }
    const backend = this.registry.get(active.backendId);
    if (!backend) {
      return;
    }
    this.turnInProgress = true;
    this.post({ type: 'busy', value: true, backendId: active.backendId, threadId: active.threadId });
    try {
      const model = active.model;
      const modelSettings = await this.resolveTurnSettings(active.backendId, model);
      const result = await backend.compact(
        { backendId: active.backendId, threadId: active.threadId, model },
        {
          model,
          modelSettings,
          transcript: this.store.getTranscript(active.backendId, active.threadId),
          maxTokens
        }
      );
      if (result.transcript) {
        this.store.setTranscript(active.backendId, active.threadId, result.transcript);
        await this.store.flush();
        this.post({
          type: 'conversation',
          backendId: active.backendId,
          threadId: active.threadId,
          model,
          permissionLevel: this.permissionLevel,
          mode: this.mode,
          replay: result.transcript,
          pendingQuestion: this.pendingQuestionPayload(active.backendId, active.threadId),
          plan: this.store.getPlanState(active.backendId, active.threadId)
            ? this.planArtifact(active.backendId, active.threadId)
            : undefined
        });
      }
    } catch (error) {
      const message =
        error instanceof BackendError ? error.message : error instanceof Error ? error.message : 'Context could not be compacted.';
      this.post({
        type: 'notice',
        level: message === 'Compaction canceled.' ? 'info' : 'error',
        message
      });
    } finally {
      this.turnInProgress = false;
      this.post({ type: 'busy', value: false, backendId: active.backendId, threadId: active.threadId });
    }
  }

  /**
   * Rewrite a transcript with the settings model. Ollama uses a one-shot chat
   * call. Codex uses a throwaway read-only thread that is not shown in the chat.
   */
  private async cleanupTranscript(text: string): Promise<string> {
    const target = parseDictationTarget(
      vscode.workspace.getConfiguration('melink.defaults').get<string>('dictationModel', '')
    );
    if (!target) {
      throw new Error('Choose a dictation model in Settings.');
    }
    if (target.backendId === 'ollama') {
      const backend = this.registry.get('ollama');
      if (!(backend instanceof OllamaBackend)) {
        throw new Error('Dictation needs Ollama for that model.');
      }
      return backend.cleanDictation(text, target.modelId);
    }
    const backend = this.registry.get('codex');
    if (!(backend instanceof CodexBackend)) {
      throw new Error('Dictation needs Codex for that model.');
    }
    return backend.cleanDictation(text, target.modelId);
  }

  private async steerTurn(text: string): Promise<void> {
    const value = text.trim();
    const active = this.activeThread;
    if (!value || !this.turnInProgress || !active) return;
    const backend = this.registry.get(active.backendId);
    if (!backend?.steerTurn) {
      this.post({ type: 'notice', level: 'info', message: 'This provider cannot accept steer messages while busy.' });
      return;
    }
    try {
      const messageId = await this.store.appendUserMessage(active.backendId, active.threadId, value);
      await this.captureSentMessage(active.backendId, active.threadId, messageId);
      await backend.steerTurn(active, this.consumeRewindNote(active.backendId, active.threadId, value), messageId);
      await this.store.flush();
    } catch (error) {
      this.post({ type: 'notice', level: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Detect mode only before this user request enters a provider turn. */
  private async sendTurnCore(
    text: string,
    model?: string,
    permissionLevel?: PermissionLevel,
    requestedSettings?: import('./backends/types').ModelSettingOverrides,
    attachments?: Attachment[],
    backendId?: string,
    updatePlan?: boolean
  ): Promise<void> {
    const automatic = this.autopilotSend;
    this.autopilotSend = false;
    if (this.session) {
      this.session.planRunAutomatic = automatic;
      if (!automatic) {
        this.planAutopilotQueue.delete(this.session.id);
        this.session.planEpoch += 1;
        this.session.planRunSignature = undefined;
      }
    }
    this.revisePlanThisTurn = updatePlan === true || userAsksToRevisePlan(text);
    const candidateBackend = backendId ?? this.activeThread?.backendId ??
      this.registry.snapshot().find((backend) => backend.status === 'available')?.id;
    if (candidateBackend) {
      const currentMode = this.resolveMode(candidateBackend, this.mode);
      const suggestedMode = inferRequestedMode(text);
      const supported = this.registry.modes(candidateBackend);
      // Ask stays an explicit user choice. Automatically narrowing an Agent
      // request to Ask can block tool work the user expected to happen.
      if (suggestedMode && suggestedMode !== 'ask' && suggestedMode !== currentMode && supported.includes(suggestedMode)) {
        let selectedMode: DefaultMode | undefined;
        if (modeIsMoreRestrictive(currentMode, suggestedMode)) {
          selectedMode = suggestedMode;
        } else {
          const choice = await vscode.window.showInformationMessage(
            `This request sounds like it needs ${suggestedMode === 'agent' ? 'Agent' : suggestedMode === 'plan' ? 'Plan' : 'Ask'} mode. Switch from ${currentMode === 'plan' ? 'Plan' : 'Ask'} and continue?`,
            { modal: true },
            'Switch and continue',
            'Stay in current mode'
          );
          selectedMode = choice === 'Switch and continue' ? suggestedMode : undefined;
        }
        if (selectedMode) {
          await this.selectMode(selectedMode, true, candidateBackend);
          this.post({
            type: 'notice',
            level: 'info',
            message: `Switched to ${selectedMode === 'agent' ? 'Agent' : selectedMode === 'plan' ? 'Plan' : 'Ask'} mode for this request.`
          });
        }
      }
    }
    if (!candidateBackend) {
      this.post({ type: 'notice', level: 'warning', message: 'No available backend to send the turn.' });
      return;
    }
    // A model pick only updates the webview. A different provider continues
    // this chat: the current transcript is compacted, and that summary is the
    // next thread's opening context. An empty chat just opens a thread.
    let handover: string | undefined;
    if (this.activeThread && this.activeThread.backendId !== candidateBackend) {
      const summary = await this.compactHandover(this.activeThread);
      if (summary === 'failed') {
        return;
      }
      handover = summary;
    }
    if (this.activeThread?.backendId !== candidateBackend) {
      await this.startThread(
        candidateBackend,
        model,
        permissionLevel,
        this.mode,
        true,
        requestedSettings,
        true,
        handover
      );
    }
    if (!this.activeThread || this.activeThread.backendId !== candidateBackend) {
      this.post({ type: 'busy', value: false });
      return;
    }
    const { backendId: activeBackendId, threadId } = this.activeThread;
    const backend = this.registry.get(activeBackendId);
    if (!backend) {
      return;
    }
    // Inline clipboard image bytes are for the outgoing turn only; the durable
    // transcript keeps names and sizes, never file contents.
    const persisted = persistableAttachments(attachments);
    const resolvedModel = model ?? this.activeThread.model;
    const level = this.resolvePermission(activeBackendId, permissionLevel ?? this.permissionLevel);
    await this.rememberPermission(level);
    // The mode is resolved and re-applied on every turn. Ask forces read-only;
    // Plan and Agent honor the selected permission level.
    const mode = this.resolveMode(activeBackendId, this.mode);
    this.mode = mode;
    // The per-model settings are resolved and clamped in the host, so a stale
    // value can never be sent.
    const modelSettings = await this.resolveTurnSettings(activeBackendId, resolvedModel, requestedSettings);
    // Context for this turn: the queued snapshot on the first turn (unless an
    // adapter consumed it natively at start), otherwise a compact delta. It is
    // read before the user message is appended so it never touches the stored
    // transcript, and a failed snapshot degrades to a notice rather than
    // blocking the turn.
    const context = await this.turnContext(activeBackendId, threadId);
    // The exclusions shaped the snapshot this turn carries, so they are cleared
    // now: the next turn defaults back to the full set unless the user excludes
    // again, and nothing is re-added on its own mid-turn.
    if (this.contextDelivery.exclusionKeys().length > 0) {
      this.contextDelivery.setExclusions([]);
      void this.postContextView();
    }
    if (!automatic) {
      await this.dismissCompletedPlan(activeBackendId, threadId);
    }
    const messageId = await this.store.appendUserMessage(activeBackendId, threadId, text, persisted);
    const indexed = this.store.listThreads(activeBackendId).find((entry) => entry.threadId === threadId);
    const title = indexed?.title ?? ThreadStore.titleFromText(text);
    await this.store.setActiveThread({
      backendId: activeBackendId,
      threadId,
      modelId: resolvedModel,
      mode,
      title,
      updatedAt: Date.now()
    });
    if (this.session && (this.session.blank || this.session.title === DEFAULT_TAB_TITLE)) {
      const label = tabTitle(text);
      if (label !== DEFAULT_TAB_TITLE) {
        this.session.title = label;
      }
      this.session.blank = false;
      this.publishTabs();
    }
    await this.store.setLastUsedModel({ backendId: activeBackendId, modelId: resolvedModel ?? '' });
    this.post({ type: 'busy', value: true, backendId: activeBackendId, threadId });
    // Bind the next turn boundary to this user message, so the turn's pre-state
    // snapshot becomes this message's checkpoint. `turn/started` consumes it;
    // a send that never starts a turn must not strand it on a later turn.
    this.pendingTurnMessage = { messageId, backendId: activeBackendId, threadId };
    await this.captureSentMessage(activeBackendId, threadId, messageId);
    if (this.session) {
      this.session.turnOpen = true;
    }
    try {
      await backend.sendTurn(
        { backendId: activeBackendId, threadId, model: resolvedModel },
        {
          text: this.consumeRewindNote(activeBackendId, threadId, text),
          model: resolvedModel,
          permissionLevel: level,
          mode,
          modelSettings,
          context,
          attachments
        }
      );
    } catch (error) {
      this.pendingTurnMessage = undefined;
      if (this.session) {
        this.session.turnOpen = false;
      }
      if (error instanceof BackendError && error.code === 'unauthenticated') {
        this.post({ type: 'notice', level: 'warning', message: error.message, action: 'setToken' });
      } else if (!isCancellation(error)) {
        this.post({ type: 'notice', level: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      await this.store.flush();
      this.post({ type: 'busy', value: false, backendId: activeBackendId, threadId });
    }
  }

  /**
   * Opens a native multi-select file picker for attachments and answers with
   * the chosen files' metadata. A dismissed picker answers `cancelled`, which
   * leaves the composer unchanged; nothing is logged and no file is read.
   */
  private async attachFiles(requestId: string): Promise<void> {
    let uris: vscode.Uri[] | undefined;
    try {
      uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Attach',
        title: 'Attach files',
        filters: {
          Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
          Audio: ['mp3', 'wav', 'm4a', 'ogg', 'webm'],
          'Text and code': [
            'txt',
            'md',
            'markdown',
            'json',
            'jsonc',
            'yaml',
            'yml',
            'toml',
            'csv',
            'log',
            'xml',
            'html',
            'css',
            'scss',
            'less',
            'js',
            'jsx',
            'ts',
            'tsx',
            'py',
            'rb',
            'go',
            'rs',
            'java',
            'kt',
            'c',
            'h',
            'cpp',
            'hpp',
            'cs',
            'sh',
            'ps1',
            'sql'
          ],
          'All files': ['*']
        }
      });
    } catch {
      this.post({ type: 'attachmentError', message: 'The file picker could not be opened.', requestId });
      return;
    }
    if (!uris || uris.length === 0) {
      this.post({ type: 'attachmentsPicked', requestId, attachments: [], cancelled: true });
      return;
    }
    const attachments: Attachment[] = [];
    let skipped = 0;
    for (const uri of uris) {
      const attachment = await this.describeFile(uri);
      if (attachment) {
        attachments.push(attachment);
        continue;
      }
      skipped += 1;
    }
    this.post({ type: 'attachmentsPicked', requestId, attachments });
    if (skipped > 0) {
      // One sentence for the whole pick; it names no path and no file content.
      this.post({
        type: 'attachmentError',
        message:
          skipped === 1
            ? 'One file could not be attached because it was unreadable, unsupported, or too large.'
            : `${skipped} files could not be attached because they were unreadable, unsupported, or too large.`
      });
    }
  }

  /**
   * Fallback when the webview cannot read pasted bytes for itself. The VS Code
   * clipboard API is text-only, so there is no image byte stream to attach here;
   * this reads what it can and reports a precise outcome instead of leaving the
   * paste a silent no-op. A path or file content is never logged.
   */
  private async readClipboard(requestId: string): Promise<void> {
    let text = '';
    try {
      text = await vscode.env.clipboard.readText();
    } catch {
      this.post({ type: 'attachmentError', message: 'The clipboard could not be read.', requestId });
      return;
    }
    this.post({
      type: 'attachmentError',
      message: text.trim().length > 0
        ? 'That clipboard content is text only. Paste it directly into the message.'
        : 'That clipboard content cannot be attached. Copy an image and paste again.',
      requestId
    });
  }

  /**
   * Builds an attachment descriptor from a picked file. The basename, type, and
   * size always cross the protocol. An image is also read into a data URL so
   * the webview can paint a thumbnail and a viewer; that payload is stripped
   * before anything is persisted. An oversized or unreadable file returns
   * `undefined` so the pick can report it as one skipped item.
   */
  private async describeFile(uri: vscode.Uri): Promise<Attachment | undefined> {
    const stat = await vscode.workspace.fs.stat(uri).then(
      (value) => value,
      () => undefined
    );
    if (!stat || stat.type === vscode.FileType.Directory) {
      return undefined;
    }
    if (typeof stat.size === 'number' && stat.size > MAX_ATTACHMENT_BYTES) {
      return undefined;
    }
    const name = path.basename(uri.fsPath);
    const mimeType = mimeForName(name);
    const kind = kindForMime(mimeType);
    const attachment: Attachment = {
      id: createAttachmentId(),
      name,
      path: uri.fsPath,
      mimeType,
      size: stat.size,
      kind
    };
    if (kind === 'image') {
      const bytes = await vscode.workspace.fs.readFile(uri).then(
        (value) => value,
        () => undefined
      );
      if (bytes) {
        attachment.dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
      }
    }
    return attachment;
  }

  /** Aborts the in-flight turn; the adapter emits the interrupted state. */
  private cancelTurn(): void {
    if (!this.activeThread) {
      return;
    }
    if (
      this.pendingQuestion?.source === 'native' &&
      this.pendingQuestion.request.threadId === this.activeThread.threadId
    ) {
      this.pendingQuestion = undefined;
      this.post({ type: 'question/cleared' });
    }
    this.registry.cancel(this.activeThread.backendId);
  }

  /**
   * The context payload for the active thread's next turn: the queued snapshot
   * on the first turn, otherwise a compact delta. Never throws, so a failed
   * snapshot degrades to a notice instead of blocking the turn.
   */
  private async turnContext(
    backendId: string,
    threadId: string
  ): Promise<import('./backends/types').ContextPayload> {
    const key = ContextDelivery.key(backendId, threadId);
    try {
      return await this.contextDelivery.forTurn(key);
    } catch {
      return {
        notice: 'Project context is not available right now. Continue without it; do not block the turn.'
      };
    }
  }

  /**
   * Handle the UI's manual refresh: drop the cached workspace picture and re-arm
   * priming so the next turn sends a fresh snapshot. Also refreshes backend
   * availability, matching the existing refresh affordance.
   */
  private async refreshContext(): Promise<void> {
    await this.postContextView(true);
    const thread = this.activeThread;
    if (thread) {
      await this.contextDelivery.refresh(ContextDelivery.key(thread.backendId, thread.threadId));
    }
    this.post({ type: 'snapshot', availability: await this.registry.refresh() });
    await this.postContextView();
  }

  /**
   * Turn one item or whole category off for the next turn, then echo the reduced
   * view. The next turn is built from the reduced snapshot, so the strip and the
   * turn always agree; the exclusion is cleared after the turn is sent and never
   * re-added on its own.
   */
  private setContextExclusions(keys: string[]): void {
    this.contextDelivery.setExclusions(keys);
    void this.postContextView();
  }

  /** Attach or remove the file the user is viewing. Off until they ask. */
  private setIncludeViewedFile(included: boolean): void {
    this.contextDelivery.setIncludeViewedFile(included);
    void this.postContextView();
  }

  /**
   * Push the context read model to the composer. `settingsEnabled` is false when
   * every context category is disabled in settings, so the strip can say context
   * is off rather than looking like a workspace with nothing in it.
   */
  private async postContextView(building = false): Promise<void> {
    const view = await this.contextDelivery.view(building);
    this.post({
      type: 'context',
      view,
      settingsEnabled: anyCategoryEnabled(this.projectContext.context.contextSettings()),
      exclusions: this.contextDelivery.exclusionKeys(),
      includeViewedFile: this.contextDelivery.includeViewedFileEnabled(),
      workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)
    });
  }

  /** Open a context file (the active file the strip names) in the editor. */
  private async openContextFile(path: string): Promise<void> {
    if (!path) {
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
      await vscode.window.showTextDocument(document, { preview: true });
    } catch {
      // A path that no longer exists is a no-op; the next snapshot clears it.
    }
  }

  /**
   * Open one changed file in the built-in diff editor with the journal's
   * pre-turn content on the left. The work is done by the documented
   * `melink.openChangeDiff` command, so this handler proves the id resolves; the
   * service reports a degradation (a lost turn, an unavailable view) rather than
   * throwing, and a message is surfaced as a notice so the affordance is never a
   * silent no-op.
   */
  private async openChangeDiff(turnId: string, relPath: string): Promise<void> {
    const result = await vscode.commands.executeCommand<NativeDiffResult>(OPEN_CHANGE_DIFF_COMMAND, {
      turnId,
      relPath
    });
    if (result?.message) {
      this.post({ type: 'notice', level: 'info', message: result.message });
    }
  }

  /** Open the whole turn in the built-in multi-file changes editor. */
  private async openTurnChanges(turnId: string): Promise<void> {
    const result = await vscode.commands.executeCommand<NativeDiffResult>(OPEN_TURN_CHANGES_COMMAND, { turnId });
    if (result?.message) {
      this.post({ type: 'notice', level: result.ok ? 'info' : 'warning', message: result.message });
    }
  }

  /**
   * Open the active thread's plan in the built-in Markdown Preview.
   */
  private async openPlanFile(): Promise<void> {
    if (!this.activeThread) {
      return;
    }
    const { backendId, threadId } = this.activeThread;
    const state = this.store.getPlanState(backendId, threadId);
    if (!state?.path) {
      return;
    }
    this.publishPlanDocument(this.planArtifact(backendId, threadId), true);
  }

  /**
   * Drop the rendered plan when the visible thread changes, so a document from
   * the previous conversation is not left up as if it belonged to the new one.
   */
  private syncPlanPreviewThread(threadId: string | undefined): void {
    if (threadId === this.planPreviewThreadId) {
      return;
    }
    this.planPreview.close();
    this.planPreviewOpenedFor = undefined;
    this.planPreviewThreadId = threadId;
  }

  /**
   * Push the plan into the rendered preview. That view is the one with Build.
   * The first unbuilt plan opens on its own, and a closed preview opens again
   * when the document is still waiting to be built. Later writes refresh an
   * open preview without taking focus, unless `reveal` is set because the user
   * asked to open it.
   */
  private publishPlanDocument(plan: PlanArtifact, reveal: boolean): void {
    const threadId = this.activeThread?.threadId;
    if (!threadId) {
      return;
    }
    this.planPreviewThreadId = threadId;
    const wasOpen = this.planPreview.isOpen;
    const autoOpen = shouldAutoOpenPlanDocument({
      built: plan.built,
      stepCount: plan.steps.length,
      alreadyOpened: wasOpen && this.planPreviewOpenedFor === threadId
    });
    const show = reveal || wasOpen || autoOpen;
    if (!show) {
      return;
    }
    if (reveal || autoOpen) {
      this.planPreviewOpenedFor = threadId;
    }
    this.planPreview.show(planPreviewState(plan), reveal || !wasOpen);
  }

  /**
   * Switch a plan file to Preview mode when the source editor is focused. The
   * uri is remembered first so that open does not immediately request Preview
   * again. The plan view with Build is opened separately.
   */
  private async showPlanMarkdownPreview(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    if (this.showingPlanPreview || this.shownPlanPreviews.has(key)) {
      return;
    }
    this.shownPlanPreviews.add(key);
    this.showingPlanPreview = true;
    try {
      await vscode.commands.executeCommand('markdown.showPreview', uri);
    } catch {
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Active });
        await vscode.commands.executeCommand('markdown.showPreview');
      } catch {
        this.shownPlanPreviews.delete(key);
        this.post({
          type: 'notice',
          level: 'warning',
          message: 'The plan could not be opened in Preview.'
        });
      }
    } finally {
      this.showingPlanPreview = false;
    }
  }

  /**
   * Build the active plan: the thread moves into execution and the plan's bullet
   * list becomes the source of truth for the todo list. Step status is tracked
   * from the persisted plan state, so a reload does not reset progress. This is
   * the only route from Plan mode to a write path; the mode returns to `agent`
   * first so the build turn itself is not read-only.
   */
  private async buildPlan(): Promise<void> {
    if (!this.activeThread) {
      return;
    }
    const { backendId, threadId } = this.activeThread;
    const state = this.store.getPlanState(backendId, threadId);
    if (!state) {
      this.post({
        type: 'notice',
        level: 'warning',
        message: 'There is no plan to build yet. Ask for a plan first.'
      });
      return;
    }
    // The plan's bullet list is the source of truth; persist it as built so a
    // reload shows the thread in execution rather than re-offering the build.
    await this.store.setPlanState(backendId, threadId, { ...state, built: true, updatedAt: Date.now() });
    this.mode = 'agent';
    await this.store.setActiveThread({
      backendId,
      threadId,
      modelId: this.activeThread.model,
      mode: 'agent',
      title: this.store.getActiveThread()?.title,
      updatedAt: Date.now()
    });
    const builtPlan = this.planArtifact(backendId, threadId);
    this.post({ type: 'plan', plan: builtPlan });
    this.post({ type: 'modes', modes: this.modeSnapshot(backendId) });
    this.publishPlanDocument(builtPlan, false);
    // Kick off execution as the next turn, now that the mode is `agent`.
    await this.sendTurn(buildTurnInstruction(state.steps));
  }

  /**
   * Reject the active plan. The plan file is the only artifact that remains (it
   * is the one permitted Plan-mode write); nothing else changed, the thread
   * stays usable, and the rejected flag lets it be revised again.
   */
  private async rejectPlan(): Promise<void> {
    if (!this.activeThread) {
      return;
    }
    const { backendId, threadId } = this.activeThread;
    const state = this.store.getPlanState(backendId, threadId);
    if (!state) {
      return;
    }
    await this.store.setPlanState(backendId, threadId, {
      ...state,
      built: false,
      completedDismissed: undefined,
      updatedAt: Date.now()
    });
    this.post({ type: 'plan', plan: this.planArtifact(backendId, threadId) });
    this.post({
      type: 'notice',
      level: 'info',
      message: 'The plan was rejected. The workspace is unchanged apart from the plan file.'
    });
  }

  /**
   * Write or revise the active thread's plan file. The path is derived from the
   * thread id, so this always updates the same file rather than creating a
   * second plan. Creating the file is the one permitted write in Plan mode.
   */
  private async writePlan(
    title: string,
    summary: string | undefined,
    steps: TodoStep[],
    body?: string
  ): Promise<void> {
    if (!this.activeThread) {
      return;
    }
    const { backendId, threadId } = this.activeThread;
    const artifact = await this.plans.write({ threadId, title, summary, body, steps });
    const previous = this.store.getPlanState(backendId, threadId);
    const completedDismissed = carriedPlanDismissal(artifact.steps, previous?.completedDismissed);
    const plan = { ...artifact, built: previous?.built ?? false, completedDismissed };
    await this.store.setPlanState(backendId, threadId, {
      path: plan.path,
      title: plan.title,
      summary: plan.summary,
      body: plan.body,
      steps: plan.steps,
      built: plan.built,
      completedDismissed: plan.completedDismissed,
      updatedAt: plan.updatedAt
    });
    this.post({ type: 'plan', plan });
    this.publishPlanDocument(plan, false);
  }

  /**
   * Fold a native `turn/plan/updated` into the persisted plan state, write the
   * plan artifact to its per-thread path, and surface it. The provider's bullet
   * list is the source of truth for the todo list, so it replaces the tracked
   * steps and survives a reload. Writing the artifact is the one permitted write
   * in Plan mode; the provider follows its selected permission level.
   */
  private async recordNativePlan(
    backendId: string,
    threadId: string,
    steps: TodoStep[],
    explanation?: string
  ): Promise<void> {
    const existing = this.store.getPlanState(backendId, threadId);
    const reported =
      existing?.built && existing.steps.length > 0 ? mergeReportedStepStatuses(existing.steps, steps) : undefined;
    // A built plan document keeps its own steps. A native todo list that does
    // not name those steps must not replace them.
    if (existing?.built && existing.body && existing.steps.length > 0 && reported && !reported.matched) {
      return;
    }
    const nextSteps = reported?.matched ? reported.steps : steps;
    // Only write the file for the thread the sidebar is actually showing, so a
    // background thread's notification cannot overwrite the visible plan.
    if (this.activeThread?.backendId === backendId && this.activeThread?.threadId === threadId) {
      // A native update replaces step status only. The document body stays;
      // a short explanation never overwrites prose that is already written.
      const artifact = await this.plans.write({
        threadId,
        title: existing?.title ?? 'Plan',
        body: existing?.body,
        summary: existing?.body ? existing.summary : (existing?.summary ?? explanation),
        steps: nextSteps
      });
      const built = existing?.built ?? this.mode !== 'plan';
      const completedDismissed = carriedPlanDismissal(artifact.steps, existing?.completedDismissed);
      await this.store.setPlanState(backendId, threadId, {
        path: artifact.path,
        title: artifact.title,
        summary: artifact.summary,
        // A native update must not invent a document body from its short
        // explanation. The reply capture fills the body when the plan is new.
        body: existing?.body ? artifact.body : undefined,
        steps: artifact.steps,
        // Native agent todo lists are already execution plans. Keep Plan mode's
        // explicit review/build transition, but surface Agent mode lists live.
        built,
        completedDismissed,
        updatedAt: artifact.updatedAt
      });
      const visible = { ...artifact, body: existing?.body ? artifact.body : undefined, built, completedDismissed };
      this.post({ type: 'plan', plan: visible });
      this.publishPlanDocument(visible, false);
      return;
    }
    await this.store.setPlanState(backendId, threadId, {
      path: existing?.path ?? planRelativePath(threadId),
      title: existing?.title ?? 'Plan',
      summary: existing?.summary,
      body: existing?.body,
      steps: nextSteps,
      built: existing?.built ?? false,
      completedDismissed: carriedPlanDismissal(nextSteps, existing?.completedDismissed),
      updatedAt: Date.now()
    });
  }

  /**
   * Update one tracked todo step's status and persist it, so a reload keeps
   * progress even if the user never sees another turn complete.
   */
  private async setTodoStepStatus(step: string, status: TodoStepStatus): Promise<void> {
    if (!this.activeThread) {
      return;
    }
    const { backendId, threadId } = this.activeThread;
    const existing = this.store.getPlanState(backendId, threadId);
    if (!existing) {
      return;
    }
    const index = existing.steps.findIndex((entry) => entry.text === step);
    const steps = updateStepStatus(existing.steps, index, status);
    await this.persistPlanSteps(backendId, threadId, steps);
  }

  /**
   * Settle a plan's progress when a turn ends. A turn that is cancelled,
   * interrupted, fails, or simply finishes can leave its last step `inProgress`
   * because the provider's plan update only ever marked it running. This returns
   * any such step to `pending` in the persisted plan and re-posts it, so the
   * todo list renders honest partial progress instead of a spinner that never
   * stops. A `denied` step is terminal and is left untouched.
   */
  private async settlePlanProgress(backendId: string, threadId: string): Promise<void> {
    const existing = this.store.getPlanState(backendId, threadId);
    if (!existing) {
      return;
    }
    const steps = settleInProgressSteps(existing.steps);
    if (!steps.some((step, index) => step.status !== existing.steps[index].status)) {
      return;
    }
    await this.persistPlanSteps(backendId, threadId, steps);
  }

  /**
   * Record a refused approval against the plan: the step the agent was on never
   * ran, so it is marked `denied` rather than left `inProgress` or silently
   * dropped. Only the active thread's plan is touched, so a background request
   * cannot rewrite the visible step list.
   */
  private async denyPlanStep(backendId: string, threadId: string): Promise<void> {
    if (this.activeThread?.backendId !== backendId || this.activeThread?.threadId !== threadId) {
      return;
    }
    const existing = this.store.getPlanState(backendId, threadId);
    if (!existing) {
      return;
    }
    const steps = denyInProgressStep(existing.steps);
    if (!steps.some((step, index) => step.status !== existing.steps[index].status)) {
      return;
    }
    await this.persistPlanSteps(backendId, threadId, steps);
  }

  /**
   * Write the plan document from the latest assistant reply. The first plan,
   * and any plan that has steps but no body yet, is created here. A later
   * Plan-mode turn replaces that file only when the user asked for a revision.
   * When a native todo update already arrived this turn, those steps stay and
   * the reply supplies the body. The path is derived from the thread id, so a
   * revision updates the same file.
   */
  private async capturePlanFromReply(
    backendId: string,
    threadId: string,
    nativeSteps: boolean
  ): Promise<void> {
    const revising = this.revisePlanThisTurn;
    this.revisePlanThisTurn = false;
    if (this.activeThread?.backendId !== backendId || this.activeThread?.threadId !== threadId) {
      return;
    }
    const existing = this.store.getPlanState(backendId, threadId);
    // A plan that already has a body stays put unless this turn is a revision.
    // Step status from a native update has already been written.
    if (existing && existing.steps.length > 0 && existing.body && !revising) {
      return;
    }
    const lastReply = [...this.store.getTranscript(backendId, threadId)]
      .reverse()
      .find((item) => item.kind === 'message' && item.role === 'assistant');
    const reply = lastReply?.text ?? '';
    // A question follow-up that never came back as a plan must not replace the
    // document. The answers are already in the body from when the card closed.
    if (revising && existing && existing.steps.length > 0 && existing.body && !hasPlanStepsHeading(reply)) {
      return;
    }
    const draft = planDocumentFromReply(reply);
    const steps = nativeSteps && existing && existing.steps.length > 0 && !revising ? existing.steps : draft.steps;
    if (steps.length === 0) {
      return;
    }
    const title = draft.title || existing?.title || this.store.getActiveThread()?.title || 'Plan';
    const artifact = await this.plans.write({
      threadId,
      title,
      summary: draft.summary ?? existing?.summary,
      body: applyPlanDecisions(draft.body ?? existing?.body, this.planDecisions),
      steps
    });
    const completedDismissed = carriedPlanDismissal(artifact.steps, existing?.completedDismissed);
    const plan = { ...artifact, built: existing?.built ?? false, completedDismissed };
    await this.store.setPlanState(backendId, threadId, {
      path: plan.path,
      title: plan.title,
      summary: plan.summary,
      body: plan.body,
      steps: plan.steps,
      built: plan.built,
      completedDismissed: plan.completedDismissed,
      updatedAt: plan.updatedAt
    });
    this.post({ type: 'plan', plan });
    this.publishPlanDocument(plan, false);
  }

  /**
   * Keep a built plan moving after a clean turn. Remaining steps start the next
   * turn on their own. The Resume control is only for a loop: an automatic
   * turn that left the steps and the tool activity unchanged. A question or a
   * refused approval also waits, because the user has to answer.
   */
  private async considerPlanAutopilot(backendId: string, threadId: string): Promise<void> {
    const session = this.session;
    if (!session || session.disposed || session.mode !== 'agent') {
      return;
    }
    const epoch = session.planEpoch;
    await this.flushBuiltPlanProgress(backendId, threadId);
    if (this.session !== session || session.disposed || session.planEpoch !== epoch) {
      return;
    }
    if (this.activeThread?.backendId !== backendId || this.activeThread.threadId !== threadId) {
      return;
    }
    const existing = this.store.getPlanState(backendId, threadId);
    if (!existing) {
      return;
    }
    const decision = decidePlanAutopilot({
      built: existing.built === true,
      steps: existing.steps,
      automatic: session.planRunAutomatic,
      previousSignature: session.planRunSignature,
      work: planTurnWork(this.store.getTranscript(backendId, threadId)),
      blocked: session.planHold || session.pendingQuestion !== undefined || session.pendingApproval !== undefined
    });
    session.planRunSignature = decision.signature;
    if (decision.decision !== 'continue') {
      return;
    }
    this.planAutopilotQueue.set(session.id, {
      session,
      text: continuePlanInstruction(existing.steps)
    });
    this.flushPlanAutopilot();
  }

  /** Start one queued plan continuation once no turn is holding the lock. */
  private flushPlanAutopilot(): void {
    if (this.turnInProgress || this.planAutopilotQueue.size === 0) {
      return;
    }
    const next = this.planAutopilotQueue.values().next().value;
    if (!next || next.session.disposed) {
      if (next) {
        this.planAutopilotQueue.delete(next.session.id);
      }
      return;
    }
    this.planAutopilotQueue.delete(next.session.id);
    this.autopilotSend = true;
    void this.sessionStore.run(next.session, () => this.sendTurn(next.text));
  }

  /**
   * Run plan-step writes one at a time. The callback keeps the chat session
   * that queued it, so a later write still updates that thread's document.
   */
  private enqueuePlanSteps(work: () => Promise<void>): Promise<void> {
    const session = this.session;
    const run = this.planStepChain.then(
      () => this.sessionStore.run(session, work) ?? Promise.resolve(),
      () => this.sessionStore.run(session, work) ?? Promise.resolve()
    );
    this.planStepChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Queue a todo-status refresh for the running turn. Streaming tokens share
   * one refresh, and a line that arrives mid-refresh is applied next.
   */
  private noteTodoProgress(backendId: string, threadId: string): void {
    if (this.mode !== 'agent') {
      return;
    }
    const existing = this.store.getPlanState(backendId, threadId);
    if (!existing?.built || existing.steps.length === 0) {
      return;
    }
    this.todoProgressTarget = { backendId, threadId };
    this.todoProgressAgain = true;
    if (this.todoProgressQueued) {
      return;
    }
    this.todoProgressQueued = true;
    void this.enqueuePlanSteps(async () => {
      try {
        while (this.todoProgressAgain) {
          this.todoProgressAgain = false;
          const target = this.todoProgressTarget;
          if (!target) {
            return;
          }
          await this.mergeTodoProgressFromReply(target.backendId, target.threadId);
        }
      } finally {
        this.todoProgressQueued = false;
        if (this.todoProgressAgain && this.todoProgressTarget) {
          this.noteTodoProgress(this.todoProgressTarget.backendId, this.todoProgressTarget.threadId);
        }
      }
    });
  }

  /**
   * Apply checkbox progress from the turn, then clear a step left running.
   * Called when the turn ends so the document and the todo list agree with
   * the work that actually finished.
   */
  private flushBuiltPlanProgress(backendId: string, threadId: string): Promise<void> {
    return this.enqueuePlanSteps(async () => {
      await this.mergeTodoProgressFromReply(backendId, threadId);
      await this.settlePlanProgress(backendId, threadId);
    });
  }

  /**
   * Take checkbox statuses from the plan file when the agent edited that file
   * directly. Host writes land in the store first, so the echo of our own
   * write finds nothing to change.
   */
  private adoptExternalPlanFile(uri: vscode.Uri): void {
    const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
    const session = this.sessions.find((entry) => {
      const threadId = entry.activeThread?.threadId;
      return threadId !== undefined && planRelativePath(threadId) === relative;
    });
    const thread = session?.activeThread;
    if (!session || !thread) {
      return;
    }
    void this.sessionStore.run(session, () => {
      void this.enqueuePlanSteps(() => this.adoptPlanFile(thread.backendId, thread.threadId));
    });
  }

  private async adoptPlanFile(backendId: string, threadId: string): Promise<void> {
    const existing = this.store.getPlanState(backendId, threadId);
    if (!existing?.built || existing.steps.length === 0) {
      return;
    }
    const artifact = await this.plans.read(threadId);
    if (!artifact) {
      return;
    }
    const steps = adoptedPlanSteps(existing.steps, artifact.steps);
    if (!steps) {
      return;
    }
    await this.persistPlanSteps(backendId, threadId, steps);
  }

  /**
   * Fold checkbox lines from this turn's assistant replies into a built plan.
   * Used when the provider does not emit `plan/updated`. The plan body is
   * left as it was; only step status changes.
   */
  private async mergeTodoProgressFromReply(backendId: string, threadId: string): Promise<void> {
    if (this.activeThread?.backendId !== backendId || this.activeThread?.threadId !== threadId) {
      return;
    }
    const existing = this.store.getPlanState(backendId, threadId);
    if (!existing?.built || existing.steps.length === 0) {
      return;
    }
    const reply = assistantProgressText(this.store.getTranscript(backendId, threadId));
    const merged = mergeCheckboxStatuses(existing.steps, reply);
    const steps = /^\s*[-*+]\s+\[[^\]]\]/m.test(reply) ? completeStepsBeforeFrontier(merged) : merged;
    if (!steps.some((step, index) => step.status !== existing.steps[index]?.status)) {
      return;
    }
    await this.persistPlanSteps(backendId, threadId, steps);
  }

  /**
   * Write step status back into the plan file's `## Steps` list and the
   * persisted state. The document body is copied through unchanged.
   */
  private async persistPlanSteps(backendId: string, threadId: string, steps: TodoStep[]): Promise<void> {
    const existing = this.store.getPlanState(backendId, threadId);
    if (!existing) {
      return;
    }
    const artifact = await this.plans.write({
      threadId,
      title: existing.title,
      summary: existing.summary,
      body: existing.body,
      steps
    });
    const completedDismissed = carriedPlanDismissal(artifact.steps, existing.completedDismissed);
    const plan = {
      ...artifact,
      body: existing.body ? artifact.body : undefined,
      summary: existing.body ? artifact.summary : existing.summary,
      built: existing.built,
      completedDismissed
    };
    await this.store.setPlanState(backendId, threadId, {
      path: plan.path,
      title: plan.title,
      summary: plan.summary,
      body: plan.body,
      steps: plan.steps,
      built: plan.built,
      completedDismissed: plan.completedDismissed,
      updatedAt: plan.updatedAt
    });
    if (this.activeThread?.backendId === backendId && this.activeThread?.threadId === threadId) {
      this.post({ type: 'plan', plan });
      this.publishPlanDocument(plan, false);
    }
  }

  /**
   * The plan artifact to carry over the protocol for a thread. Built from the
   * persisted state, which is the durable mirror of the plan file, so the UI
   * always sees the current step status.
   */
  private planArtifact(backendId: string, threadId: string): PlanArtifact {
    const state = this.store.getPlanState(backendId, threadId);
    return {
      path: state?.path ?? planRelativePath(threadId),
      title: state?.title ?? 'Plan',
      summary: state?.summary,
      body: state?.body,
      steps: state?.steps ?? [],
      built: state?.built,
      completedDismissed: state?.completedDismissed,
      updatedAt: state?.updatedAt ?? Date.now()
    };
  }

  /**
   * Hide the "Plan complete" row once the user sends a message after the plan
   * finished. The row stays through the turn that completed it.
   */
  private async dismissCompletedPlan(backendId: string, threadId: string): Promise<void> {
    const existing = this.store.getPlanState(backendId, threadId);
    if (!existing || !shouldDismissCompletedPlan(existing, false)) {
      return;
    }
    await this.store.setPlanState(backendId, threadId, { ...existing, completedDismissed: true });
    if (this.activeThread?.backendId === backendId && this.activeThread.threadId === threadId) {
      this.post({ type: 'plan', plan: this.planArtifact(backendId, threadId) });
    }
  }

  /**
   * Forwards a decision to the owning backend. This is the only path that
   * answers a pending request, and it is driven strictly by an explicit user
   * action in the webview: there is no timer, no retry, and no reconnect path
   * that calls it. A rejected request is therefore never retried by us.
   */
  /** The open question card when it belongs to this thread. */
  private pendingQuestionPayload(backendId: string, threadId?: string): QuestionRequest | undefined {
    const pending = this.pendingQuestion;
    if (!pending || !threadId) {
      return undefined;
    }
    if (pending.request.backendId !== backendId || pending.request.threadId !== threadId) {
      return undefined;
    }
    return pending.request;
  }

  /** Show a native question on the active thread and remember it for a reload. */
  private holdNativeQuestion(request: QuestionRequest): void {
    this.pendingQuestion = { source: 'native', request };
    if (this.activeThread?.backendId === request.backendId && this.activeThread.threadId === request.threadId) {
      this.post({ type: 'question/asked', request });
    }
  }

  /**
   * If the latest assistant reply ended with a question fence, remove it from
   * the stored transcript and open the card. Ask mode never calls this.
   */
  private captureFenceQuestions(backendId: string, threadId: string): void {
    if (this.pendingQuestion) {
      return;
    }
    const items = this.store.getTranscript(backendId, threadId);
    let index = -1;
    for (let cursor = items.length - 1; cursor >= 0; cursor -= 1) {
      const item = items[cursor];
      if (item?.kind === 'message' && item.role === 'assistant') {
        index = cursor;
        break;
      }
    }
    if (index < 0) {
      return;
    }
    const item = items[index];
    if (!item) {
      return;
    }
    const extracted = extractSidecodeQuestions(item.text ?? '');
    if (!extracted.questions || extracted.questions.length === 0) {
      return;
    }
    const next = items.slice();
    next[index] = { ...item, text: extracted.text };
    this.store.setTranscript(backendId, threadId, next);
    const request: QuestionRequest = {
      id: `fence_${item.id}`,
      backendId,
      threadId,
      itemId: item.id,
      strippedText: extracted.text,
      questions: extracted.questions
    };
    this.pendingQuestion = { source: 'fence', request };
    this.post({ type: 'question/asked', request });
  }

  /**
   * Apply the card's answers. A fence ask continues as the next turn. A native
   * ask is returned to the backend that is still waiting, and the same text is
   * kept in the transcript.
   */
  private async answerQuestion(requestId: string, answers: QuestionAnswer[]): Promise<void> {
    const pending = this.pendingQuestion;
    if (!pending || pending.request.id !== requestId) {
      return;
    }
    this.pendingQuestion = undefined;
    const text = formatQuestionAnswers(pending.request.questions, answers);
    const revisingPlan = this.mode === 'plan';
    if (revisingPlan) {
      this.planDecisions = [...this.planDecisions, ...planDecisionLines(pending.request.questions, answers)];
      await this.applyDecisionsToPlan();
    }
    if (pending.source === 'native') {
      if (revisingPlan) {
        this.revisePlanThisTurn = true;
      }
      this.registry.answerQuestion(pending.request.backendId, pending.request.threadId, requestId, answers);
      await this.store.appendUserMessage(pending.request.backendId, pending.request.threadId, text);
      return;
    }
    await this.sendTurn(
      revisingPlan ? planUpdateFromAnswers(pending.request.questions, answers) : text,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      revisingPlan
    );
  }

  /**
   * Write the current answers into the open plan and show that document.
   * A plan that does not exist yet keeps the answers until the next reply
   * creates the file.
   */
  private async applyDecisionsToPlan(): Promise<void> {
    if (!this.activeThread || this.planDecisions.length === 0) {
      return;
    }
    const { backendId, threadId } = this.activeThread;
    const existing = this.store.getPlanState(backendId, threadId);
    if (!existing || existing.steps.length === 0) {
      return;
    }
    const body = applyPlanDecisions(existing.body ?? existing.summary, this.planDecisions);
    if (body === existing.body) {
      return;
    }
    await this.writePlan(existing.title || 'Plan', existing.summary, existing.steps, body);
  }

  private decideApproval(
    backendId: string,
    threadId: string,
    requestId: string,
    decision: import('./protocol').ApprovalDecision
  ): void {
    // Clear the open request as soon as the user decides, so a reload racing the
    // event stream cannot repaint an already-answered prompt.
    if (this.pendingApproval?.id === requestId) {
      this.pendingApproval = undefined;
    }
    this.registry.decideApproval(backendId, threadId, requestId, decision);
  }

  private render(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'));
    const nonce = createNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      // The host loads webview resources through its own worker. `default-src
      // 'none'` would block that worker unless it is named here.
      `worker-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${styleUri}" rel="stylesheet" />
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

/**
 * A plain-language summary of one decision outcome, or `undefined` when the
 * decision took effect. A conflict requires an explicit choice; any other
 * failure names its own reason so the UI shows why, not a generic error.
 */
function describeDecisionOutcome(result: import('./changes/changeStore').ChangeDecisionResult): string | undefined {
  if (result.ok) {
    return undefined;
  }
  if (result.conflict) {
    return 'That file changed after the turn. Choose whether to keep the current file or overwrite it with the pre-turn content.';
  }
  return result.error ?? 'The decision could not be applied.';
}

function isCancellation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const named = error as { name?: unknown; message?: unknown };
  if (named.name === 'AbortError') {
    return true;
  }
  return typeof named.message === 'string' && /cancel/i.test(named.message);
}


/**
 * The turn text sent at the build transition. The plan's bullet list is already
 * the todo list; this tells the agent to execute it, so building the plan moves
 * the thread into execution rather than being a no-op.
 */
function buildTurnInstruction(steps: readonly TodoStep[]): string {
  const list = steps.map((step) => `- [ ] ${step.text}`).join('\n');
  return [
    'Build the approved plan. Execute each step in order. As soon as you start a step, write a checkbox line on its own line that repeats the step text exactly: "- [~] ...". As soon as you finish it, write "- [x] ...". The plan document and the todo list update from those lines while you work. Leave the plan document prose unchanged.',
    '',
    list
  ].join('\n');
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

/** A pick larger than this is refused with an inline message, never attached. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Stable-enough id for a chip; the webview only needs it to key and remove. */
function createAttachmentId(): string {
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Extension -> mime map for the formats the picker filter offers. */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  webm: 'video/webm',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  jsonc: 'application/json',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/plain',
  csv: 'text/csv',
  log: 'text/plain',
  xml: 'application/xml',
  html: 'text/html',
  css: 'text/css',
  scss: 'text/css',
  less: 'text/css',
  js: 'text/javascript',
  jsx: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  kt: 'text/x-kotlin',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  hpp: 'text/x-c++',
  cs: 'text/x-csharp',
  sh: 'text/x-sh',
  ps1: 'text/x-powershell',
  sql: 'text/x-sql'
};

/** Keep the inline review to the first lines of an expanded file. */
function capReviewLines(hunks: ChangeHunkView[], limit: number): { hunks: ChangeHunkView[]; truncated: boolean } {
  let remaining = limit;
  let truncated = false;
  const capped: ChangeHunkView[] = [];
  for (const hunk of hunks) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const lines = hunk.lines.slice(0, remaining);
    if (lines.length < hunk.lines.length) {
      truncated = true;
    }
    remaining -= lines.length;
    capped.push({ ...hunk, lines });
  }
  return { hunks: capped, truncated };
}

/** Provider-neutral mime for a filename; `application/octet-stream` when unknown. */
function mimeForName(name: string): string {
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/** The broad class a chip uses; text is the fallback for any unknown type. */
function kindForMime(mimeType: string): AttachmentKind {
  if (mimeType.startsWith('image/')) {
    return 'image';
  }
  if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) {
    return 'audio';
  }
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') {
    return 'text';
  }
  return 'file';
}

/** Metadata saved with the open tabs. Inline bytes stay out of workspace state. */
function draftAttachmentsForStore(attachments: readonly Attachment[]): NonNullable<ChatTabState['draftAttachments']> {
  return parseDraftAttachments(persistableAttachments(attachments) ?? []);
}

function decodeDataUrl(dataUrl: string): Uint8Array | undefined {
  const match = /^data:[^;,]+;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match?.[1]) {
    return undefined;
  }
  return Buffer.from(match[1], 'base64');
}

function safeDraftFileName(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  return cleaned || 'attachment';
}

/** Strip inline bytes before an attachment is persisted to workspace state. */
function rewindKey(backendId: string, threadId: string): string {
  return `${backendId}\0${threadId}`;
}

function planSnapshot(state: PersistedPlanState): CheckpointPlanState {
  return {
    path: state.path,
    title: state.title,
    summary: state.summary,
    body: state.body,
    steps: state.steps.map((step) => ({ text: step.text, status: step.status })),
    built: state.built,
    completedDismissed: state.completedDismissed,
    updatedAt: state.updatedAt
  };
}

function messagePreview(text: string | undefined, fallback: string): string {
  const line = (text ?? '').trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!line) {
    return fallback;
  }
  return line.length > 80 ? `${line.slice(0, 80)}...` : line;
}

function userMessageTime(id: string): number | undefined {
  const match = /^user_(\d+)_/.exec(id);
  return match ? Number(match[1]) : undefined;
}

function persistableAttachments(attachments?: readonly Attachment[]): Attachment[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }
  return attachments.map(({ dataUrl: _dataUrl, ...rest }) => rest);
}
