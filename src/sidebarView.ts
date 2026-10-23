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
import { DeadlineError, SAVE_TIMEOUT_MESSAGE, runSettingsWrite, withDeadline } from './settings/deadline.ts';
import { runSkillOperation } from './settings/skillOperation.ts';
import type { SaveResult } from './settings/planWrites.ts';
import { PlanStore } from './planStore';
import { ThreadStore } from './backends/threadStore';
import {
  BackendError,
  denyInProgressStep,
  settleInProgressSteps,
  type ApprovalRequest,
  type AgentEvent,
  type Attachment,
  type DefaultMode,
  type ModelSettingField,
  type ModelSettingOverrides,
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
  askModeQuestionNotice,
  containsQuestionPayload,
  extractSidecodeQuestions,
  formatQuestionAnswers,
  hideQuestionFence,
  invalidQuestionNotice,
  planDecisionLines,
  planUpdateFromAnswers,
  questionRetryInstruction,
  type QuestionAnswer,
  type QuestionRequest
} from './questions';
import { findFenceQuestionItem, shouldCaptureFenceQuestions } from './questionsCapture';
import { restorePendingQuestion } from './questionRestore';
import { QuestionStore, pendingQuestionKey, type PendingQuestion } from './questionStore';
import { overridesFromResolved, resolveModelSettings, sanitizeOverrides } from './backends/capabilities';
import { canCompactContext, contextUsagePercent } from './backends/contextUsage';
import { compactionSource, fitCompactionSource } from './backends/compaction';
import { backendForTurn } from './backends/providerChoice';
import {
  continueAfterStopInstruction,
  isMissingThreadError,
  isQuietTurnError,
  quietContinueNotice,
  shouldAutoContinue,
  stopContinueNotice,
  threadRecoveredNotice
} from './backends/threadRecovery';
import {
  prependOlderHistory,
  revealStoredHistory,
  transcriptWithNewer,
  withStoredHistory
} from './backends/historyWindow.ts';
import {
  adoptedPlanSteps,
  applyPlanDecisions,
  assistantProgressText,
  carriedPlanDismissal,
  completeStepsBeforeFrontier,
  continuePlanInstruction,
  decidePlanAutopilot,
  hasPlanStepsHeading,
  isLoosePlanFile,
  mergeCheckboxStatuses,
  mergeReportedStepStatuses,
  canonicalPlanPath,
  planDocumentFromReply,
  planRelativePath,
  planTitleFromFileName,
  planTurnWork,
  recoverPlanDraft,
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
import {
  orchestrationDiagnostic,
  orchestrationTurnSnapshot,
  planTurn,
  resolvePostTurnRoles,
  type OrchestrationTurnSnapshot,
  type TurnPlan
} from './orchestration/plan.ts';
import { runTurnEnd } from './orchestration/turnEnd.ts';
import { logDiagnostic } from './backends/diagnostics';
import { readOrchestrationSettings } from './orchestration/vscodeSettings.ts';
import {
  collectDoubleCheck,
  doubleCheckNotice,
  DOUBLE_CHECK_SETTLE_MS
} from './orchestration/doubleCheck.ts';
import { readFileDiagnostics } from './orchestration/vscodeDiagnostics.ts';
import { anyCategoryEnabled } from './context/contextView';
import type { CheckpointPlanRecord } from './changes/journal';
import { REVIEW_HUNK_LINE_LIMIT, capReviewLines } from './changes/reviewLines.ts';
import { ReviewStore, STYLING_REVIEW_STORE_KEY } from './review/reviewStore.ts';
import {
  DIFF_REVIEW_TIMEOUT_MS,
  runTurnDiffReview,
  turnRequestText
} from './review/turnReview.ts';
import type { StylingBrandKitFile } from './review/stylingReview.ts';
import {
  STYLING_REVIEW_TIMEOUT_MS,
  runTurnStylingReview
} from './review/turnStyling.ts';
import { VscodeChangeJournal } from './changes/vscodeJournal';
import { VscodeChangeStore } from './changes/vscodeChangeStore';
import { VscodeCheckpointStore } from './changes/vscodeCheckpoint';
import { WorkspaceChangeWatcher } from './changes/vscodeChanges';
import { NativeDiffService, type NativeDiffResult } from './changes/vscodeDiff';
import { OPEN_CHANGE_DIFF_COMMAND, OPEN_TURN_CHANGES_COMMAND } from './changes/nativeDiff';
import { ChangeTracker, type TurnChangeSet } from './changes/tracker';
import { CheckHost } from './review/checkHost.ts';
import { decisionBlockReason } from './review/checkGate.ts';
import {
  VscodeCheckStore,
  spawnShellCheck,
  vscodeCheckWorkspace
} from './review/vscodeCheckHost.ts';
import { readWorkspaceCheckSettings } from './review/vscodeCheckSettings.ts';
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
import { historyThreadTitle } from './webview/historyEntries';
import {
  clearPinnedModelSettingField,
  clearPinnedModelSettings,
  copyModelSettings,
  pinModelSettings,
  pinnedModelSettings,
  withPinnedDefaults
} from './composerControls';
import {
  MAX_ATTACHMENT_BYTES,
  createAttachmentId,
  decodeDataUrl,
  draftAttachmentsForStore,
  extensionForAttachment,
  kindForMime,
  mimeForName,
  persistableAttachments,
  safeDraftFileName
} from './sidebar/attachments';
import { planSnapshot, rewindKey } from './sidebar/planSnapshot';
import { messagePreview, userMessageTime } from './sidebar/reviewFormat';
import { OPEN_CHAT_TABS_KEY, type ChatSession, type NoticeView } from './sidebar/session';
import { buildTurnInstruction, describeDecisionOutcome, isCancellation } from './sidebar/turnInstruction';
import {
  QUEUED_TURNS_KEY,
  QUEUE_LEASE_MS,
  USER_TURN_QUEUE_CAP,
  clearSessionQueue,
  createQueuedTurnId,
  enqueueTurn,
  foreignQueueLeaseIsLive,
  invalidQueuedAttachment,
  parsePersistedTurnQueues,
  planQueueDrain,
  queueLeaseDisposition,
  queueLeaseOwner,
  queuedTurnThreadTarget,
  queuedTurnViews,
  removeQueuedTurn,
  requeueTurnFront,
  serializeTurnQueues,
  sessionMatchesQueueTarget,
  shouldAnnounceUserMessage,
  shouldQueueWhileBusy,
  takeQueuedTurn,
  type QueuedTurn,
  type UserTurnQueues
} from './sidebar/turnQueue';
import { render } from './sidebar/viewHtml';
import {
  OPEN_HYDRATE_MS,
  openSidebarSafely,
  RESUME_HYDRATE_MS,
  RESUME_PROVIDER_MS,
  RESUME_SNAPSHOT_MS,
  safeOpenNotice
} from './sidebar/startup.ts';
import { workspaceTranscriptTail } from './backends/transcriptTail.ts';

/**
 * Renders the sideCode sidebar. Each open conversation is a tab in that view.
 * This class is UI-facing glue: it forwards the registry's snapshot and
 * normalized events to the React webview and turns webview intents into
 * registry calls. It holds no provider types.
 */
/** A save that misses this bound is reported as failed; the host never hangs the footer. */
const SETTINGS_SAVE_DEADLINE_MS = 15000;
export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'melinkAgent.chat';

  /**
   * The permission level a new chat starts at. Seeded from the last picker
   * choice, then from the settings default. Each open chat keeps its own level
   * after that. `unrestricted` arrives only after the webview's confirmation.
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
  /** In-flight mode-switch dialogs. Dismissing one keeps the current mode. */
  private modeSwitchSeq = 0;
  private readonly modeSwitchWaiters = new Map<string, (accept: boolean) => void>();
  /** The title-bar gear was used before the webview script was listening. */
  private openSettingsOnReady = false;
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
  /** True while a moved plan is being copied onto the open chat, so the write is not recovered again. */
  private recoveringPlan = false;
  /** True after the first chat with no plan has been checked for a moved plan file. */
  private loosePlanScanDone = false;
  /** Built-plan turns waiting to start once the current turn has released the lock. */
  private readonly planAutopilotQueue = new Map<string, { session: ChatSession; text: string }>();
  /** User turns accepted while their chat was busy, FIFO per chat. */
  private readonly userTurnQueues: UserTurnQueues = new Map();
  /**
   * Identity of this window for the persisted queue lease. Only one window may
   * own a workspace's queue at a time: a second window leaves the payload to a
   * live owner instead of dispatching the same accepted messages again.
   */
  private readonly queueOwnerId = `queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  /** True once the persisted queue was claimed (or found owned by another window). */
  private queuesRestored = false;
  /** Restored chats wait for activation before their first automatic send. */
  private readonly restoredQueueSessions = new Set<string>();
  /** Keeps this window's lease live while it holds queued turns. */
  private queueHeartbeat?: ReturnType<typeof setInterval>;
  /** Retry claiming a queue whose previous owner's lease has not expired yet. */
  private queueRestoreTimer?: ReturnType<typeof setTimeout>;
  /** Entries kept for a retry but skipped by the drain, so they cannot block others. */
  private readonly blockedQueuedTurns = new Set<string>();
  /** Set once this window hands the queue back on shutdown; no local sends after. */
  private queueFlushStopped = false;
  /** Serializes workspace-state writes so an awaited release is the last one. */
  private queueWrite: Promise<void> = Promise.resolve();
  /** The policy decided for each started turn, bounded to the newest 32. */
  private readonly turnPlans = new Map<string, TurnPlan>();
  /**
   * The newest resolved post-turn decision, exposed in the settings read model.
   * It is a copy (see `orchestrationTurnSnapshot`), so no map is kept only to be
   * written to and never read.
   */
  private lastOrchestrationTurn?: OrchestrationTurnSnapshot;
  /** One queued continuation per tab, started once that tab's turn releases the lock. */
  private readonly crashContinueQueue = new Map<string, { session: ChatSession; text: string }>();
  /**
   * The per-turn change journal: the host-owned record of what each turn
   * changed. Owned here so it shares the turn lifecycle the view already drives
   * rather than adding a parallel one.
   */
  private readonly changeJournal: VscodeChangeJournal;
  private readonly changeTracker: ChangeTracker;
  private changePaintVersion = 0;
  /**
   * The post-hoc decision store: per-file and per-hunk accept/reject over the
   * journal's recorded bytes. It is deliberately separate from the approval
   * gate in the registry; the two never share state.
   */
  private readonly changeStore: VscodeChangeStore;
  /**
   * The opt-in advisory review result for a finished turn. It is workspace
   * scoped and bounded, and is read only when the review snapshot is composed;
   * a reload never runs the reviewer again.
   */
  private readonly reviewStore: ReviewStore;
  /**
   * The advisory styling-check result for a finished turn. It uses the same
   * bounded review store with its own workspace key, so the diff review and the
   * styling check never overwrite each other.
   */
  private readonly stylingReviewStore: ReviewStore;
  /**
   * The post-turn check result store and runner. Checks are advisory evidence
   * about a finished turn: they never reach a model and never decide a Keep.
   */
  private readonly checkStore: VscodeCheckStore;
  private readonly checkHost: CheckHost;
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
  /** Pending question cards, persisted so a window reload can restore them. */
  private readonly questions: QuestionStore;
  /** Native questions already reported as lost, so a repaint cannot repeat it. */
  private readonly reportedLostQuestions = new Set<string>();
  /** Coalesces a burst of editor/selection events into one context read. */
  private contextViewTimer?: ReturnType<typeof setTimeout>;
  /** Serializes plan-file writes so a live status update cannot clobber another. */
  private planStepChain: Promise<void> = Promise.resolve();
  /** Threads whose running turns should refresh todo status. One chat does not replace another. */
  private readonly todoProgressTargets = new Map<string, { backendId: string; threadId: string }>();
  private todoProgressQueued = false;

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
    this.questions = new QuestionStore(context.workspaceState);
    // The change journal is bound to the real workspace fs and workspace-scoped
    // storage here; the tracker and watcher only ever talk to the host-free
    // core, so the turn wiring below stays a thin translation layer.
    this.changeJournal = new VscodeChangeJournal(context);
    this.changeTracker = new ChangeTracker(this.changeJournal);
    this.changeWatcher = new WorkspaceChangeWatcher(this.changeTracker);
    context.subscriptions.push(this.changeWatcher, {
      dispose: () => {
        this.queueFlushStopped = true;
        void this.releaseQueueLease(true);
      }
    });
    // The decision store annotates the journal's recorded bytes; it shares the
    // journal instance so a view read and a decision read agree on content.
    this.changeStore = new VscodeChangeStore(context, { artifacts: this.changeJournal });
    this.reviewStore = new ReviewStore(context.workspaceState);
    this.stylingReviewStore = new ReviewStore(
      context.workspaceState,
      Date.now,
      STYLING_REVIEW_STORE_KEY
    );
    this.checkStore = new VscodeCheckStore(context);
    this.checkHost = new CheckHost({
      store: this.checkStore,
      readSettings: readWorkspaceCheckSettings,
      ...vscodeCheckWorkspace(),
      spawn: spawnShellCheck,
      isKnownTurn: (backendId, threadId, turnId) => this.isKnownCheckTurn(backendId, threadId, turnId),
      isActiveTurn: (backendId, threadId) => this.isActiveCheckTurn(backendId, threadId)
    });
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
        void this.recoverOrPreviewPlan(uri);
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
        void this.recoverMovedPlan(uri, false).then((recovered) => {
          if (!recovered) {
            this.adoptExternalPlanFile(uri);
          }
        });
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
        this.clearPendingQuestion(event.backendId, event.threadId, true);
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
        void this.finishChangeTurn(
          event.turnId,
          event.type === 'turn/completed' ? 'completed' : 'interrupted'
        );
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
      if (event.threadId && shouldCaptureFenceQuestions(event.type, this.mode)) {
        this.captureFenceQuestions(
          event.backendId,
          event.threadId,
          event.type === 'item/completed' ? event.itemId : undefined
        );
      } else if (
        event.threadId &&
        this.mode === 'ask' &&
        (event.type === 'turn/completed' || event.type === 'turn/interrupted')
      ) {
        this.stripAskQuestionFence(event.backendId, event.threadId);
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
          session.heldNotice = undefined;
          if (session.disposed) {
            this.removeSession(session);
          }
        }
      }
      if (event.type === 'turn/completed') {
        if (this.session) {
          this.session.stopContinueAttempts = 0;
        }
        if (this.mode === 'agent' && event.threadId) {
          void this.considerPlanAutopilot(event.backendId, event.threadId, event.turnId);
        }
      }
      });
    });
    const storedPermission = this.store.getLastPermissionLevel();
    if (storedPermission) {
      this.permissionLevel = storedPermission;
    }
    this.transcriptsReady = this.store.hydrate();
  }

  /** Full transcripts are read from disk before a chat is painted or flushed. */
  private transcriptsReady: Promise<void> = Promise.resolve();
  /** One older-page read at a time, so a fast scroll cannot issue overlapping pages. */
  private olderHistoryInFlight = false;

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

  /**
   * The active chat's provider and model for the opt-in local missed-issue log.
   * `unknown` is reported rather than inventing an identity when no chat is
   * open. This is read-only metadata; it never includes prompts or code.
   */
  failureLogIdentity(): { providerId: string; modelId: string } {
    const session = this.visible ?? this.session;
    const thread = session?.activeThread;
    const providerId =
      session?.composerBackendId && this.registry.get(session.composerBackendId)
        ? session.composerBackendId
        : thread?.backendId;
    const modelId = session?.composerModelId ?? thread?.model;
    return {
      providerId: providerId ?? 'unknown',
      modelId: modelId ?? 'unknown'
    };
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
   * True while a turn is still known to the host: either the journal recorded
   * it, or it belongs to a conversation this view still has open. A background
   * turn stays known, so its checks may finish and be stored without repainting
   * the visible surface.
   */
  private isKnownCheckTurn(backendId: string, threadId: string, turnId: string): boolean {
    const turn = this.changeJournal.getTurn(turnId);
    if (turn && turn.backendId === backendId && turn.threadId === threadId) {
      return true;
    }
    return [...this.sessions].some(
      (session) =>
        session.activeThread?.backendId === backendId && session.activeThread.threadId === threadId
    );
  }

  /** True when this thread's turn is the one the visible review surface shows. */
  private isActiveCheckTurn(backendId: string, threadId: string): boolean {
    return this.activeThread?.backendId === backendId && this.activeThread.threadId === threadId;
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
    const session = this.session;
    const plan = session?.turnPlan;
    if (plan && session) {
      this.turnPlans.set(turnId, plan);
      session.turnPlan = undefined;
      while (this.turnPlans.size > 32) {
        const oldest = this.turnPlans.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        this.turnPlans.delete(oldest);
      }
    }
    void this.checkHost.cancelThread(backendId, threadId).catch(() => undefined);
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
   * The set is this turn alone. Earlier turns keep the cards already on screen.
   */
  private async finishChangeTurn(
    turnId: string,
    terminus: 'completed' | 'interrupted'
  ): Promise<void> {
    // A terminus for a turn that already ended (a late event after this chat
    // started another turn) must not stop a chat that is still running.
    if (!this.changeTracker.isOpen(turnId)) {
      return;
    }
    this.changeWatcher.flush();
    const set = await this.changeTracker.endTurn(turnId);
    if (!this.changeTracker.isTracking) {
      this.changeWatcher.stop();
    }
    if (!set) {
      return;
    }
    const storedPlan = this.turnPlans.get(turnId);
    const choices = storedPlan?.choices ?? readOrchestrationSettings();
    const plan = storedPlan ?? {
      choices,
      quick: false,
      quickBypass: false,
      quickNotice: false,
      planning: false,
      reasons: {}
    };
    const roles = resolvePostTurnRoles({
      choices,
      quick: plan.quick,
      entries: set.entries
    });
    const snapshot = orchestrationTurnSnapshot(plan, roles, {
      backendId: set.backendId,
      threadId: set.threadId,
      turnId
    });
    this.lastOrchestrationTurn = snapshot;
    logDiagnostic(orchestrationDiagnostic(plan, roles));
    const shouldReview = roles.reviewing;
    // The styling pass is a frontend-only pass: a backend-only turn is skipped
    // before a brand kit is read or a prompt is built.
    const shouldStyle = roles.styling;
    // Checks start only for a non-empty, closed change set. A background turn
    // still stores its result; the runner decides whether the visible surface
    // may be repainted.
    this.startChangeChecks(set, roles.testing);
    // The advisory diagnostics sweep runs for every completed turn, active or
    // background. Its notice is routed to the owning chat (or held for it), so
    // one chat's file names never appear in another.
    if (roles.doubleCheck && terminus === 'completed') {
      void this.runDoubleCheck(set);
    }
    // A Quick turn stores its notice in the owning transcript before the
    // background return below, so it neither lands in the visible chat nor
    // disappears on reload. Off is silent: `quickNotice` is false.
    if (plan.quickNotice && set.entries.length > 0) {
      this.postQuickTaskNotice(set);
    }
    // Only the active conversation's own turn is pushed: a background thread's
    // change set must not replace what the visible surface is showing. Its
    // review is still stored, so switching to that chat restores the findings.
    if (this.activeThread?.backendId !== set.backendId || this.activeThread?.threadId !== set.threadId) {
      if (shouldReview) {
        await this.reviewFinishedTurn(set);
      }
      if (shouldStyle) {
        await this.stylingReviewFinishedTurn(set);
      }
      return;
    }
    this.postTurnChanged(set);
    if (shouldReview) {
      await this.reviewFinishedTurn(set);
    }
    if (shouldStyle) {
      await this.stylingReviewFinishedTurn(set);
    }
    await this.postChangeReview(set.backendId, set.threadId, set.turnId);
    // A turn that just touched files makes its opening message a checkpoint, so
    // the per-message entry point offers it without waiting for a reload.
    await this.postCheckpoints(set.backendId, set.threadId);
  }

  /**
   * Save the Quick bypass notice in its owning transcript, then publish it.
   *
   * The item id is derived from the turn, so a reload replays one notice and a
   * repaint never duplicates it. It is the same persisted notice item the
   * double-check result uses.
   */
  private postQuickTaskNotice(set: TurnChangeSet): void {
    const event: Extract<AgentEvent, { type: 'item/started' }> = {
      type: 'item/started',
      backendId: set.backendId,
      threadId: set.threadId,
      item: {
        id: `quick-task_${set.turnId}`,
        kind: 'notice',
        detail: 'status',
        text: 'Quick task: skipped post-turn orchestration for this turn.',
        noticeLevel: 'info',
        status: 'completed'
      }
    };
    this.store.applyEvent(event);
    this.post({ type: 'agentEvent', event });
    const completed: Extract<AgentEvent, { type: 'item/completed' }> = {
      type: 'item/completed', backendId: set.backendId, threadId: set.threadId,
      itemId: event.item.id, status: 'completed'
    };
    this.store.applyEvent(completed);
    this.post({ type: 'agentEvent', event: completed });
  }

  /**
   * Let VS Code publish diagnostics for the just-written files, then read only
   * those files. The sweep is advisory: a read failure is skipped and the turn
   * has already finished by the time this runs.
   */
  private async runDoubleCheck(set: TurnChangeSet): Promise<void> {
    if (set.entries.length === 0) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, DOUBLE_CHECK_SETTLE_MS));
    const displayByAbs = new Map(set.entries.map((entry) => [entry.absPath, entry.path]));
    const result = collectDoubleCheck([...displayByAbs.keys()], readFileDiagnostics);
    const notice = doubleCheckNotice({
      ...result,
      names: result.names.map((name) => displayByAbs.get(name) ?? name)
    });
    if (notice) {
      this.postDoubleCheckNotice(set, notice);
    }
  }

  /**
   * Save the notice in its owning transcript so tab switches and reloads replay
   * every result. Live item events are scoped by the webview to the same chat.
   */
  private postDoubleCheckNotice(
    set: TurnChangeSet,
    notice: { level: 'info' | 'warning'; message: string }
  ): void {
    // Store the result before publishing it. Background results then replay in
    // their owning transcript, including after a window reload.
    const event: Extract<AgentEvent, { type: 'item/started' }> = {
      type: 'item/started',
      backendId: set.backendId,
      threadId: set.threadId,
      item: {
        id: `double-check_${set.turnId}`,
        kind: 'notice',
        detail: 'status',
        text: notice.message,
        noticeLevel: notice.level,
        status: 'completed'
      }
    };
    this.store.applyEvent(event);
    this.post({ type: 'agentEvent', event });
    const completed: Extract<AgentEvent, { type: 'item/completed' }> = {
      type: 'item/completed', backendId: set.backendId, threadId: set.threadId,
      itemId: event.item.id, status: 'completed'
    };
    this.store.applyEvent(completed);
    this.post({ type: 'agentEvent', event: completed });
  }

  /**
   * Run and persist the opt-in review once, at live turn finish. A reload reads
   * the stored result through `postChangeReview` and never calls this.
   */
  private async reviewFinishedTurn(set: TurnChangeSet): Promise<void> {
    const view = await this.changeStore.view(set.backendId, set.threadId, set.turnId);
    if (!view) {
      return;
    }
    const request = turnRequestText(
      this.store.getTranscript(set.backendId, set.threadId),
      set.messageId
    );
    await runTurnDiffReview({
      view,
      ...(request === undefined ? {} : { request }),
      store: this.reviewStore,
      timeoutMs: DIFF_REVIEW_TIMEOUT_MS
    });
  }

  /**
   * Run and persist the styling check once, at live turn finish. A reload reads
   * the stored result through `postChangeReview` and never calls this. The
   * caller has already proven the turn changed frontend work.
   */
  private async stylingReviewFinishedTurn(set: TurnChangeSet): Promise<void> {
    const view = await this.changeStore.view(set.backendId, set.threadId, set.turnId);
    if (!view) {
      return;
    }
    const request = turnRequestText(
      this.store.getTranscript(set.backendId, set.threadId),
      set.messageId
    );
    const brandKit = await this.readBrandKit();
    await runTurnStylingReview({
      view,
      ...(request === undefined ? {} : { request }),
      brandKit,
      store: this.stylingReviewStore,
      timeoutMs: STYLING_REVIEW_TIMEOUT_MS
    });
  }

  /**
   * Read the project's own brand contract, when it exists. Reading only happens
   * after the styling gate has passed, so an ordinary backend turn pays nothing.
   * Each file is bounded; a missing or unreadable file is simply absent.
   */
  private async readBrandKit(): Promise<StylingBrandKitFile[]> {
    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(
        '**/{tokens.css,DESIGN.md,design-tokens.json,brand.json}',
        '**/{node_modules,dist,out,build,.git}/**',
        12
      );
    } catch {
      return [];
    }
    const files: StylingBrandKitFile[] = [];
    let budget = 40_000;
    for (const uri of uris) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.byteLength > 20_000 || budget <= 0) {
          continue;
        }
        const text = new TextDecoder().decode(bytes);
        const bounded = text.length > budget ? text.slice(0, budget) : text;
        budget -= bounded.length;
        files.push({ path: vscode.workspace.asRelativePath(uri, false), text: bounded });
      } catch {
        // A brand file is optional; an unreadable one never fails the check.
      }
    }
    return files;
  }

  /**
   * Offer post-turn checks for one finished change set. The runner stores a
   * `running` view before spawning and a final view when it settles; the
   * callback repaints through the existing review path only while this turn is
   * still the visible one.
   */
  private startChangeChecks(set: TurnChangeSet, enabled: boolean): void {
    if (set.entries.length === 0 || !enabled) {
      return;
    }
    void this.checkHost
      .startTurnChecks({
        backendId: set.backendId,
        threadId: set.threadId,
        turnId: set.turnId,
        hasChanges: true,
        // One source of truth: the per-turn resolved testing value replaces the
        // legacy `enabled` reader in the host. The early return above means a
        // disabled policy never reaches here, so `shouldRun` stays unused on
        // this path instead of duplicating the same flag.
        enabledOverride: enabled,
        onUpdate: () => {
          void this.postChangeReview(set.backendId, set.threadId, set.turnId);
        }
      })
      .catch(() => undefined);
  }

  /**
   * Push every surviving turn for the active thread, oldest first, after
   * clearing the cards. A reload and a restore both go through here so a
   * removed turn cannot linger and a later step cannot hide an earlier one.
   */
  private async postLatestChanges(): Promise<void> {
    const thread = this.activeThread;
    if (!thread) {
      return;
    }
    await this.postThreadChangeSets(thread.backendId, thread.threadId);
  }

  /** Replace the visible cards with one set per turn that still has files. */
  private async postThreadChangeSets(backendId: string, threadId: string): Promise<void> {
    if (this.activeThread?.backendId !== backendId || this.activeThread.threadId !== threadId) {
      return;
    }
    let version = this.changePaintVersion;
    const sets = await this.changeTracker.observedSets(threadId);
    if (this.visible?.activeThread?.backendId !== backendId ||
        this.visible.activeThread.threadId !== threadId) {
      return;
    }
    if (version !== this.changePaintVersion) {
      return this.postThreadChangeSets(backendId, threadId);
    }
    this.post({ type: 'changes/changed', backendId, threadId, turnId: '', entries: [] });
    for (const set of sets) {
      this.postTurnChanged(set);
      version = this.changePaintVersion;
      await this.postChangeReview(set.backendId, set.threadId, set.turnId);
      if (version !== this.changePaintVersion) {
        return this.postThreadChangeSets(backendId, threadId);
      }
    }
  }

  private postTurnChanged(set: TurnChangeSet): void {
    this.changePaintVersion += 1;
    this.post({
      type: 'changes/changed',
      backendId: set.backendId,
      threadId: set.threadId,
      turnId: set.turnId,
      ...(set.messageId ? { messageId: set.messageId } : {}),
      entries: set.entries
    });
  }

  /**
   * The single path that pushes a change-review snapshot, mirroring
   * `postPermissions(backendId)`. A reload, an on-demand `changes/list`, and the
   * after-a-decision repaint all go through here, so the review surface can
   * never be left showing three different versions of the same turn.
   *
   * Stored evidence is always included: the current orchestration choice gates
   * only whether a *new* turn runs a pass (see `finishChangeTurn`). Turning
   * Reviewing or Styling Off must not hide what an earlier turn already found.
   */
  private async postChangeReview(backendId: string, threadId: string, turnId: string): Promise<void> {
    const review = await this.changeStore.view(backendId, threadId, turnId);
    if (!review) {
      return;
    }
    const diffReview = this.reviewStore.get(backendId, threadId, turnId);
    const stylingReview = this.stylingReviewStore.get(backendId, threadId, turnId);
    const checks = this.checkStore.get(backendId, threadId, turnId);
    this.post({
      type: 'changes/review',
      review: {
        ...review,
        ...(diffReview === undefined ? {} : { diffReview }),
        ...(stylingReview === undefined ? {} : { stylingReview }),
        ...(checks ? { checks } : {}),
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
    const review = await this.changeStore.view(backendId, threadId, turnId);
    const file = review?.files.find((entry) => entry.path === path);
    if (!review || !file) {
      return;
    }
    const capped = capReviewLines(file.hunks, REVIEW_HUNK_LINE_LIMIT);
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
    overrideChecks?: boolean;
  }): Promise<void> {
    if (message.decision === 'accepted') {
      const blocked = decisionBlockReason(
        this.checkStore.get(message.backendId, message.threadId, message.turnId),
        message.overrideChecks === true
      );
      if (blocked) {
        const result: import('./changes/changeStore').ChangeDecisionResult = {
          relPath: message.path,
          decision: 'pending',
          ok: false,
          error: blocked
        };
        this.post({ type: 'changes/decisionResult', results: [result], message: blocked });
        return;
      }
    }
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
    overrideChecks?: boolean;
  }): Promise<void> {
    if (message.decision === 'accepted') {
      const blocked = decisionBlockReason(
        this.checkStore.get(message.backendId, message.threadId, message.turnId),
        message.overrideChecks === true
      );
      if (blocked) {
        const review = await this.changeStore.view(message.backendId, message.threadId, message.turnId);
        const results: import('./changes/changeStore').ChangeDecisionResult[] = (review?.files ?? []).map(
          (file) => ({ relPath: file.path, decision: 'pending', ok: false, error: blocked })
        );
        this.post({ type: 'changes/decisionResult', results, message: blocked });
        return;
      }
    }
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
    const sentAt = this.store.getTranscript(backendId, threadId).find((item) => item.id === messageId)?.sentAt;
    this.post({
      type: 'userMessageId',
      backendId,
      threadId,
      messageId,
      ...(sentAt != null ? { sentAt } : {})
    });
    if (this.activeThread?.backendId === backendId && this.activeThread.threadId === threadId) {
      await this.postCheckpoints(backendId, threadId);
    }
  }

  /**
   * The open chat gets the user message of a queued turn that just started, or
   * the injected row of an orchestration continuation. Stored attachments keep
   * only their path; the preview bytes are read here, the same way a replay
   * paints a stored bubble. `orchestration` marks provider input, which the
   * chat keeps for turn anchoring but never shows.
   */
  private async postDispatchedUserMessage(
    backendId: string,
    threadId: string,
    messageId: string,
    text: string,
    attachments: Attachment[] | undefined,
    sentAt: number,
    orchestration = false
  ): Promise<void> {
    const [preview] = await this.previewReplay([
      {
        id: messageId,
        kind: 'message',
        role: 'user',
        text,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        status: 'completed',
        sentAt,
        ...(orchestration ? { orchestration: true } : {})
      }
    ]);
    this.post({
      type: 'userMessageSent',
      backendId,
      threadId,
      messageId,
      text,
      ...(preview?.attachments && preview.attachments.length > 0 ? { attachments: preview.attachments } : {}),
      sentAt,
      ...(orchestration ? { orchestration: true } : {})
    });
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
      const current = this.store.getPlanState(record.backendId, record.threadId);
      await this.plans.remove(record.threadId, current?.path);
      await this.store.clearPlanState(record.backendId, record.threadId);
      return;
    }
    const steps = record.state.steps as TodoStep[];
    const written = await this.plans.write({
      threadId: record.threadId,
      title: record.state.title,
      summary: record.state.summary,
      body: record.state.body,
      steps,
      path: record.state.path
    });
    await this.store.setPlanState(record.backendId, record.threadId, {
      path: written.path,
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
      await this.repaintSession();
    }
  }

  /** Repaint one card per journal turn that survived a restore. */
  private async refreshChanges(backendId: string, threadId: string): Promise<void> {
    if (this.activeThread?.backendId !== backendId || this.activeThread.threadId !== threadId) {
      return;
    }
    await this.postThreadChangeSets(backendId, threadId);
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
    this.declinePendingModeSwitches();
    this.clearWebviewMountTimers();
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')]
    };
    const messages = view.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      if (message.type === 'modeSwitchChoice') {
        this.answerModeSwitch(message.requestId, message.accept);
        return;
      }
      if (message.type === 'ready') {
        this.webviewMounted = true;
        this.clearWebviewMountTimers();
        // No tab exists yet on a cold start, so this cannot wait for `visible`.
        void this.handle(message);
        if (this.openSettingsOnReady) {
          this.openSettingsOnReady = false;
          this.post({ type: 'showSettings' });
        }
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
      // The composer asks for settings as soon as the webview mounts, before
      // `ready` has created the first chat tab. Dropping that request leaves
      // the mic on "Loading settings" until the settings screen asks again.
      if (
        !session &&
        (message.type === 'getSettings' ||
          message.type === 'saveSettings' ||
          message.type === 'setOllamaToken' ||
          message.type === 'clearOllamaToken' ||
          message.type === 'setOpencodeZenToken' ||
          message.type === 'clearOpencodeZenToken' ||
          message.type === 'testConnection' ||
          message.type === 'validateCodexVersion' ||
          message.type === 'showAppSettings' ||
          message.type === 'upgradeOpencode' ||
          message.type === 'installOpencode' ||
          message.type === 'setZvecGrep' ||
          message.type === 'setAstGrep' ||
          message.type === 'installAstGrep' ||
          message.type === 'upgradeAstGrep' ||
          message.type === 'installZvecGrep' ||
          message.type === 'skillAction' ||
          message.type === 'openSettings' ||
          message.type === 'startDictation' ||
          message.type === 'stopDictation')
      ) {
        void this.handle(message);
        return;
      }
      if (!session) {
        return;
      }
      void this.sessionStore.run(session, () => this.handle(message));
    });
    view.onDidDispose(() => {
      messages.dispose();
      this.dictation.dispose();
      this.declinePendingModeSwitches();
      this.clearWebviewMountTimers();
      // A disposed webview is not a shutdown: the extension host may still be
      // running a turn and flush the in-memory queue. Keep the lease while
      // anything is queued; a second window must not reclaim and resend it.
      void this.releaseQueueLease(false);
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
      view.webview.html = render(view.webview, this.extensionUri);
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
    const transcript = this.store
      .getTranscript(backendId, threadId)
      .find((item) => item.role === 'user' && !item.orchestration && item.text?.trim())?.text;
    void this.showSession(
      this.createSession({ blank: false, backendId, threadId, title: tabTitle(historyThreadTitle(stored, transcript)) })
    );
  }

  /**
   * History label for one thread. The stored first message wins. The transcript
   * is next. The provider preview is last, because Codex records our mode
   * instruction as that preview.
   */
  private historyLabel(
    backendId: string,
    threadId: string,
    indexed: string | undefined,
    providerTitle: string | undefined
  ): string | undefined {
    const fromIndex = historyThreadTitle(indexed, undefined);
    if (fromIndex) {
      return fromIndex;
    }
    const transcript = this.store
      .getTranscript(backendId, threadId)
      .find((item) => item.role === 'user' && !item.orchestration && item.text?.trim())?.text;
    return historyThreadTitle(transcript, providerTitle);
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
    // Closing a chat is the user's decision to drop it: queued turns go with it
    // rather than firing into a tab that is no longer on screen.
    this.discardSessionQueue(session.id);
    this.restoredQueueSessions.delete(session.id);
    this.persistQueuedTurns();
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

  private nextTabId(): string {
    for (;;) {
      this.tabSeq += 1;
      const id = `tab_${this.tabSeq}`;
      if (!this.sessions.some((session) => session.id === id)) {
        return id;
      }
    }
  }

  private createSession(init: ChatTabState): ChatSession {
    const session: ChatSession = {
      id: init.tabId && !this.sessions.some((entry) => entry.id === init.tabId) ? init.tabId : this.nextTabId(),
      title: init.title ?? DEFAULT_TAB_TITLE,
      restored: false,
      mode: init.mode ?? readDefaultMode(),
      modeChosen: init.mode !== undefined,
      ...(init.permissionLevel ? { tabPermission: init.permissionLevel } : {}),
      ...(init.composerBackendId ? { composerBackendId: init.composerBackendId } : {}),
      ...(init.composerModelId ? { composerModelId: init.composerModelId } : {}),
      modelSettings: copyModelSettings(init.modelSettings),
      nativePlanThisTurn: false,
      revisePlanThisTurn: false,
      planDecisions: [],
      planEpoch: 0,
      planRunAutomatic: false,
      planHold: false,
      stopContinueAttempts: 0,
      blank: init.blank,
      composerText: init.draftText?.slice(0, COMPOSER_DRAFT_LIMIT) ?? '',
      composerAttachments: (init.draftAttachments ?? []).map((attachment) => ({ ...attachment })),
      ...(init.backendId && init.threadId ? { resume: { backendId: init.backendId, threadId: init.threadId } } : {}),
      disposed: false,
      turnOpen: false,
      turnBusy: false,
      ignoreNextEmptyDraft: false
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
      } else if (session.activeThread) {
        await this.repaintSession();
        await this.postLatestChanges();
        await this.postActiveCheckpoints();
      } else {
        await this.postFreshConversation();
        this.post({ type: 'restoring', value: false });
      }
      if (session.heldNotice && this.visible === session) {
        const held = session.heldNotice;
        session.heldNotice = undefined;
        this.post({ type: 'notice', level: held.level, message: held.message });
      }
      if (session.questionNotice && this.visible === session) {
        const notice = session.questionNotice;
        session.questionNotice = undefined;
        this.post({ type: 'notice', ...notice });
      }
      if (this.visible === session) {
        await this.offerSingleLoosePlan();
      }
    });
    await this.postComposerDraft(session);
    this.postQueuedTurns(session);
    // Showing a chat releases its restored queue: it may start now if idle.
    this.restoredQueueSessions.delete(session.id);
    this.flushQueuedTurns();
  }

  /** Re-send the visible tab's stored conversation without starting a new thread. */
  private async repaintSession(): Promise<void> {
    const thread = this.activeThread;
    if (!thread) {
      await this.postFreshConversation();
      this.post({ type: 'restoring', value: false });
      return;
    }
    const { backendId, threadId, model } = thread;
    if (this.session && !this.session.modeChosen) {
      const ref = this.store.listThreads(backendId).find((entry) => entry.threadId === threadId);
      this.mode = this.resolveMode(backendId, ref?.mode ?? this.mode);
      this.session.modeChosen = true;
    }
    const choice = this.composerSelection(backendId, model);
    this.mode = this.resolveMode(choice.backendId, this.mode);
    const permission = this.sessionPermission(choice.backendId);
    const history = this.currentHistory();
    this.post({
      type: 'conversation',
      backendId: choice.backendId,
      threadId,
      model: choice.model,
      permissionLevel: permission,
      mode: this.mode,
      replay: await this.previewReplay(history.replay),
      hasOlderHistory: history.hasOlderHistory,
      pendingApproval: this.pendingApproval,
      pendingQuestion: this.pendingQuestionPayload(backendId, threadId),
      plan: this.store.getPlanState(backendId, threadId) ? this.planArtifact(backendId, threadId) : undefined
    });
    this.post({ type: 'restoring', value: false });
    await this.finishComposerPaint(choice.backendId, choice.model);
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
    this.discardSessionQueue(session.id);
    this.restoredQueueSessions.delete(session.id);
    this.persistQueuedTurns();
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
        tabId: session.id,
        blank,
        ...(backendId ? { backendId } : {}),
        ...(threadId ? { threadId } : {}),
        title: session.title,
        ...(session === this.visible ? { active: true } : {}),
        ...(draftText ? { draftText } : {}),
        ...(draftAttachments.length > 0 ? { draftAttachments } : {}),
        ...(session.modeChosen ? { mode: session.mode } : {}),
        ...(session.tabPermission ? { permissionLevel: session.tabPermission } : {}),
        ...(session.composerBackendId ? { composerBackendId: session.composerBackendId } : {}),
        ...(session.composerModelId ? { composerModelId: session.composerModelId } : {}),
        ...(Object.keys(session.modelSettings).length > 0 ? { modelSettings: session.modelSettings } : {})
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
      message.type === 'chatTabs' ||
      message.type === 'queuedTurns' ||
      message.type === 'showSettings' ||
      message.type === 'settings' ||
      message.type === 'settingsSave' ||
      message.type === 'skillAction' ||
      message.type === 'codexVersionCheck' ||
      message.type === 'dictationStatus' ||
      message.type === 'dictationCleaned' ||
      message.type === 'dictationError' ||
      message.type === 'modeSwitchPrompt';
    if (!shared && this.session && this.visible && this.session !== this.visible) {
      return;
    }
    let outgoing: HostToWebviewMessage = message;
    // A held question notice rides with the repaint: a separate notice sent
    // before the conversation would be replaced by that replay.
    if (message.type === 'conversation' && this.session?.questionNotice) {
      outgoing = { ...message, notice: this.session.questionNotice };
      this.session.questionNotice = undefined;
    }
    this.deliver(outgoing);
    // A conversation repaint clears the webview's chip list; always follow it
    // with this chat's queue so a rewind, restore or handover cannot hide it.
    if (message.type === 'conversation' && this.visible && !this.visible.disposed) {
      this.postQueuedTurns(this.visible);
    }
  }

  /**
   * A transcript with a large tool result can be rejected by the webview
   * channel. Send a short copy so the chat still appears.
   */
  private deliver(message: HostToWebviewMessage): void {
    const webview = this.view?.webview;
    if (!webview) {
      return;
    }
    void Promise.resolve(webview.postMessage(message)).then(
      () => undefined,
      () => {
        if (message.type !== 'conversation' || !message.replay?.length || this.view?.webview !== webview) {
          return;
        }
        const slim: HostToWebviewMessage = { ...message, replay: workspaceTranscriptTail(message.replay) };
        void Promise.resolve(webview.postMessage(slim)).then(
          () => undefined,
          () => undefined
        );
      }
    );
  }

  private async handle(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case 'composerDraft': {
        const session =
          (message.tabId ? this.liveSessions().find((entry) => entry.id === message.tabId) : undefined) ?? this.visible;
        if (session) {
          const empty = message.text.trim().length === 0 && message.attachments.length === 0;
          if (session.ignoreNextEmptyDraft && empty) {
            session.ignoreNextEmptyDraft = false;
            break;
          }
          if (!empty) {
            session.ignoreNextEmptyDraft = false;
          }
          this.rememberComposer(session, message.text, message.attachments);
        }
        break;
      }
      case 'ready': {
        // Safe mode: a failure or a hang while loading must not leave the chat
        // on the restoring screen. Saved messages are painted first. Queue
        // restore and shrinking the workspace copy run only after that.
        await openSidebarSafely(
          {
            hydrate: () => this.transcriptsReady,
            paint: async () => {
              this.post({ type: 'snapshot', availability: this.registry.snapshot() });
              if (this.liveSessions().length === 0) {
                this.loadSavedSessions();
              }
              const session = this.visible && !this.visible.disposed ? this.visible : this.liveSessions()[0];
              if (session) {
                await this.showSession(session);
              }
            },
            onHydratedLate: async () => {
              const session = this.visible;
              if (!session || session.disposed || session.turnBusy || session.turnOpen || !session.activeThread) {
                return;
              }
              await this.sessionStore.run(session, () => this.repaintSession());
            },
            afterPaint: async () => {
              await this.postContextView();
              // Files are the full transcript. Wait for that read, then drop the
              // bulky workspace-state copy. A file that is already longer is
              // left alone, so this cannot replace it with a short tail.
              await withDeadline(this.transcriptsReady, OPEN_HYDRATE_MS, 'Loading saved chats').catch(() => undefined);
              await this.store.compactWorkspaceCopy();
              // Queued turns are claimed once the tabs exist. Restored turns
              // dispatch for the visible idle chat, or on the next completion.
              await this.restoreQueuedTurns();
              this.flushQueuedTurns();
            }
          },
          (error) => {
            this.post({ type: 'notice', level: 'info', message: safeOpenNotice(error, false) });
          },
          () => this.post({ type: 'restoring', value: false })
        );
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
      case 'listThreads': {
        const backendId = message.backendId;
        const live = await this.registry.listThreads(backendId);
        const stored = new Map(this.store.listThreads(backendId).map((entry) => [entry.threadId, entry.title]));
        this.post({
          type: 'threads',
          backendId,
          threads: live.map((thread) => ({
            ...thread,
            title: this.historyLabel(backendId, thread.threadId, stored.get(thread.threadId), thread.title)
          }))
        });
        break;
      }
      case 'resumeThread':
        await this.resumeThread(message.backendId, message.threadId);
        break;
      case 'loadOlderHistory':
        await this.loadOlderHistory();
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
          message.updatePlan,
          'user',
          message.queue === true
        );
        break;
      case 'steerTurn':
        await this.steerTurn(message.text);
        break;
      case 'cancelQueuedTurn':
        this.cancelQueuedTurn(message.id);
        break;
      case 'retryQuestion':
        await this.sendTurn(
          questionRetryInstruction(),
          message.model,
          message.permissionLevel,
          undefined,
          undefined,
          message.backendId,
          undefined,
          'instruction'
        );
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
      case 'selectModel':
        await this.rememberComposerModel(message.backendId, message.modelId);
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
        // Posted before the first await so the screen shows its busy state
        // immediately, even when a CLI probe or model list is slow.
        this.post({ type: 'settingsSave', pending: true });
        await this.saveSettings(message.patch, message.target);
        break;
      case 'setOpencodeZenToken':
        await this.settings.setOpencodeZenToken(message.value);
        await this.registry.refresh();
        await this.publishSettings();
        break;
      case 'clearOpencodeZenToken':
        await this.settings.clearOpencodeZenToken();
        await this.registry.refresh();
        await this.publishSettings();
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
      case 'testConnection': {
        const result = await this.settings.testConnection(message.backendId, {
          ...(message.cliSource ? { cliSource: message.cliSource } : {}),
          ...(message.path !== undefined ? { path: message.path } : {})
        });
        this.post({ type: 'connectionTest', result });
        if (message.backendId === 'opencode') {
          this.post({ type: 'settings', settings: await this.settingsSnapshot() });
          this.post({ type: 'snapshot', availability: await this.registry.refresh() });
        }
        break;
      }
      case 'showAppSettings':
        this.post({ type: 'showSettings', ...(message.section ? { section: message.section } : {}) });
        break;
      case 'validateCodexVersion': {
        this.post({ type: 'codexVersionCheck', pending: true });
        const checked = await this.settings.validateCodexVersion();
        if (checked.ok) {
          const availability = await this.registry.refresh();
          this.post({ type: 'snapshot', availability });
          this.post({ type: 'settings', settings: await this.settingsSnapshot() });
        }
        this.post({
          type: 'codexVersionCheck',
          pending: false,
          ok: checked.ok,
          message: checked.message
        });
        break;
      }
      case 'upgradeOpencode': {
        this.post({ type: 'opencodeUpgrade', pending: true });
        const outcome = await runSkillOperation(() =>
          this.settings.upgradeOpencode({
            ...(message.cliSource ? { cliSource: message.cliSource } : {}),
            ...(message.path !== undefined ? { path: message.path } : {})
          })
        );
        const upgraded = outcome.value;
        this.post({
          type: 'opencodeUpgrade',
          pending: false,
          ok: upgraded?.ok ?? false,
          message: upgraded?.message ?? outcome.message
        });
        if (upgraded?.ok) {
          try {
            this.post({ type: 'settings', settings: await this.settingsSnapshot() });
            // OpenCode Zen becomes selectable once the shared CLI is present.
            this.post({ type: 'snapshot', availability: await this.registry.refresh() });
          } catch {
            // The upgrade result above has already settled the chip.
          }
        }
        break;
      }
      case 'installOpencode': {
        this.post({ type: 'opencodeInstall', pending: true });
        const outcome = await runSkillOperation(() =>
          this.settings.installOpencode({
            ...(message.cliSource ? { cliSource: message.cliSource } : {}),
            ...(message.path !== undefined ? { path: message.path } : {})
          })
        );
        const installed = outcome.value;
        if (installed?.ok && installed.executablePath) {
          try {
            this.post({ type: 'settings', settings: await this.settingsSnapshot() });
            this.post({ type: 'snapshot', availability: await this.registry.refresh() });
          } catch {
            // The install result below has already settled the chip.
          }
        }
        this.post({
          type: 'opencodeInstall',
          pending: false,
          ok: installed?.ok ?? false,
          message: installed?.message ?? outcome.message,
          ...(installed?.executablePath ? { path: installed.executablePath } : {})
        });
        break;
      }
      case 'setZvecGrep': {
        this.post({ type: 'zvecGrep', pending: true, requested: message.enabled });
        const outcome = await runSkillOperation(() =>
          this.settings.setZvecGrep(message.enabled, {
            ...(message.cliSource ? { cliSource: message.cliSource } : {}),
            ...(message.path !== undefined ? { path: message.path } : {})
          })
        );
        const applied = outcome.value;
        if (applied) {
          try {
            this.post({ type: 'settings', settings: await this.settingsSnapshot() });
          } catch {
            // The final result below still settles the toggle.
          }
        }
        this.post({
          type: 'zvecGrep',
          pending: false,
          ok: applied?.ok ?? false,
          message: applied?.message ?? outcome.message,
          ...(applied?.fieldError
            ? { field: applied.fieldError.field, fieldMessage: applied.fieldError.message }
            : {})
        });
        break;
      }
      case 'setAstGrep': {
        this.post({ type: 'astGrep', pending: true, requested: message.enabled });
        const outcome = await runSkillOperation(() =>
          this.settings.setAstGrep(message.enabled, {
            ...(message.cliSource ? { cliSource: message.cliSource } : {}),
            ...(message.path !== undefined ? { path: message.path } : {})
          })
        );
        const applied = outcome.value;
        if (applied) {
          try {
            this.post({ type: 'settings', settings: await this.settingsSnapshot() });
          } catch {
            // The final result below still settles the toggle.
          }
        }
        this.post({
          type: 'astGrep',
          pending: false,
          ok: applied?.ok ?? false,
          message: applied?.message ?? outcome.message,
          ...(applied?.fieldError
            ? { field: applied.fieldError.field, fieldMessage: applied.fieldError.message }
            : {})
        });
        break;
      }
      case 'installAstGrep': {
        this.post({ type: 'astGrepInstall', pending: true });
        const outcome = await runSkillOperation(() =>
          this.settings.installAstGrep({
            ...(message.cliSource ? { cliSource: message.cliSource } : {}),
            ...(message.path !== undefined ? { path: message.path } : {})
          })
        );
        const installed = outcome.value;
        if (installed?.ok) {
          try {
            this.post({ type: 'settings', settings: await this.settingsSnapshot() });
          } catch {
            // The install result below has already settled the chip.
          }
        }
        this.post({
          type: 'astGrepInstall',
          pending: false,
          ok: installed?.ok ?? false,
          message: installed?.message ?? outcome.message,
          ...(installed?.executablePath ? { path: installed.executablePath } : {})
        });
        break;
      }
      case 'upgradeAstGrep': {
        this.post({ type: 'astGrepInstall', pending: true });
        const outcome = await runSkillOperation(() =>
          this.settings.upgradeAstGrep({
            ...(message.cliSource ? { cliSource: message.cliSource } : {}),
            ...(message.path !== undefined ? { path: message.path } : {})
          })
        );
        const upgraded = outcome.value;
        if (upgraded?.ok) {
          try {
            this.post({ type: 'settings', settings: await this.settingsSnapshot() });
          } catch {
            // The upgrade result below has already settled the chip.
          }
        }
        this.post({
          type: 'astGrepInstall',
          pending: false,
          ok: upgraded?.ok ?? false,
          message: upgraded?.message ?? outcome.message,
          ...(upgraded?.executablePath ? { path: upgraded.executablePath } : {})
        });
        break;
      }
      case 'installZvecGrep': {
        this.post({ type: 'zvecGrepInstall', pending: true });
        const outcome = await runSkillOperation(() =>
          this.settings.installZvecGrep({
            ...(message.cliSource ? { cliSource: message.cliSource } : {}),
            ...(message.path !== undefined ? { path: message.path } : {})
          })
        );
        const installed = outcome.value;
        if (installed?.ok) {
          try {
            this.post({ type: 'settings', settings: await this.settingsSnapshot() });
          } catch {
            // The install result below has already settled the chip.
          }
        }
        this.post({
          type: 'zvecGrepInstall',
          pending: false,
          ok: installed?.ok ?? false,
          message: installed?.message ?? outcome.message,
          ...(installed?.path ? { path: installed.path } : {})
        });
        break;
      }
      case 'skillAction': {
        this.post({
          type: 'skillAction',
          skill: message.skill,
          action: message.action,
          pending: true
        });
        const draft = {
          ...(message.cliSource ? { cliSource: message.cliSource } : {}),
          ...(message.path !== undefined ? { path: message.path } : {})
        };
        const outcome = await runSkillOperation(() =>
          message.action === 'index'
            ? this.settings.buildZvecIndex(draft)
            : this.settings.testSkill(message.skill, draft)
        );
        const result = outcome.value;
        if (result && message.action === 'index') {
          try {
            // The Build action changed the workspace index state in the snapshot.
            this.post({ type: 'settings', settings: await this.settingsSnapshot() });
          } catch {
            // The final result below still settles the action chip.
          }
        }
        this.post({
          type: 'skillAction',
          skill: message.skill,
          action: message.action,
          pending: false,
          ok: result?.ok ?? false,
          message: result?.message ?? outcome.message
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
  /** The model capability read the composer is waiting for, if any. */
  private expectedModelCapability(): { providerId: string; modelId: string } | undefined {
    const visible = this.visible;
    if (!visible || visible.disposed) {
      return undefined;
    }
    const thread = visible.activeThread;
    const providerId =
      visible.composerBackendId && this.registry.get(visible.composerBackendId)
        ? visible.composerBackendId
        : (thread?.backendId ?? this.defaultBackendId());
    const modelId = visible.composerModelId ?? thread?.model;
    if (!modelId) {
      return undefined;
    }
    return { providerId, modelId };
  }

  private shouldPublishModelCapability(
    startedSession: ChatSession | undefined,
    providerId: string,
    modelId: string
  ): boolean {
    if (startedSession && this.visible !== startedSession) {
      return false;
    }
    const expected = this.expectedModelCapability();
    return expected?.providerId === providerId && expected.modelId === modelId;
  }

  private async postModelCapability(providerId: string, modelId: string): Promise<void> {
    const session = this.session;
    if (session && pinnedModelSettings(session.modelSettings, providerId, modelId) === undefined) {
      session.modelSettings = withPinnedDefaults(
        session.modelSettings,
        providerId,
        modelId,
        this.registry.modelSettingOverrides(providerId, modelId)
      );
    }
    try {
      const capabilities = await this.registry.modelCapabilities(providerId, modelId);
      if (!this.shouldPublishModelCapability(session, providerId, modelId)) {
        return;
      }
      const overrides =
        (session ? pinnedModelSettings(session.modelSettings, providerId, modelId) : undefined) ??
        this.registry.modelSettingOverrides(providerId, modelId);
      const settings = resolveModelSettings({
        providerId,
        modelId,
        capabilities,
        overrides: sanitizeOverrides(overrides, capabilities),
        appDefaults: this.appDefaults()
      });
      this.post({ type: 'modelCapability', capability: { providerId, modelId, capabilities, settings } });
    } catch (error) {
      if (!this.shouldPublishModelCapability(session, providerId, modelId)) {
        return;
      }
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
    settings: ModelSettingOverrides
  ): Promise<void> {
    const session = this.session;
    if (session) {
      session.modelSettings = pinModelSettings(
        session.modelSettings,
        providerId,
        modelId,
        settings,
        this.registry.modelSettingOverrides(providerId, modelId)
      );
    }
    await this.registry.setModelSettings(providerId, modelId, settings);
    await this.postModelCapability(providerId, modelId);
    this.persistOpenTabs();
  }

  /** Drop every override for this chat's model and echo the re-resolved settings. */
  private async resetModelSettings(providerId: string, modelId: string): Promise<void> {
    const session = this.session;
    if (session) {
      session.modelSettings = clearPinnedModelSettings(session.modelSettings, providerId, modelId);
    }
    await this.registry.resetModelSettings(providerId, modelId);
    await this.postModelCapability(providerId, modelId);
    this.persistOpenTabs();
  }

  /** Drop one field's override only and echo the re-resolved settings. */
  private async resetModelSettingField(
    providerId: string,
    modelId: string,
    field: ModelSettingField
  ): Promise<void> {
    const session = this.session;
    if (session) {
      session.modelSettings = clearPinnedModelSettingField(
        session.modelSettings,
        providerId,
        modelId,
        field,
        this.registry.modelSettingOverrides(providerId, modelId)
      );
    }
    await this.registry.resetModelSettingField(providerId, modelId, field);
    await this.postModelCapability(providerId, modelId);
    this.persistOpenTabs();
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
      selected: this.sessionPermission(backendId),
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
    if ((this.session?.turnBusy || this.session?.turnOpen) && !fromInitialRequest) {
      this.post({ type: 'notice', level: 'info', message: 'Mode changes apply after the current request finishes.' });
      return;
    }
    const target = backendId ?? this.activeThread?.backendId ?? this.defaultBackendId();
    const mode = this.resolveMode(target, requested);
    this.mode = mode;
    if (this.session) {
      this.session.modeChosen = true;
    }
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
    this.persistOpenTabs();
  }

  /** Push the settings read model, including a browser launch failure. */
  async publishSettings(): Promise<void> {
    this.post({ type: 'settings', settings: await this.settingsSnapshot() });
  }

  /**
   * The settings read model plus the live model lists, so the default-model
   * picker can offer real choices without a second round trip. A provider whose
   * list fails is simply absent; it is never shown as an empty list.
   */
  private async settingsSnapshot(): Promise<import('./protocol').SettingsSnapshot> {
    const snapshot = await this.settings.snapshot();
    if (this.lastOrchestrationTurn) {
      // The last resolved turn is host-side state, not a stored setting, so it
      // is attached to the read model here rather than persisted by the
      // settings service.
      snapshot.orchestration = {
        ...snapshot.orchestration,
        lastTurn: this.lastOrchestrationTurn
      };
    }
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
   *
   * Only the write phase is bounded. The echo probes CLIs and lists models, so
   * racing it against the same deadline reported "Saving took too long" after
   * every write had already succeeded. The footer settles on the write result;
   * the echo then runs on its own and can never turn success into failure.
   */
  private async saveSettings(
    patch: import('./protocol').SettingsPatch,
    target?: 'global' | 'workspace' | 'folder'
  ): Promise<void> {
    const scope = target ?? 'global';
    await runSettingsWrite({
      write: () => this.settings.save(patch, scope),
      echo: (result) => this.echoSavedSettings(patch, result),
      settle: (outcome) => {
        if (outcome.result) {
          const result = outcome.result;
          let message: string | undefined;
          if (!result.ok) {
            const count = Object.keys(result.errors).length;
            message =
              count === 1
                ? 'One setting was not saved. Check the marked field and try again.'
                : `${count} settings were not saved. Check the marked fields and try again.`;
          }
          this.post({ type: 'settingsSave', pending: false, ok: result.ok, message });
          return;
        }
        this.post({
          type: 'settingsSave',
          pending: false,
          ok: false,
          message:
            outcome.error instanceof DeadlineError
              ? SAVE_TIMEOUT_MESSAGE
              : 'Settings were not saved. Your draft is still here, so you can retry.'
        });
      },
      timeoutMs: SETTINGS_SAVE_DEADLINE_MS,
      timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      // The echo is not a save result; a failed refresh is recovered by the
      // next Settings open, so it must never overwrite the reported outcome.
      onEchoError: () => {}
    });
  }

  /** Echo the snapshot and refresh the dependent surfaces after a save. */
  private async echoSavedSettings(
    patch: import('./protocol').SettingsPatch,
    result: SaveResult | undefined
  ): Promise<void> {
    // A saved context change must apply to the next turn of an already-open
    // conversation, not just to a new one. The delivery layer holds a rendered
    // snapshot prefix per thread; drop it so the next turn rebuilds from the new
    // include flags, cap, and patterns. Rebuilding from the current settings is
    // correct even if an unrelated field in the same patch was refused, so this
    // is unconditional on a context patch.
    const touchesContext = Object.keys(patch).some((key) => key.startsWith('context'));
    if (touchesContext) {
      this.contextDelivery.invalidateAll();
    }
    // Echo any refused field back on the snapshot so the screen marks it not
    // saved inline; a refused value was never persisted. A partial write is
    // reported the same way, with every field that failed named.
    const snapshot = await this.settingsSnapshot();
    if (result && !result.ok) {
      snapshot.saveErrors = result.errors;
    }
    // A field that was persisted somewhere other than the requested scope (a
    // trust-sensitive setting saved to the user's own settings during a
    // workspace save) carries a notice, not an error.
    if (result?.notices && Object.keys(result.notices).length > 0) {
      snapshot.saveNotices = result.notices;
    }
    if (result && patch.permissionLevel && result.errors.permissionLevel === undefined) {
      const backendId = this.activeThread?.backendId ?? this.defaultBackendId();
      await this.rememberPermission(this.resolvePermission(backendId, patch.permissionLevel));
      await this.postPermissions(backendId);
    }
    this.post({ type: 'settings', settings: snapshot });
    this.post({ type: 'snapshot', availability: await this.registry.refresh() });
    if (touchesContext) {
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

  /**
   * Paint a blank chat. The first visit seeds the last-used model and the
   * current permission. A later visit keeps the model, mode, permission, and
   * thinking level the user set on this tab.
   */
  private async postFreshConversation(): Promise<void> {
    this.clearHistory(this.session);
    const last = this.store.getLastUsedModel();
    const fallbackBackend = last && this.registry.get(last.backendId) ? last.backendId : this.defaultBackendId();
    const fallbackModel = last?.backendId === fallbackBackend && last.modelId ? last.modelId : undefined;
    const choice = this.composerSelection(fallbackBackend, fallbackModel);
    this.mode = this.resolveMode(choice.backendId, this.mode);
    const permission = this.sessionPermission(choice.backendId);
    this.post({
      type: 'conversation',
      backendId: choice.backendId,
      model: choice.model,
      permissionLevel: permission,
      mode: this.mode,
      hasOlderHistory: false
    });
    await this.finishComposerPaint(choice.backendId, choice.model);
  }

  /**
   * The model this chat should show. A choice already stored on the tab wins.
   * The first visit records the fallback so a later chat cannot replace it.
   */
  private composerSelection(fallbackBackendId: string, fallbackModel?: string): { backendId: string; model?: string } {
    const session = this.session;
    const remembered =
      session?.composerBackendId && this.registry.get(session.composerBackendId) ? session.composerBackendId : undefined;
    if (remembered) {
      return { backendId: remembered, ...(session?.composerModelId ? { model: session.composerModelId } : {}) };
    }
    if (session) {
      session.composerBackendId = fallbackBackendId;
      if (fallbackModel) {
        session.composerModelId = fallbackModel;
      }
    }
    return { backendId: fallbackBackendId, ...(fallbackModel ? { model: fallbackModel } : {}) };
  }

  /** Permission for the chat on screen. The first visit copies the shared choice, then the tab keeps it. */
  private sessionPermission(backendId: string): PermissionLevel {
    const session = this.session;
    const level = this.resolvePermission(backendId, session?.tabPermission ?? this.permissionLevel);
    if (session) {
      session.tabPermission = level;
    }
    return level;
  }

  /** Push the open chat's mode, permission, and model settings, then save them with the tab. */
  private async finishComposerPaint(backendId: string, model?: string): Promise<void> {
    this.post({ type: 'modes', modes: this.modeSnapshot(backendId) });
    await this.postPermissions(backendId);
    if (model) {
      await this.postModelCapability(backendId, model);
    }
    this.persistOpenTabs();
  }

  /** Remember a model pick on the open chat, and as the seed for the next new chat. */
  private async rememberComposerModel(backendId: string, modelId: string): Promise<void> {
    const session = this.session;
    if (session) {
      session.composerBackendId = backendId;
      session.composerModelId = modelId;
      const thread = session.activeThread;
      if (thread && thread.backendId === backendId) {
        thread.model = modelId;
        const stored = this.store.listThreads(backendId).find((entry) => entry.threadId === thread.threadId);
        await this.store.setActiveThread({
          backendId,
          threadId: thread.threadId,
          modelId,
          mode: session.mode,
          title: stored?.title,
          updatedAt: Date.now()
        });
      }
    }
    await this.store.setLastUsedModel({ backendId, modelId });
    this.persistOpenTabs();
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
    // An explicit level wins. Otherwise keep this chat's level, which was seeded
    // from the last picker choice. The mode is the one this chat is already using.
    const level = this.resolvePermission(backendId, permissionLevel ?? this.sessionPermission(backendId));
    const mode = this.resolveMode(backendId, requestedMode ?? this.mode);
    // The effective per-model settings are resolved and clamped here, in the
    // host, against the provider's own descriptor. The webview never computes a
    // value, so a stale value can never reach the provider.
    const modelSettings = await this.resolveTurnSettings(backendId, model, requestedSettings);
    // Starting a new conversation ends the previous one, so its session allows
    // are dropped here rather than lingering into unrelated work. Any request
    // still open on the old thread is abandoned with it.
    this.pendingApproval = undefined;
    const previous = this.activeThread;
    // The chat the user is looking at. A provider switch copies it onto the
    // new thread so the transcript stays the conversation, while the model
    // receives only the summary.
    const carriedHistory =
      handover?.trim() && previous ? this.store.getTranscript(previous.backendId, previous.threadId) : undefined;
    if (previous) {
      await this.registry.endThreadSession(previous.backendId, previous.threadId);
      this.contextDelivery.forget(ContextDelivery.key(previous.backendId, previous.threadId));
    }
    try {
      this.clearHistory(this.session);
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
      if (this.session) {
        this.session.modeChosen = true;
        this.session.tabPermission = level;
        this.session.composerBackendId = backendId;
        const chosenModel = model ?? handle.model;
        if (chosenModel) {
          this.session.composerModelId = chosenModel;
        }
      }
      const carried = carriedHistory && carriedHistory.length > 0 ? carriedHistory : undefined;
      if (carried) {
        this.store.setTranscript(backendId, handle.threadId, carried);
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
        ...(handover?.trim() ? { handoverSummary: handover.trim() } : {}),
        ...(carried ? { handoverHistoryCount: carried.length } : {})
      });
      await this.store.setLastUsedModel({ backendId, modelId: model ?? handle.model ?? '' });
      if (notify) {
        const history = carried ? this.openHistory(carried) : undefined;
        this.post({
          type: 'conversation',
          backendId,
          threadId: handle.threadId,
          model: model ?? handle.model,
          permissionLevel: level,
          mode,
          pendingQuestion: this.pendingQuestionPayload(backendId, handle.threadId),
          ...(history
            ? { replay: await this.previewReplay(history.replay), hasOlderHistory: history.hasOlderHistory }
            : { hasOlderHistory: false }),
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
    requested?: ModelSettingOverrides
  ): Promise<ModelSettingOverrides> {
    if (!model) {
      return {};
    }
    const session = this.session;
    if (requested) {
      if (session) {
        session.modelSettings = pinModelSettings(
          session.modelSettings,
          backendId,
          model,
          requested,
          pinnedModelSettings(session.modelSettings, backendId, model) ?? this.registry.modelSettingOverrides(backendId, model)
        );
      }
      const resolved = await this.registry.setModelSettings(backendId, model, requested);
      return overridesFromResolved(resolved);
    }
    const pinned = session ? pinnedModelSettings(session.modelSettings, backendId, model) : undefined;
    if (pinned) {
      const capabilities = await this.registry.modelCapabilities(backendId, model);
      return overridesFromResolved(
        resolveModelSettings({
          providerId: backendId,
          modelId: model,
          capabilities,
          overrides: sanitizeOverrides(pinned, capabilities),
          appDefaults: this.appDefaults()
        })
      );
    }
    const resolved = await this.registry.resolveModelSettings(backendId, model, this.appDefaults());
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
    const backendId = this.activeThread?.backendId ?? this.session?.composerBackendId ?? this.defaultBackendId();
    const level = this.resolvePermission(backendId, requested);
    if (this.session) {
      this.session.tabPermission = level;
    }
    await this.rememberPermission(level);
    await this.postPermissions(backendId);
    this.persistOpenTabs();
  }

  private resolvePermission(backendId: string, requested?: PermissionLevel): PermissionLevel {
    const supported = this.registry.permissionLevels(backendId);
    if (requested && supported.includes(requested)) {
      return requested;
    }
    return supported.includes('default') ? 'default' : supported[0] ?? 'default';
  }

  /** Drop a tab's captured history so the next conversation does not inherit it. */
  private clearHistory(session: ChatSession | undefined): void {
    if (!session) {
      return;
    }
    session.loadedTranscript = undefined;
    session.historyHidden = undefined;
    session.serverHasOlder = false;
  }

  /**
   * Paint a stored transcript in full. Everything the local log already holds
   * is on screen when the chat opens; only rows the provider still has to send
   * are fetched later, so a reload never truncates a conversation.
   */
  private openHistory(items: TranscriptItem[], serverHasOlder = false): { replay: TranscriptItem[]; hasOlderHistory: boolean } {
    const session = this.session;
    if (session) {
      session.loadedTranscript = items;
      session.historyHidden = 0;
      session.serverHasOlder = serverHasOlder;
    }
    return { replay: items, hasOlderHistory: serverHasOlder };
  }

  /** The painted page of the tab's current history, without resetting the window. */
  private currentHistory(): { replay: TranscriptItem[]; hasOlderHistory: boolean } {
    const session = this.session;
    if (!session) {
      return { replay: [], hasOlderHistory: false };
    }
    session.historyHidden = 0;
    return {
      replay: this.historyItems(session),
      hasOlderHistory: Boolean(session.serverHasOlder)
    };
  }

  /** Loaded snapshot plus turns recorded after it. The local log stays the tail. */
  private historyItems(session: ChatSession): TranscriptItem[] {
    const thread = session.activeThread;
    const stored = thread ? this.store.getTranscript(thread.backendId, thread.threadId) : [];
    return transcriptWithNewer(session.loadedTranscript, stored);
  }

  /**
   * Prepend the next older page. Stored rows are revealed first. When those
   * run out, Codex is asked for the previous turn or item page.
   */
  private async loadOlderHistory(): Promise<void> {
    if (this.olderHistoryInFlight) {
      return;
    }
    const session = this.session;
    const thread = session?.activeThread;
    if (!session || !thread) {
      return;
    }
    this.olderHistoryInFlight = true;
    try {
      const items = this.historyItems(session);
      let hidden = session.historyHidden ?? 0;
      if (hidden > 0) {
        const revealed = revealStoredHistory(items, hidden);
        session.historyHidden = revealed.hidden;
        await this.postOlder(thread, revealed.added, revealed.hidden > 0 || Boolean(session.serverHasOlder));
        return;
      }
      const backend = this.registry.get(thread.backendId);
      if (!session.serverHasOlder || !backend?.loadOlderHistory) {
        session.serverHasOlder = false;
        await this.postOlder(thread, [], false);
        return;
      }
      let current = items;
      let added: TranscriptItem[] = [];
      let hasMore = true;
      for (let attempt = 0; attempt < 4 && added.length === 0 && hasMore; attempt += 1) {
        const page = await backend.loadOlderHistory(thread.threadId);
        hasMore = page.hasMore;
        const next = prependOlderHistory(current, hidden, page.items);
        current = next.items;
        hidden = next.hidden;
        added = next.added;
        if (page.items.length === 0) {
          break;
        }
      }
      session.loadedTranscript = current;
      session.historyHidden = hidden;
      session.serverHasOlder = hasMore;
      await this.postOlder(thread, added, hidden > 0 || hasMore);
    } catch (error) {
      this.post({
        type: 'notice',
        level: 'warning',
        message: error instanceof Error ? error.message : 'Earlier messages could not be loaded.'
      });
      await this.postOlder(thread, [], (session.historyHidden ?? 0) > 0 || Boolean(session.serverHasOlder));
    } finally {
      this.olderHistoryInFlight = false;
    }
  }

  private async postOlder(thread: ThreadHandle, items: TranscriptItem[], hasOlderHistory: boolean): Promise<void> {
    this.post({
      type: 'olderHistory',
      backendId: thread.backendId,
      threadId: thread.threadId,
      items: await this.previewReplay(items),
      hasOlderHistory
    });
  }

  /**
   * Put the saved transcript on screen without waiting for the provider.
   * Safe mode uses this so a resume error still leaves the chat usable.
   */
  private async paintStoredThread(backendId: string, threadId: string, storedItems: TranscriptItem[]): Promise<void> {
    const ref = this.store.listThreads(backendId).find((entry) => entry.threadId === threadId);
    this.activeThread = { backendId, threadId, model: ref?.modelId };
    this.syncPlanPreviewThread(threadId);
    if (!this.session?.modeChosen) {
      this.mode = this.resolveMode(backendId, ref?.mode ?? this.mode);
      if (this.session) {
        this.session.modeChosen = true;
      }
    } else {
      this.mode = this.resolveMode(backendId, this.mode);
    }
    const titled = historyThreadTitle(
      ref?.title,
      storedItems.find((item) => item.role === 'user' && !item.orchestration && item.text?.trim())?.text
    );
    if (this.session) {
      this.session.blank = false;
      this.session.title = tabTitle(titled);
      this.publishTabs();
    }
    const history = this.openHistory(this.store.mergeApprovalMarkers(backendId, threadId, storedItems));
    const choice = this.composerSelection(backendId, ref?.modelId);
    const permission = this.sessionPermission(choice.backendId);
    this.post({
      type: 'conversation',
      backendId: choice.backendId,
      threadId,
      model: choice.model,
      permissionLevel: permission,
      mode: this.mode,
      replay: await this.previewReplay(history.replay),
      hasOlderHistory: history.hasOlderHistory,
      pendingQuestion: this.pendingQuestionPayload(backendId, threadId),
      plan: this.store.getPlanState(backendId, threadId) ? this.planArtifact(backendId, threadId) : undefined
    });
    try {
      await this.finishComposerPaint(choice.backendId, choice.model);
      await this.postLatestChanges();
      await this.postActiveCheckpoints();
    } catch {
      // The transcript is already on screen. Composer details and change cards can catch up.
    }
  }

  /** Reconnects to a listed thread and replays its stored turns. */
  private async resumeThread(backendId: string, threadId: string): Promise<void> {
    try {
      await withDeadline(this.transcriptsReady, RESUME_HYDRATE_MS, 'Loading saved chats');
    } catch {
      // Paint with the copy already in memory.
    }
    const storedItems = this.store.getTranscript(backendId, threadId);
    let painted = false;
    if (storedItems.length > 0) {
      try {
        await this.paintStoredThread(backendId, threadId, storedItems);
        painted = true;
      } catch {
        // The provider replay below can still paint the chat.
      }
    }
    // Saved messages leave the restoring screen immediately. A provider hang
    // must not cover them again.
    this.post({ type: 'restoring', value: !painted });
    try {
      const backend = this.registry.get(backendId);
      if (!backend) {
        this.post({
          type: 'notice',
          level: painted ? 'info' : 'warning',
          message: painted
            ? 'That provider is not available. Your saved messages are on screen, and you can keep working.'
            : 'That conversation could not be restored because its provider is not available.'
        });
        return;
      }
      // A resumed thread is re-primed with a fresh snapshot, because the upstream
      // context may be gone after the replay. A slow read must not block the chat.
      const snap = this.contextDelivery.snapshot();
      void snap.then(
        () => undefined,
        () => undefined
      );
      const prime = await withDeadline(snap, RESUME_SNAPSHOT_MS, 'Reading the project').catch(() => ({
        payload: { priming: true }
      }));
      const stored = this.store.listThreads(backendId).find((entry) => entry.threadId === threadId);
      const resume = backend.resumeThread(threadId, {
        context: prime.payload,
        handover: stored?.handoverSummary
      });
      void resume.then(
        () => undefined,
        () => undefined
      );
      const result = await withDeadline(resume, RESUME_PROVIDER_MS, 'Reconnecting to the provider');
      this.activeThread = result.handle;
      this.syncPlanPreviewThread(result.handle.threadId);
      this.contextDelivery.begin(
        ContextDelivery.key(backendId, threadId),
        prime,
        Boolean(result.handle.contextPrimed)
      );
      // The thread index carries the mode, so a resumed thread keeps its mode
      // until this tab has its own choice. A mode the backend cannot serve
      // degrades to `agent`.
      const ref = stored ?? this.store.listThreads(backendId).find((entry) => entry.threadId === threadId);
      if (!this.session?.modeChosen) {
        this.mode = this.resolveMode(backendId, ref?.mode ?? this.mode);
        if (this.session) {
          this.session.modeChosen = true;
        }
      } else {
        this.mode = this.resolveMode(backendId, this.mode);
      }
      const titled = historyThreadTitle(
        ref?.title,
        result.items.find((item) => item.role === 'user' && !item.orchestration && item.text?.trim())?.text
      );
      const choice = this.composerSelection(backendId, result.model);
      await this.store.setActiveThread({
        backendId,
        threadId,
        modelId: choice.backendId === backendId ? choice.model ?? result.model : result.model,
        mode: this.mode,
        title: titled,
        updatedAt: Date.now()
      });
      if (this.session) {
        this.session.blank = false;
        this.session.title = tabTitle(titled);
        this.publishTabs();
      }
      const storedItems = this.store.getTranscript(backendId, threadId);
      const carriedCount = ref?.handoverHistoryCount ?? 0;
      const carried = carriedCount > 0 ? storedItems.slice(0, carriedCount) : [];
      const tailStored = carriedCount > 0 ? storedItems.slice(carriedCount) : storedItems;
      const tail = result.items.length > 0 ? withStoredHistory(result.items, tailStored) : tailStored;
      const source = carried.length > 0 ? [...carried, ...tail] : result.items.length > 0 ? tail : storedItems;
      const history = this.openHistory(
        this.store.mergeApprovalMarkers(backendId, threadId, source),
        Boolean(result.hasOlderHistory)
      );
      const permission = this.sessionPermission(choice.backendId);
      this.post({
        type: 'conversation',
        backendId: choice.backendId,
        threadId,
        model: choice.model,
        permissionLevel: permission,
        mode: this.mode,
        replay: await this.previewReplay(history.replay),
        hasOlderHistory: history.hasOlderHistory,
        pendingApproval: this.pendingApproval,
        pendingQuestion: this.pendingQuestionPayload(backendId, threadId),
        plan: this.store.getPlanState(backendId, threadId)
          ? this.planArtifact(backendId, threadId)
          : undefined
      });
      await this.finishComposerPaint(choice.backendId, choice.model);
      if (result.recovered) {
        const provider = backendId === 'codex' ? 'Codex' : 'OpenCode';
        this.post({ type: 'notice', level: 'info', message: threadRecoveredNotice(provider) });
      }
      // Repaint the resumed thread's own recorded change set, so the change
      // surface matches the thread now in view rather than carrying the previous
      // conversation's files.
      try {
        await this.postLatestChanges();
        await this.postActiveCheckpoints();
      } catch {
        // The transcript is already on screen.
      }
    } catch (error) {
      // Safe mode: any resume failure keeps the saved chat on screen.
      if (storedItems.length > 0 && !painted) {
        try {
          await this.paintStoredThread(backendId, threadId, storedItems);
          painted = true;
        } catch {
          painted = false;
        }
      }
      this.post({
        type: 'notice',
        level: painted ? 'info' : 'warning',
        message:
          painted && isMissingThreadError(error)
            ? 'The provider thread was not found. This chat is still here, and the next message continues it on a new thread with the earlier context.'
            : safeOpenNotice(error, painted)
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
    updatePlan?: boolean,
    origin: 'user' | 'autopilot' | 'continue' | 'instruction' = 'user',
    queueRequested = false,
    queuedDispatch = false
  ): Promise<void> {
    const session = this.session;
    if (origin === 'user' && session?.turnBusy && !queuedDispatch) {
      if (shouldQueueWhileBusy({ busy: true, queueRequested, attachmentCount: attachments?.length ?? 0 })) {
        await this.enqueueUserTurn(session, {
          text,
          model,
          permissionLevel,
          requestedSettings,
          attachments,
          backendId,
          updatePlan
        });
        return;
      }
      this.holdUnsent(
        text,
        attachments,
        'A request is already in progress on this chat. Wait for it to finish before sending another.'
      );
      return;
    }
    // A `queue:true` send can race the end of the host turn: the webview still
    // thinks it is busy and drew no bubble, so the host posts the row itself.
    const announceUserMessage = shouldAnnounceUserMessage({
      origin,
      busy: Boolean(session?.turnBusy),
      queueRequested,
      queuedDispatch
    });
    if (session) {
      session.turnBusy = true;
      session.heldNotice = undefined;
    }
    let sent = false;
    try {
      sent = await this.sendTurnCore(
        text,
        model,
        permissionLevel,
        requestedSettings,
        attachments,
        backendId,
        updatePlan,
        origin,
        announceUserMessage
      );
    } finally {
      if (session) {
        session.turnBusy = false;
      }
    }
    if (!sent && origin === 'user') {
      // The bubble is already on screen. A rate limit or any other failed send
      // leaves it there and only restores the composer so the text can be sent again.
      this.holdUnsent(text, attachments, undefined, true);
    }
    this.flushQueuedTurns();
  }

  /**
   * The send did not start a turn. Put the text back on this tab and, when
   * `notice` is set, keep that warning with the tab across switches.
   * `keepMessage` leaves the chat bubble in place. A usage-limit failure is
   * one of those: the words the user sent stay visible above the error.
   */
  private holdUnsent(
    text: string,
    attachments: Attachment[] | undefined,
    notice?: string,
    keepMessage = false
  ): void {
    const session = this.session;
    if (!session) {
      if (notice) {
        this.post({ type: 'notice', level: 'info', message: notice });
      }
      return;
    }
    const cleared = session.composerText.trim().length === 0 && session.composerAttachments.length === 0;
    this.rememberComposer(session, text, attachments ?? []);
    if (!cleared) {
      session.ignoreNextEmptyDraft = true;
    }
    if (notice) {
      session.heldNotice = { level: 'info', message: notice };
      this.post({ type: 'notice', level: 'info', message: notice });
    }
    if (!keepMessage) {
      this.post({ type: 'revertLocalSend', text });
    }
    void this.postComposerDraft(session);
  }

  /**
   * Compact the open chat into a summary the next provider can continue from.
   * The summary is asked of the provider being switched to. The one being left
   * can be rate-limited, and that must not keep the chat there.
   * Returns the summary, a recent excerpt when a summary cannot be made,
   * `undefined` when there is nothing to carry, or `'failed'` when compaction
   * was canceled. A cancel leaves the current thread in place.
   */
  private async compactHandover(
    thread: ThreadHandle,
    destination: { backendId: string; model?: string }
  ): Promise<string | undefined | 'failed'> {
    const transcript = this.store.getTranscript(thread.backendId, thread.threadId);
    const source = compactionSource(transcript);
    if (!source.trim()) {
      return undefined;
    }
    const backend = this.registry.get(destination.backendId);
    const model = destination.model;
    if (!backend || !model) {
      return fitCompactionSource(source, undefined);
    }
    this.post({ type: 'busy', value: true });
    try {
      const modelSettings = await this.resolveTurnSettings(destination.backendId, model);
      const summary = await backend.summarize({
        model,
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
      const message =
        error instanceof BackendError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Context could not be compacted.';
      if (message === 'Compaction canceled.') {
        this.post({ type: 'busy', value: false });
        this.post({ type: 'notice', level: 'info', message });
        return 'failed';
      }
      return fitCompactionSource(source, undefined);
    }
  }

  /**
   * Compact the active thread when the ring says the window is above 25% and
   * nothing else is running. Codex compacts in the app-server. Ollama returns
   * a replacement transcript, which is what the next turn is built from.
   */
  private async compactContext(usedTokens: number, maxTokens: number): Promise<void> {
    if (this.session?.turnBusy || this.session?.turnOpen || !canCompactContext(contextUsagePercent(usedTokens, maxTokens), false)) {
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
    if (this.session) {
      this.session.turnBusy = true;
    }
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
        const history = this.openHistory(result.transcript);
        this.post({
          type: 'conversation',
          backendId: active.backendId,
          threadId: active.threadId,
          model,
          permissionLevel: this.sessionPermission(active.backendId),
          mode: this.mode,
          replay: await this.previewReplay(history.replay),
          hasOlderHistory: history.hasOlderHistory,
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
      if (this.session) {
        this.session.turnBusy = false;
      }
      this.post({ type: 'busy', value: false, backendId: active.backendId, threadId: active.threadId });
    }
    this.flushQueuedTurns();
  }

  /**
   * Accept a user turn for later instead of starting it now. Validation runs
   * before anything is queued: malformed or oversized attachments get the same
   * composer error as an attach attempt, and the turn is never silently lost.
   */
  private async enqueueUserTurn(
    session: ChatSession,
    input: {
      text: string;
      model?: string;
      permissionLevel?: PermissionLevel;
      requestedSettings?: import('./backends/types').ModelSettingOverrides;
      attachments?: Attachment[];
      backendId?: string;
      updatePlan?: boolean;
    }
  ): Promise<void> {
    const raw = input.attachments ?? [];
    const parsed = parseDraftAttachments(raw);
    if (parsed.length !== raw.length) {
      this.postQueueAttachmentError();
      return;
    }
    // Clipboard bytes become a path before queueing, so a reload cannot strand
    // them in memory and the entry stays plain JSON.
    const retained = persistableAttachments(await this.retainClipboardAttachments(raw)) ?? [];
    const attachments = parseDraftAttachments(retained);
    if (attachments.length !== retained.length) {
      this.postQueueAttachmentError();
      return;
    }
    const invalid = invalidQueuedAttachment(attachments, MAX_ATTACHMENT_BYTES);
    if (invalid) {
      this.post({ type: 'attachmentError', message: invalid });
      return;
    }
    // Record the thread this turn was typed into, but only when the chosen
    // provider owns that thread. A pair is needed for a restore to reopen it.
    const activeThread = session.activeThread;
    const targetBackend = input.backendId ?? activeThread?.backendId;
    const target =
      activeThread && targetBackend === activeThread.backendId
        ? { backendId: activeThread.backendId, threadId: activeThread.threadId }
        : undefined;
    const entry: QueuedTurn = {
      id: createQueuedTurnId(),
      sessionId: session.id,
      text: input.text,
      attachments,
      createdAt: Date.now(),
      mode: session.mode,
      ...(input.model ? { model: input.model } : {}),
      ...(input.permissionLevel ? { permissionLevel: input.permissionLevel } : {}),
      ...(input.requestedSettings ? { modelSettings: input.requestedSettings } : {}),
      ...(target ? { backendId: target.backendId, threadId: target.threadId } : {}),
      ...(input.updatePlan !== undefined ? { updatePlan: input.updatePlan } : {})
    };
    const outcome = enqueueTurn(this.userTurnQueues, entry);
    if (outcome === 'duplicate') {
      // The webview may still be waiting for an echo of this exact turn.
      this.postQueuedTurns(session);
      this.persistQueuedTurns();
      return;
    }
    if (outcome === 'full') {
      this.postQueuedTurns(session);
      this.post({
        type: 'notice',
        level: 'info',
        message: `This chat already has ${USER_TURN_QUEUE_CAP} queued messages. Wait for one to send or remove one.`
      });
      return;
    }
    this.persistQueuedTurns();
    this.postQueuedTurns(session);
  }

  private postQueueAttachmentError(): void {
    this.post({
      type: 'attachmentError',
      message: 'One file could not be queued because it was unreadable, unsupported, or too large.'
    });
  }

  /** The visible chat is the only one whose composer shows queued chips. */
  private postQueuedTurns(session: ChatSession | undefined = this.visible): void {
    if (!session || session.disposed || this.visible !== session) {
      return;
    }
    this.post({ type: 'queuedTurns', entries: queuedTurnViews(this.userTurnQueues, session.id) });
  }

  private cancelQueuedTurn(id: string): void {
    const session = this.session;
    if (session && removeQueuedTurn(this.userTurnQueues, session.id, id)) {
      this.blockedQueuedTurns.delete(id);
      this.persistQueuedTurns();
      this.postQueuedTurns(session);
    }
  }

  /** Drop a chat's queue together with any blocked-entry markers. */
  private discardSessionQueue(sessionId: string): number {
    for (const entry of this.userTurnQueues.get(sessionId) ?? []) {
      this.blockedQueuedTurns.delete(entry.id);
    }
    return clearSessionQueue(this.userTurnQueues, sessionId);
  }

  /**
   * Workspace state holds accepted turns so a reload or extension-host restart
   * cannot lose text the composer already cleared. Entries carry paths, never
   * bytes. While this window owns a non-empty queue it refreshes a lease so a
   * second window on the same workspace leaves the queue alone instead of
   * dispatching the same messages. (VS Code workspace state is per folder, not
   * live-synced between windows; the lease is the conservative guard.)
   */
  private persistQueuedTurns(): void {
    if (this.queueFlushStopped) {
      // The lease was handed back; writing again would steal it from the next
      // window that is now allowed to dispatch the same entries.
      return;
    }
    const queuedTurns = this.queuedTurnCount();
    void this.writeQueuedTurns(queueLeaseOwner(queuedTurns, this.queueOwnerId));
    if (queuedTurns > 0) {
      this.startQueueHeartbeat();
    } else {
      // Emptying the queue releases the lease immediately instead of leaving a
      // false "another window" owner for the full ten minutes.
      this.stopQueueHeartbeat();
    }
  }

  private queuedTurnCount(): number {
    let count = 0;
    for (const queue of this.userTurnQueues.values()) {
      count += queue.length;
    }
    return count;
  }

  /** Serialize writes so an awaited release is always the last workspace update. */
  private writeQueuedTurns(owner: string | undefined): Promise<void> {
    const payload = serializeTurnQueues(this.userTurnQueues, owner);
    const write = this.queueWrite.then(() =>
      Promise.resolve(this.context.workspaceState.update(QUEUED_TURNS_KEY, payload))
    );
    this.queueWrite = write.then(
      () => undefined,
      () => undefined
    );
    return this.queueWrite;
  }

  private startQueueHeartbeat(): void {
    if (this.queueHeartbeat || this.queueFlushStopped) {
      return;
    }
    this.queueHeartbeat = setInterval(() => {
      if (this.queueFlushStopped || this.queuedTurnCount() === 0) {
        this.stopQueueHeartbeat();
        return;
      }
      void this.writeQueuedTurns(this.queueOwnerId);
    }, 30_000);
  }

  private stopQueueHeartbeat(): void {
    if (this.queueHeartbeat) {
      clearInterval(this.queueHeartbeat);
      this.queueHeartbeat = undefined;
    }
  }

  /**
   * Hand the lease back only when nothing is left to dispatch, or on shutdown.
   * A disposed webview in a live extension host keeps the lease: its running
   * turn can still call `flushQueuedTurns`, and another window claiming the
   * queue would send the same messages twice.
   */
  private async releaseQueueLease(shuttingDown: boolean): Promise<void> {
    this.stopQueueHeartbeat();
    if (this.queueRestoreTimer) {
      clearTimeout(this.queueRestoreTimer);
      this.queueRestoreTimer = undefined;
    }
    if (shuttingDown) {
      this.queueFlushStopped = true;
    }
    const queuedTurns = this.queuedTurnCount();
    if (queueLeaseDisposition({ queuedTurns, shuttingDown }) === 'keep') {
      // Leave the persisted owner and heartbeat in place for this live window.
      this.startQueueHeartbeat();
      return;
    }
    if (queuedTurns === 0) {
      this.blockedQueuedTurns.clear();
    }
    const payload = parsePersistedTurnQueues(this.context.workspaceState.get(QUEUED_TURNS_KEY));
    if (!payload || (payload.owner && payload.owner !== this.queueOwnerId)) {
      // Another window already owns it; never clobber a newer claim.
      return;
    }
    await this.writeQueuedTurns(undefined);
  }

  /** Called from `deactivate`: stop local flushing, then await the release. */
  async shutdownQueue(): Promise<void> {
    this.queueFlushStopped = true;
    await this.releaseQueueLease(true);
  }

  private scheduleQueueRestore(delayMs: number): void {
    if (this.queueRestoreTimer) {
      clearTimeout(this.queueRestoreTimer);
    }
    this.queueRestoreTimer = setTimeout(() => {
      this.queueRestoreTimer = undefined;
      void this.restoreQueuedTurns();
    }, delayMs);
  }

  private async restoreQueuedTurns(): Promise<void> {
    if (this.queuesRestored || this.queueFlushStopped) {
      return;
    }
    const payload = parsePersistedTurnQueues(this.context.workspaceState.get(QUEUED_TURNS_KEY));
    if (!payload) {
      this.queuesRestored = true;
      return;
    }
    if (foreignQueueLeaseIsLive(payload.owner, payload.heartbeat, this.queueOwnerId)) {
      // Another window is using the queue. Wait until its lease would expire
      // rather than claim or mutate its data.
      const wait = Math.max(1_000, QUEUE_LEASE_MS - (Date.now() - payload.heartbeat) + 500);
      this.scheduleQueueRestore(wait);
      this.post({
        type: 'notice',
        level: 'info',
        message: 'Queued messages belong to another window on this workspace. They will be restored here if that window closes.'
      });
      return;
    }
    // Claim before populating, then read the claim back. Two cold-starting
    // windows can still both write here (workspace state has no compare-and-
    // swap and is not live-synced); the read-back narrows the race, and the
    // loser backs off rather than dispatching the same entries.
    await this.context.workspaceState.update(QUEUED_TURNS_KEY, {
      ...payload,
      owner: this.queueOwnerId,
      heartbeat: Date.now()
    });
    const claim = parsePersistedTurnQueues(this.context.workspaceState.get(QUEUED_TURNS_KEY));
    if (claim?.owner !== this.queueOwnerId) {
      this.scheduleQueueRestore(1_000);
      return;
    }
    this.queuesRestored = true;
    const isKnownBackend = (backendId: string): boolean => Boolean(this.registry.get(backendId));
    let restored = 0;
    let orphaned = 0;
    let reopened = false;
    for (const [sessionId, turns] of payload.queues) {
      // Each entry remembers the backend and thread it was typed into. Validate
      // that target before restore: a partial or unknown-provider pair cannot be
      // dispatched safely and is reported instead of being sent elsewhere.
      const targets = new Map<string, QueuedTurn>();
      for (const turn of turns) {
        if (queuedTurnThreadTarget(turn, isKnownBackend) === 'invalid') {
          orphaned += 1;
          continue;
        }
        targets.set(turn.id, turn);
      }
      const valid = turns.filter((turn) => targets.has(turn.id));
      if (valid.length === 0) {
        continue;
      }
      let session = this.sessions.find((entry) => entry.id === sessionId && !entry.disposed);
      if (!session) {
        // The saved tab list can lag a crash. Reopen the chat from the first
        // valid entry's thread; later entries retarget themselves on dispatch.
        const firstTarget = valid
          .map((turn) => queuedTurnThreadTarget(turn, isKnownBackend))
          .find((target): target is { backendId: string; threadId: string } => Boolean(target));
        if (!firstTarget) {
          orphaned += valid.length;
          continue;
        }
        session = this.createSession({
          tabId: sessionId,
          blank: false,
          backendId: firstTarget.backendId,
          threadId: firstTarget.threadId,
          title: 'Restored chat'
        });
        reopened = true;
      }
      for (const turn of valid) {
        if (enqueueTurn(this.userTurnQueues, { ...turn, sessionId: session.id }) === 'queued') {
          restored += 1;
          // A restored chat sends as soon as it is shown idle, not because some
          // other chat's turn happened to finish.
          this.restoredQueueSessions.add(session.id);
        }
      }
    }
    if (reopened) {
      this.persistOpenTabs();
    }
    this.persistQueuedTurns();
    if (restored > 0) {
      this.post({
        type: 'notice',
        level: 'info',
        message:
          restored === 1
            ? 'Restored 1 queued message. It sends when its chat is idle.'
            : `Restored ${restored} queued messages. They send when their chats are idle.`
      });
    }
    if (orphaned > 0) {
      this.post({
        type: 'notice',
        level: 'warning',
        message:
          orphaned === 1
            ? '1 queued message could not be restored because its chat or thread is no longer available.'
            : `${orphaned} queued messages could not be restored because their chats or threads are no longer available.`
      });
    }
  }

  /** Paths can disappear between queueing and dispatch (workspace storage reset). */
  private async missingQueuedAttachmentNames(attachments: readonly Attachment[]): Promise<string[]> {
    const missing: string[] = [];
    for (const attachment of attachments) {
      if (!attachment.path) {
        continue;
      }
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(attachment.path));
      } catch {
        missing.push(attachment.name);
      }
    }
    return missing;
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
    if (!value || !active || !(this.session?.turnBusy || this.session?.turnOpen)) return;
    const backend = this.registry.get(active.backendId);
    if (!backend?.steerTurn) {
      this.post({ type: 'notice', level: 'info', message: 'This provider cannot accept steer messages while busy.' });
      return;
    }
    try {
      const messageId = await this.store.appendUserMessage(active.backendId, active.threadId, value, undefined, false);
      await this.captureSentMessage(active.backendId, active.threadId, messageId);
      await backend.steerTurn(active, this.consumeRewindNote(active.backendId, active.threadId, value), messageId);
      await this.store.flush();
    } catch (error) {
      this.post({ type: 'notice', level: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Ask in the sidebar before a turn moves to a mode that can do more.
   * Closing the sidebar, or a webview that is not listening, keeps the current mode.
   */
  private confirmPermissiveModeSwitch(from: DefaultMode, to: DefaultMode): Promise<boolean> {
    this.declinePendingModeSwitches();
    if (!this.view || !this.webviewMounted) {
      return Promise.resolve(false);
    }
    const requestId = `mode-switch-${++this.modeSwitchSeq}`;
    return new Promise((resolve) => {
      this.modeSwitchWaiters.set(requestId, resolve);
      this.post({ type: 'modeSwitchPrompt', requestId, from, to });
    });
  }

  private answerModeSwitch(requestId: string, accept: boolean): void {
    const resolve = this.modeSwitchWaiters.get(requestId);
    if (!resolve) {
      return;
    }
    this.modeSwitchWaiters.delete(requestId);
    resolve(accept);
  }

  /** A dialog that is no longer on screen must not leave its turn waiting. */
  private declinePendingModeSwitches(): void {
    for (const resolve of this.modeSwitchWaiters.values()) {
      resolve(false);
    }
    this.modeSwitchWaiters.clear();
  }

  /** Detect mode only before this user request enters a provider turn. */
  private async sendTurnCore(
    text: string,
    model?: string,
    permissionLevel?: PermissionLevel,
    requestedSettings?: import('./backends/types').ModelSettingOverrides,
    attachments?: Attachment[],
    backendId?: string,
    updatePlan?: boolean,
    origin: 'user' | 'autopilot' | 'continue' | 'instruction' = 'user',
    announceUserMessage = false
  ): Promise<boolean> {
    const openedAt = Date.now();
    if (this.session) {
      this.session.turnPlan = undefined;
    }
    const automatic = origin === 'autopilot';
    const continuing = origin === 'continue';
    const instruction = origin === 'instruction';
    // Injected continuations and host-built instructions are orchestration, not
    // something the user typed. They still open a real turn, so every checkpoint
    // and change card path keeps working; only the transcript presentation
    // differs.
    const orchestration = automatic || continuing || instruction;
    if (this.session) {
      this.session.planRunAutomatic = automatic;
      if (!automatic && !continuing) {
        this.planAutopilotQueue.delete(this.session.id);
        this.crashContinueQueue.delete(this.session.id);
        this.session.planEpoch += 1;
        this.session.planRunSignature = undefined;
        this.session.stopContinueAttempts = 0;
      }
    }
    this.revisePlanThisTurn = updatePlan === true || userAsksToRevisePlan(text);
    const candidateBackend = backendForTurn({
      requestedBackendId: backendId,
      requestedModel: model,
      composerBackendId: this.session?.composerBackendId,
      composerModelId: this.session?.composerModelId,
      threadBackendId: this.activeThread?.backendId,
      availableBackendId: this.registry.snapshot().find((backend) => backend.status === 'available')?.id
    });
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
          const accept = await this.confirmPermissiveModeSwitch(currentMode, suggestedMode);
          selectedMode = accept ? suggestedMode : undefined;
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
      return false;
    }
    // A model pick only updates the webview. A different provider continues
    // this chat: the transcript stays on screen, and a summary of it is the
    // next thread's model context. An empty chat just opens a thread.
    let handover: string | undefined;
    if (this.activeThread && this.activeThread.backendId !== candidateBackend) {
      const summary = await this.compactHandover(this.activeThread, { backendId: candidateBackend, model });
      if (summary === 'failed') {
        return false;
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
      return false;
    }
    const { backendId: activeBackendId, threadId } = this.activeThread;
    const backend = this.registry.get(activeBackendId);
    if (!backend) {
      return false;
    }
    // Clipboard images have no path. Copy them into workspace storage first so
    // a reload can show the same thumbnail. The transcript then keeps the path,
    // not the bytes, and workspace state stays free of file contents.
    const persisted = persistableAttachments(await this.retainClipboardAttachments(attachments));
    const resolvedModel = model ?? this.activeThread.model;
    const level = this.resolvePermission(activeBackendId, permissionLevel ?? this.permissionLevel);
    await this.rememberPermission(level);
    // The mode is resolved and re-applied on every turn. Ask forces read-only;
    // Plan and Agent honor the selected permission level.
    const mode = this.resolveMode(activeBackendId, this.mode);
    this.mode = mode;
    if (this.session) {
      this.session.turnPlan = planTurn({
        text,
        mode,
        origin,
        hasAttachments: (attachments?.length ?? 0) > 0,
        hasActivePlan: Boolean(this.store.getPlanState(activeBackendId, threadId)),
        settings: readOrchestrationSettings()
      });
    }
    // The per-model settings are resolved and clamped in the host, so a stale
    // value can never be sent.
    const modelSettings = await this.resolveTurnSettings(activeBackendId, resolvedModel, requestedSettings);
    // Context for this turn: the queued snapshot on the first turn (unless an
    // adapter consumed it natively at start), otherwise a compact delta. It is
    // read before the user message is appended so it never touches the stored
    // transcript, and a failed snapshot degrades to a notice rather than
    // blocking the turn.
    const context = await this.turnContext(activeBackendId, threadId, text);
    // The exclusions shaped the snapshot this turn carries, so they are cleared
    // now: the next turn defaults back to the full set unless the user excludes
    // again, and nothing is re-added on its own mid-turn.
    if (this.contextDelivery.exclusionKeys().length > 0) {
      this.contextDelivery.setExclusions([]);
      void this.postContextView();
    }
    // Only the user moving on hides a finished plan row; an orchestration
    // continuation is still that plan's own work.
    if (!orchestration) {
      await this.dismissCompletedPlan(activeBackendId, threadId);
    }
    const messageId = await this.store.appendUserMessage(
      activeBackendId,
      threadId,
      text,
      persisted,
      true,
      openedAt,
      orchestration
    );
    const indexed = this.store.listThreads(activeBackendId).find((entry) => entry.threadId === threadId);
    // An orchestration instruction is not a title the user wrote.
    const title = historyThreadTitle(indexed?.title, orchestration ? undefined : text);
    await this.store.setActiveThread({
      backendId: activeBackendId,
      threadId,
      modelId: resolvedModel,
      mode,
      title,
      updatedAt: Date.now()
    });
    if (!orchestration && this.session && (this.session.blank || this.session.title === DEFAULT_TAB_TITLE)) {
      const label = tabTitle(text);
      if (label !== DEFAULT_TAB_TITLE) {
        this.session.title = label;
      }
      this.session.blank = false;
      this.publishTabs();
    }
    if (this.session) {
      this.session.composerBackendId = activeBackendId;
      if (resolvedModel) {
        this.session.composerModelId = resolvedModel;
      }
      this.persistOpenTabs();
    }
    await this.store.setLastUsedModel({ backendId: activeBackendId, modelId: resolvedModel ?? '' });
    this.post({ type: 'busy', value: true, backendId: activeBackendId, threadId });
    // Bind the next turn boundary to this user message, so the turn's pre-state
    // snapshot becomes this message's checkpoint. `turn/started` consumes it;
    // a send that never starts a turn must not strand it on a later turn.
    this.pendingTurnMessage = { messageId, backendId: activeBackendId, threadId };
    await this.captureSentMessage(activeBackendId, threadId, messageId);
    // A queued turn (or a queue:true send that raced the turn end) was never
    // drawn by the webview. An orchestration continuation was never typed at
    // all. Post the stored row now so the transcript shows it before the first
    // reply streams; this row is also the anchor the turn's change card needs,
    // so omitting it would leave the turn's file changes unplaced. The stored id
    // makes the next replay replace this row instead of adding a duplicate.
    if ((announceUserMessage || orchestration) && this.visible === this.session) {
      await this.postDispatchedUserMessage(
        activeBackendId,
        threadId,
        messageId,
        text,
        persisted,
        openedAt,
        orchestration
      );
    }
    if (this.session) {
      this.session.turnOpen = true;
    }
    // A new user turn supersedes any check run still finishing for this thread.
    void this.checkHost.cancelThread(activeBackendId, threadId).catch(() => undefined);
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
        this.session.turnPlan = undefined;
      }
      if (this.session && shouldAutoContinue(error, this.session.stopContinueAttempts)) {
        this.session.stopContinueAttempts += 1;
        this.crashContinueQueue.set(this.session.id, {
          session: this.session,
          text: continueAfterStopInstruction()
        });
        this.post({
          type: 'notice',
          level: 'info',
          message: isQuietTurnError(error)
            ? quietContinueNotice(this.session.stopContinueAttempts)
            : stopContinueNotice(this.session.stopContinueAttempts)
        });
      } else if (error instanceof BackendError && error.code === 'unauthenticated') {
        this.post({ type: 'notice', level: 'warning', message: error.message, action: 'setToken' });
      } else if (!isCancellation(error)) {
        this.post({ type: 'notice', level: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      await this.store.flush();
      this.post({ type: 'busy', value: false, backendId: activeBackendId, threadId });
    }
    return true;
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
    // Stop also drops this chat's queued user turns: after an interrupt an
    // immediate queued send would look like the Stop did nothing.
    const session = this.session;
    const queued = session ? this.discardSessionQueue(session.id) : 0;
    if (session && queued > 0) {
      this.restoredQueueSessions.delete(session.id);
      this.persistQueuedTurns();
      this.postQueuedTurns(session);
      this.post({
        type: 'notice',
        level: 'info',
        message:
          queued === 1
            ? 'Stopped. The 1 queued message was discarded.'
            : `Stopped. ${queued} queued messages were discarded.`
      });
    }
    if (!this.activeThread) {
      return;
    }
    if (
      this.pendingQuestion?.source === 'native' &&
      this.pendingQuestion.request.threadId === this.activeThread.threadId
    ) {
      this.clearPendingQuestion(this.activeThread.backendId, this.activeThread.threadId, true);
    }
    this.registry.cancel(this.activeThread.backendId, this.activeThread.threadId);
  }

  /**
   * The context payload for the active thread's next turn: the queued snapshot
   * on the first turn, otherwise a compact delta. Never throws, so a failed
   * snapshot degrades to a notice instead of blocking the turn.
   */
  private async turnContext(
    backendId: string,
    threadId: string,
    requestText = ''
  ): Promise<import('./backends/types').ContextPayload> {
    const key = ContextDelivery.key(backendId, threadId);
    try {
      return await this.contextDelivery.forTurn(key, {}, requestText);
    } catch {
      return {
        notice: 'Project context is not available right now. Continue without it; do not block the turn.'
      };
    }
  }

  /**
   * Title-bar refresh: drop the cached workspace picture and re-arm priming so
   * the next turn sends a fresh snapshot. Also refreshes backend availability.
   */
  refreshProjectContext(): Promise<void> {
    return this.refreshContext();
  }

  /**
   * Title-bar gear. Opens the inline settings screen in the sidebar. If the
   * webview script is not listening yet, the open is sent once it reports ready.
   */
  async openInlineSettings(): Promise<void> {
    if (!this.view) {
      this.openSettingsOnReady = true;
      await vscode.commands.executeCommand(`${SidebarViewProvider.viewType}.focus`);
    } else {
      this.view.show(false);
    }
    if (!this.webviewMounted) {
      this.openSettingsOnReady = true;
      return;
    }
    this.openSettingsOnReady = false;
    this.post({ type: 'showSettings' });
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
    // Kick off execution as the next turn, now that the mode is `agent`. This is
    // a host-built instruction, so it never appears as a message the user wrote.
    await this.sendTurn(
      buildTurnInstruction(state.steps),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'instruction'
    );
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
   * Write or revise the active thread's plan file. The file name is the plan
   * title. A chat that already has a plan updates that file. Creating the file
   * is the one permitted write in Plan mode.
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
    const previous = this.store.getPlanState(backendId, threadId);
    const artifact = await this.plans.write({
      threadId,
      title,
      summary,
      body,
      steps,
      path: previous?.path
    });
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
        steps: nextSteps,
        path: existing?.path
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
      path: canonicalPlanPath({
        threadId,
        title: existing?.title ?? 'Plan',
        existingPath: existing?.path
      }).path,
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
   * the reply supplies the body. The file name is the plan title, and a
   * revision updates that same file.
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
      steps,
      path: existing?.path
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
  private async considerPlanAutopilot(
    backendId: string,
    threadId: string,
    turnId: string
  ): Promise<void> {
    const session = this.session;
    if (!session || session.disposed || session.mode !== 'agent') {
      return;
    }
    const plan = this.turnPlans.get(turnId);
    const epoch = session.planEpoch;
    await runTurnEnd(
      {
        mode: session.mode,
        ...(plan ? { plan } : {}),
        settings: readOrchestrationSettings()
      },
      {
        // Settling is unconditional for an Agent turn: a step left running must
        // lose its spinner even when autopilot (or quick tasks) turned planning
        // off. Only the automatic continuation is gated.
        settle: () => this.flushBuiltPlanProgress(backendId, threadId),
        isStillCurrent: () =>
          this.session === session && !session.disposed && session.planEpoch === epoch,
        continue: () => this.continuePlanIfReady(session, backendId, threadId)
      }
    );
  }

  /** Queue the next automatic turn for a built plan this chat still owns. */
  private continuePlanIfReady(
    session: ChatSession,
    backendId: string,
    threadId: string
  ): void {
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
    this.flushQueuedTurns();
  }

  /**
   * Start queued continuations for every chat that is not already in a turn.
   * One chat's request does not hold the others.
   */
  private flushQueuedTurns(): void {
    if (this.queueFlushStopped) {
      // The lease is with the next window; this process must not send anything
      // from the queue it handed over.
      return;
    }
    // One pure pass decides order: user turns first, then continue, then
    // autopilot, with at most one action per chat. Starting an action sets
    // turnBusy synchronously, so a rapid second completion cannot dispatch the
    // same chat again from an older snapshot.
    const actions = planQueueDrain({
      queues: this.userTurnQueues,
      gates: this.sessions.map((session) => ({
        id: session.id,
        // A restored queue stays parked until its own chat is shown; another
        // chat's completion must not start a turn in a background tab.
        turnBusy: session.turnBusy || (this.restoredQueueSessions.has(session.id) && this.visible !== session),
        turnOpen: session.turnOpen,
        pendingQuestion: session.pendingQuestion !== undefined,
        pendingApproval: session.pendingApproval !== undefined,
        disposed: session.disposed
      })),
      continuations: [...this.crashContinueQueue.keys()],
      autopilot: [...this.planAutopilotQueue.keys()],
      blocked: this.blockedQueuedTurns
    });
    for (const action of actions) {
      const session = this.sessions.find((candidate) => candidate.id === action.sessionId);
      if (!session) {
        this.discardSessionQueue(action.sessionId);
        this.crashContinueQueue.delete(action.sessionId);
        this.planAutopilotQueue.delete(action.sessionId);
        continue;
      }
      if (action.origin === 'user') {
        // Remove exactly the planned entry, not queue[0]: an earlier blocked
        // entry must stay in place while later messages keep flowing.
        const entry = takeQueuedTurn(this.userTurnQueues, action.sessionId, action.entry.id);
        if (!entry) {
          continue;
        }
        this.blockedQueuedTurns.delete(entry.id);
        session.turnBusy = true;
        if (entry.mode) {
          session.mode = entry.mode;
        }
        this.persistQueuedTurns();
        if (this.visible === session) {
          this.postQueuedTurns(session);
        }
        void this.sessionStore.run(session, async () => {
          // Keep the entry but skip it in later drains, so one bad message
          // cannot hold everything queued after it forever.
          const blockEntry = (message: string): void => {
            session.turnBusy = false;
            this.blockedQueuedTurns.add(entry.id);
            requeueTurnFront(this.userTurnQueues, entry);
            this.persistQueuedTurns();
            if (this.visible === session) {
              this.postQueuedTurns(session);
            }
            this.post({ type: 'notice', level: 'warning', message });
            this.flushQueuedTurns();
          };
          // A retained path can disappear between queueing and dispatch. Keep
          // the entry and report it rather than dropping accepted text.
          const missing = await this.missingQueuedAttachmentNames(entry.attachments);
          if (missing.length > 0) {
            blockEntry(
              missing.length === 1
                ? `The queued message was kept because ${missing[0]} is no longer available. Later queued messages will still send. Remove this message and attach the file again to retry it.`
                : `The queued message was kept because ${missing.length} attachments are no longer available. Later queued messages will still send. Remove this message and attach the files again to retry it.`
            );
            return;
          }
          const target = queuedTurnThreadTarget(entry, (backendId) => Boolean(this.registry.get(backendId)));
          if (target === 'invalid') {
            blockEntry(
              'The queued message could not be restored because its provider or thread is no longer available. Later queued messages will still send.'
            );
            return;
          }
          const targetNeedsResume = target && !sessionMatchesQueueTarget(session, target);
          if (targetNeedsResume) {
            if (this.visible !== session) {
              // Reopen a different thread only when its chat is on screen;
              // otherwise park it until the user shows that chat.
              session.turnBusy = false;
              this.restoredQueueSessions.add(session.id);
              requeueTurnFront(this.userTurnQueues, entry);
              this.persistQueuedTurns();
              if (this.visible === session) {
                this.postQueuedTurns(session);
              }
              return;
            }
            await this.resumeThread(target.backendId, target.threadId);
            if (!sessionMatchesQueueTarget(session, target)) {
              blockEntry(
                'The queued message could not reopen its original thread. Later queued messages will still send.'
              );
              return;
            }
          }
          if (target) {
            // The entry's own provider/model must win over a saved composer
            // choice, otherwise `backendForTurn` could send it to another one.
            session.composerBackendId = target.backendId;
            if (entry.model) {
              session.composerModelId = entry.model;
            }
          }
          try {
            await this.sendTurn(
              entry.text,
              entry.model,
              entry.permissionLevel,
              entry.modelSettings,
              entry.attachments,
              entry.backendId,
              entry.updatePlan,
              'user',
              false,
              true
            );
          } catch (error) {
            // The entry was removed before start, so a thrown dispatch must put
            // it back at the front instead of losing it silently.
            session.turnBusy = false;
            requeueTurnFront(this.userTurnQueues, entry);
            this.persistQueuedTurns();
            if (this.visible === session) {
              this.postQueuedTurns(session);
            }
            this.post({
              type: 'notice',
              level: 'error',
              message: `The queued message could not be sent and is still queued. ${
                error instanceof Error ? error.message : String(error)
              }`
            });
          }
        });
        continue;
      }
      const queue = action.origin === 'continue' ? this.crashContinueQueue : this.planAutopilotQueue;
      const next = queue.get(session.id);
      if (!next) {
        continue;
      }
      queue.delete(session.id);
      session.turnBusy = true;
      void this.sessionStore.run(session, () =>
        this.sendTurn(next.text, undefined, undefined, undefined, undefined, undefined, undefined, action.origin)
      );
    }
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
    this.todoProgressTargets.set(`${backendId}:${threadId}`, { backendId, threadId });
    if (this.todoProgressQueued) {
      return;
    }
    this.todoProgressQueued = true;
    void this.enqueuePlanSteps(async () => {
      try {
        while (this.todoProgressTargets.size > 0) {
          const batch = [...this.todoProgressTargets.values()];
          this.todoProgressTargets.clear();
          for (const target of batch) {
            const owner = this.sessionForThread(target.backendId, target.threadId);
            await this.sessionStore.run(owner, () => this.mergeTodoProgressFromReply(target.backendId, target.threadId));
          }
        }
      } finally {
        this.todoProgressQueued = false;
        const next = this.todoProgressTargets.values().next().value;
        if (next) {
          this.noteTodoProgress(next.backendId, next.threadId);
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
   * Open a plan file. A file moved into `.melink/plans/` by hand becomes the
   * open chat's plan, with the rendered preview and Build. A thread's own
   * plan file keeps the Markdown preview.
   */
  private async recoverOrPreviewPlan(uri: vscode.Uri): Promise<void> {
    const recovered = await this.recoverMovedPlan(uri, true);
    if (!recovered) {
      await this.showPlanMarkdownPreview(uri);
    }
  }

  /**
   * When the open chat has no plan, and `.melink/plans/` holds exactly one
   * file that is not already a chat's plan, attach that file. Checked once
   * per window so a later empty chat does not take it.
   */
  private async offerSingleLoosePlan(): Promise<void> {
    if (this.loosePlanScanDone || this.recoveringPlan) {
      return;
    }
    const thread = this.activeThread;
    if (!thread) {
      return;
    }
    const existing = this.store.getPlanState(thread.backendId, thread.threadId);
    if (existing && existing.steps.length > 0) {
      return;
    }
    this.loosePlanScanDone = true;
    const loose = await this.loosePlanFiles();
    if (loose.length !== 1) {
      return;
    }
    await this.recoverMovedPlan(loose[0], false);
  }

  /** Plan markdown under `.melink/plans/` that no chat already owns. */
  private async loosePlanFiles(): Promise<vscode.Uri[]> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return [];
    }
    const dir = vscode.Uri.joinPath(folder.uri, '.melink', 'plans');
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return [];
    }
    const owned = this.ownedPlanPaths();
    const files: vscode.Uri[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File) {
        continue;
      }
      const uri = vscode.Uri.joinPath(dir, name);
      const relative = this.workspaceRelative(uri);
      if (isLoosePlanFile(relative, owned)) {
        files.push(uri);
      }
    }
    return files;
  }

  /** Paths of plan files the host already tracks for a chat. */
  private ownedPlanPaths(): Set<string> {
    const paths = new Set<string>();
    const ids = this.registry.snapshot().map((entry) => entry.id);
    const backendIds = ids.length > 0 ? ids : ['ollama', 'codex'];
    for (const backendId of backendIds) {
      for (const thread of this.store.listThreads(backendId)) {
        const state = this.store.getPlanState(backendId, thread.threadId);
        paths.add((state?.path ?? planRelativePath(thread.threadId)).replace(/\\/g, '/'));
      }
    }
    for (const session of this.sessions) {
      const thread = session.activeThread;
      if (!thread) {
        continue;
      }
      const state = this.store.getPlanState(thread.backendId, thread.threadId);
      paths.add((state?.path ?? planRelativePath(thread.threadId)).replace(/\\/g, '/'));
    }
    return paths;
  }

  private workspaceRelative(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  }

  /**
   * Attach a hand-moved plan to the open chat and open the rendered preview.
   * Returns true when the file became that chat's plan. A chat that already
   * has a plan is left as it is.
   */
  private async recoverMovedPlan(uri: vscode.Uri, explicit: boolean): Promise<boolean> {
    if (this.recoveringPlan) {
      return false;
    }
    const relative = this.workspaceRelative(uri);
    if (!isLoosePlanFile(relative, this.ownedPlanPaths())) {
      return false;
    }
    const session = this.session ?? this.visible;
    const thread = session?.activeThread;
    if (!session || !thread) {
      if (explicit) {
        this.post({
          type: 'notice',
          level: 'info',
          message: 'Open a chat, then open this plan again, to recover it.'
        });
      }
      return false;
    }
    const existing = this.store.getPlanState(thread.backendId, thread.threadId);
    const threadPath = planRelativePath(thread.threadId);
    const existingPath = existing?.path?.replace(/\\/g, '/');
    // The thread-id file is the duplicate. Once the friendly plan exists, drop it.
    if (relative === threadPath && existingPath && existingPath !== threadPath) {
      await this.plans.remove(thread.threadId);
      return false;
    }
    // A friendly file that just appeared replaces a thread-id plan. A chat that
    // already tracks a different friendly plan stays.
    const legacyHostFile = !existingPath || existingPath === threadPath || existingPath === relative;
    if (existing && existing.steps.length > 0 && !legacyHostFile) {
      if (explicit) {
        this.post({
          type: 'notice',
          level: 'info',
          message: 'This chat already has a plan. Reject it, or open another chat, before recovering this file.'
        });
      }
      return false;
    }
    let markdown: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      markdown = new TextDecoder('utf8').decode(bytes);
    } catch {
      if (explicit) {
        this.post({ type: 'notice', level: 'warning', message: 'That plan file could not be read.' });
      }
      return false;
    }
    const name = relative.slice(relative.lastIndexOf('/') + 1);
    const draft = recoverPlanDraft(markdown, planTitleFromFileName(name));
    if (!draft || draft.steps.length === 0) {
      return false;
    }
    this.recoveringPlan = true;
    try {
      return await this.sessionStore.run(session, async () => {
        const artifact = await this.plans.write({
          threadId: thread.threadId,
          title: draft.title || 'Plan',
          summary: draft.summary,
          body: draft.body,
          steps: draft.steps,
          path: relative
        });
        const plan = {
          ...artifact,
          built: existing?.built ?? false,
          completedDismissed: existing?.completedDismissed
        };
        await this.store.setPlanState(thread.backendId, thread.threadId, {
          path: plan.path,
          title: plan.title,
          summary: plan.summary,
          body: plan.body,
          steps: plan.steps,
          built: plan.built,
          completedDismissed: plan.completedDismissed,
          updatedAt: plan.updatedAt
        });
        if (existingPath && existingPath !== plan.path) {
          await this.plans.remove(thread.threadId, existingPath === threadPath ? undefined : existingPath);
        }
        this.post({ type: 'plan', plan });
        this.publishPlanDocument(plan, true);
        this.post({
          type: 'notice',
          level: 'info',
          message: `Recovered "${plan.title}" into this chat. Build runs its steps.`
        });
        return true;
      });
    } finally {
      this.recoveringPlan = false;
    }
  }

  /**
   * Take checkbox statuses from the plan file when the agent edited that file
   * directly. Host writes land in the store first, so the echo of our own
   * write finds nothing to change.
   */
  private adoptExternalPlanFile(uri: vscode.Uri): void {
    const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
    const session = this.sessions.find((entry) => {
      const thread = entry.activeThread;
      if (!thread) {
        return false;
      }
      const state = this.store.getPlanState(thread.backendId, thread.threadId);
      const owned = (state?.path ?? planRelativePath(thread.threadId)).replace(/\\/g, '/');
      return owned === relative;
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
    const artifact = await this.plans.read(threadId, existing.path);
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
      steps,
      path: existing.path
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
      path: canonicalPlanPath({
        threadId,
        title: state?.title ?? 'Plan',
        existingPath: state?.path
      }).path,
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
  /**
   * The open question card when it belongs to this thread. A webview reload
   * repaints from memory; a full window reload restores a fence question from
   * `workspaceState`, while a native question can only be reported as lost.
   */
  private pendingQuestionPayload(backendId: string, threadId?: string): QuestionRequest | undefined {
    if (!threadId) {
      return undefined;
    }
    if (this.activeThread?.backendId !== backendId || this.activeThread.threadId !== threadId) {
      return undefined;
    }
    const pending = this.pendingQuestion;
    if (pending) {
      if (pending.request.backendId !== backendId || pending.request.threadId !== threadId) {
        return undefined;
      }
      return pending.request;
    }
    const decision = restorePendingQuestion(this.questions.get(backendId, threadId));
    if (!decision) {
      return undefined;
    }
    if (decision.kind === 'restore') {
      this.pendingQuestion = decision.pending;
      this.syncStrippedQuestionText(backendId, threadId, decision.pending.request);
      return decision.pending.request;
    }
    const key = pendingQuestionKey(backendId, threadId);
    void this.questions.clear(backendId, threadId);
    if (!this.reportedLostQuestions.has(key)) {
      this.reportedLostQuestions.add(key);
      if (this.session) {
        this.session.questionNotice = { level: 'warning', message: decision.message };
      } else {
        this.post({ type: 'notice', level: 'warning', message: decision.message });
      }
    }
    return undefined;
  }

  /** Post a question notice now when visible, or keep it for that tab's next paint. */
  private postQuestionNotice(backendId: string, threadId: string, notice: NoticeView): void {
    const owner = this.sessionForThread(backendId, threadId) ?? this.session;
    if (owner && owner !== this.visible) {
      owner.questionNotice = notice;
      return;
    }
    this.post({ type: 'notice', ...notice });
  }

  /** Make a restored fence card's reply match the text that was captured. */
  private syncStrippedQuestionText(backendId: string, threadId: string, request: QuestionRequest): void {
    if (!request.itemId || request.strippedText === undefined) {
      return;
    }
    const items = this.store.getTranscript(backendId, threadId);
    if (!items.some((item) => item.id === request.itemId && item.text !== request.strippedText)) {
      return;
    }
    this.store.setTranscript(
      backendId,
      threadId,
      items.map((item) => (item.id === request.itemId ? { ...item, text: request.strippedText } : item))
    );
  }

  /** Drop a pending card in memory and in storage. Optionally tell the webview. */
  private clearPendingQuestion(backendId: string, threadId: string, notify: boolean): void {
    const pending = this.pendingQuestion;
    if (pending && pending.request.backendId === backendId && pending.request.threadId === threadId) {
      this.pendingQuestion = undefined;
      if (notify) {
        this.post({ type: 'question/cleared' });
      }
    }
    void this.questions.clear(backendId, threadId);
  }

  /** Show a native question on the active thread and remember it for a reload. */
  private holdNativeQuestion(request: QuestionRequest): void {
    const pending: PendingQuestion = { source: 'native', request };
    this.pendingQuestion = pending;
    this.reportedLostQuestions.delete(pendingQuestionKey(request.backendId, request.threadId));
    void this.questions.set(request.backendId, request.threadId, pending);
    if (this.activeThread?.backendId === request.backendId && this.activeThread.threadId === request.threadId) {
      this.post({ type: 'question/asked', request });
    }
  }

  /**
   * If an assistant reply ended with one or more question payloads, remove all
   * of them from the stored transcript and open one card with every question.
   * A malformed payload is removed and reported instead. Ask mode never calls
   * this. An `item/completed` capture also survives a later interruption.
   */
  private captureFenceQuestions(backendId: string, threadId: string, itemId?: string): void {
    const items = this.store.getTranscript(backendId, threadId);
    const item = findFenceQuestionItem(items, itemId);
    if (!item || item.kind !== 'message' || item.role !== 'assistant') {
      return;
    }
    const original = item.text ?? '';
    if (!containsQuestionPayload(original)) {
      return;
    }
    const extracted = extractSidecodeQuestions(original);
    if (extracted.text !== original) {
      this.store.setTranscript(
        backendId,
        threadId,
        items.map((entry) => (entry.id === item.id ? { ...entry, text: extracted.text } : entry))
      );
    }
    if (extracted.invalid) {
      // A valid card from the same reply is already the actionable surface, so
      // its warning never offers a retry that would start a second turn.
      this.postQuestionNotice(backendId, threadId, invalidQuestionNotice((extracted.questions?.length ?? 0) === 0));
    }
    if (!extracted.questions || extracted.questions.length === 0 || this.pendingQuestion) {
      return;
    }
    const request: QuestionRequest = {
      id: `fence_${item.id}`,
      backendId,
      threadId,
      itemId: item.id,
      strippedText: extracted.text,
      questions: extracted.questions
    };
    const pending: PendingQuestion = { source: 'fence', request };
    this.pendingQuestion = pending;
    this.reportedLostQuestions.delete(pendingQuestionKey(backendId, threadId));
    void this.questions.set(backendId, threadId, pending);
    this.post({ type: 'question/asked', request });
  }

  /**
   * Ask mode never opens a card. Remove a question payload from the stored
   * reply and explain, without blocking, that Agent or Plan can ask.
   */
  private stripAskQuestionFence(backendId: string, threadId: string): void {
    const items = this.store.getTranscript(backendId, threadId);
    const item = findFenceQuestionItem(items);
    if (!item || item.kind !== 'message' || item.role !== 'assistant') {
      return;
    }
    const original = item.text ?? '';
    if (!containsQuestionPayload(original)) {
      return;
    }
    const stripped = hideQuestionFence(original);
    if (stripped !== original) {
      this.store.setTranscript(
        backendId,
        threadId,
        items.map((entry) => (entry.id === item.id ? { ...entry, text: stripped } : entry))
      );
    }
    void this.questions.clear(backendId, threadId);
    this.postQuestionNotice(backendId, threadId, askModeQuestionNotice());
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
    await this.questions.clear(pending.request.backendId, pending.request.threadId);
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
      await this.store.appendUserMessage(pending.request.backendId, pending.request.threadId, text, undefined, false);
      return;
    }
    await this.sendTurn(
      revisingPlan ? planUpdateFromAnswers(pending.request.questions, answers) : text,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      revisingPlan,
      revisingPlan ? 'instruction' : 'user'
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

  /**
   * Read image bytes for the webview preview. The stored attachment keeps only
   * its path, so this copy is what the bubble shows and is not written back.
   */
  private async previewReplay(items: TranscriptItem[]): Promise<TranscriptItem[]> {
    return Promise.all(
      items.map(async (item) => {
        if (!item.attachments?.some((attachment) => attachment.kind === 'image' && attachment.path && !attachment.dataUrl)) {
          return item;
        }
        const attachments = await Promise.all(item.attachments.map((attachment) => this.previewAttachment(attachment)));
        return { ...item, attachments };
      })
    );
  }

  /** A clipboard image has no path until its bytes are copied into workspace storage. */
  private async retainClipboardAttachments(attachments: readonly Attachment[] | undefined): Promise<Attachment[] | undefined> {
    if (!attachments || attachments.length === 0) {
      return undefined;
    }
    const root = this.context.storageUri;
    const saved: Attachment[] = [];
    for (const attachment of attachments) {
      if (!attachment.dataUrl || attachment.path || !root) {
        saved.push(attachment);
        continue;
      }
      const bytes = decodeDataUrl(attachment.dataUrl);
      if (!bytes || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        saved.push(attachment);
        continue;
      }
      try {
        const folder = vscode.Uri.joinPath(root, 'attachments');
        await vscode.workspace.fs.createDirectory(folder);
        const file = vscode.Uri.joinPath(folder, `${safeDraftFileName(attachment.id)}${extensionForAttachment(attachment)}`);
        await vscode.workspace.fs.writeFile(file, bytes);
        saved.push({ ...attachment, path: file.fsPath });
      } catch {
        saved.push(attachment);
      }
    }
    return saved;
  }

  private async previewAttachment(attachment: Attachment): Promise<Attachment> {
    if (attachment.kind !== 'image' || !attachment.path || attachment.dataUrl) {
      return attachment;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(attachment.path));
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        return attachment;
      }
      const mime = attachment.mimeType || 'image/png';
      return { ...attachment, dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` };
    } catch {
      return attachment;
    }
  }
}




