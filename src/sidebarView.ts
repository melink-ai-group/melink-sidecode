import * as vscode from 'vscode';
import * as path from 'node:path';
import { BackendRegistry } from './backends/registry';
import { OLLAMA_TOKEN_SECRET_KEY } from './backends/secrets';
import { SettingsService } from './settings';
import { PlanStore } from './planStore';
import { ThreadStore } from './backends/threadStore';
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
  type TodoStepStatus
} from './backends/types';
import { permissionDescriptor } from './backends/permissions';
import { modeDescriptor, supportedModes } from './backends/modes';
import { overridesFromResolved } from './backends/capabilities';
import { canCompactContext, contextUsagePercent } from './backends/contextUsage';
import {
  mergeCheckboxStatuses,
  planDocumentFromReply,
  planRelativePath,
  updateStepStatus,
  userAsksToRevisePlan
} from './backends/plan';
import { readDefaultMode, readDefaultPermissionLevel, readDefaultThinking } from './backends/defaults';
import { ContextDelivery } from './context/delivery';
import { inferRequestedMode, modeIsMoreRestrictive } from './backends/modeIntent';
import { anyCategoryEnabled } from './context/contextView';
import type { ChangeHunkView } from './changes/changeStore';
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
  WebviewToHostMessage
} from './protocol';

/**
 * Renders the chat sidebar. This class is UI-facing glue: it forwards the
 * registry's snapshot and normalized events to the React webview and turns
 * webview intents into registry calls. It holds no provider types.
 *
 * It also owns the reload lifecycle: on activation it restores the persisted
 * conversation (replaying prior turns) before enabling the input, and degrades
 * a missing thread to a fresh conversation with a quiet notice.
 */
export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'melinkAgent.chat';

  private view?: vscode.WebviewView;
  /** True once the webview script has posted `ready`. A missed post means the host document never finished loading. */
  private webviewMounted = false;
  private webviewMountTimers: ReturnType<typeof setTimeout>[] = [];
  private activeThread?: ThreadHandle;
  /** Guards against a second restore if `ready` is re-sent by the webview. */
  private restored = false;
  /**
   * The permission level the active conversation runs at. Seeded from the
   * stored default and only ever raised to `unrestricted` through an explicit
   * confirmation in the webview; the host stores the label it was told.
   */
  private permissionLevel: PermissionLevel = readDefaultPermissionLevel();
  /**
   * The mode the active conversation runs at. Seeded from the stored default,
   * then from the thread's persisted mode on resume. A change applies to the
   * next turn and is persisted with the thread index; it never mutates the
   * transcript.
   */
  private mode: DefaultMode = readDefaultMode();
  /**
   * The approval currently blocking the active thread, if any. Tracked here so a
   * webview reload can repaint exactly one pending prompt; cleared the moment a
   * decision or denial arrives, so a settled request is never resurrected.
   */
  private pendingApproval?: ApprovalRequest;
  /**
   * True once a native `turn/plan/updated` has arrived for the current turn. It
   * suppresses the reply-derived fallback so a native plan is never overwritten
   * by a looser parse of the same reply.
   */
  private nativePlanThisTurn = false;
  /**
   * True when the in-flight turn should replace the plan document: the user
   * used Ask for changes, or the composer text asked to revise the plan.
   * Read when the turn completes. A later Plan-mode reply leaves the file
   * alone when this is false and a plan already exists.
   */
  private revisePlanThisTurn = false;
  private readonly settings: SettingsService;
  private readonly plans = new PlanStore();
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
   * Per-message checkpoints over the journal's recorded snapshots. A restore
   * reverts files only and never touches the transcript; the store owns the
   * pre-restore capture that makes a restore itself undoable.
   */
  private readonly checkpointStore: VscodeCheckpointStore;
  /**
   * The native workbench diff integration: the `melink-changes:` content
   * provider and the diff/changes commands the review surface invokes. Owned
   * here so it is disposed with the view on deactivate and never leaks across a
   * reload. Read-only with respect to the workspace: it serves only the
   * journal's recorded pre-turn bytes.
   */
  private readonly nativeDiff: NativeDiffService;
  /**
   * The user message whose turn is currently open, so the turn's pre-state
   * snapshot is addressable as that message's checkpoint. Scoped to its thread
   * so a background thread's turn cannot consume an id meant for another.
   */
  private pendingTurnMessage?: { messageId: string; backendId: string; threadId: string };
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

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext,
    private readonly registry: BackendRegistry,
    private readonly projectContext: VscodeProjectContext
  ) {
    this.settings = new SettingsService(context, registry);
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
    context.subscriptions.push(this.nativeDiff);
    this.registry.onDidChangeAvailability((availability) => this.post({ type: 'snapshot', availability }));
    this.registry.onEvent((event) => {
      // `changes/reported` is internal turn bookkeeping, not transcript content:
      // it is folded into the journal here and never forwarded to the webview,
      // which only ever receives the final `changes/changed` snapshot.
      if (event.type === 'changes/reported') {
        this.changeTracker.reportChanges(event.changes, event.threadId);
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
      if (event.type === 'turn/completed' || event.type === 'turn/interrupted' || event.type === 'error') {
        // A finished, interrupted, or failed turn cannot still be blocked on a
        // decision.
        this.pendingApproval = undefined;
        // A turn that ends while a step is still `inProgress` never resolves
        // that step on its own: the provider's plan update only ever marks it
        // running. Settle it in the persisted plan so the todo list shows honest
        // partial progress instead of a spinner that never stops. A denied step
        // (set by the `approval/denied` branch below) is terminal and left alone.
        if (event.threadId) {
          void this.settlePlanProgress(event.backendId, event.threadId);
        }
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
        void this.denyPlanStep(event.backendId, event.threadId);
      }
      if (event.type === 'turn/started') {
        // A new turn starts; a native plan update for it has not arrived yet.
        this.nativePlanThisTurn = false;
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
        void this.recordNativePlan(event.backendId, event.threadId, event.steps, event.explanation);
      }
      if (event.type === 'turn/completed' && this.mode === 'plan' && event.threadId) {
        // Derive the plan document from the reply. Native step updates that
        // already arrived stay the todo list; the reply still supplies the body.
        // capturePlanFromReply reads and clears revisePlanThisTurn synchronously.
        void this.capturePlanFromReply(event.backendId, event.threadId, this.nativePlanThisTurn);
      } else if (event.type === 'turn/completed') {
        this.revisePlanThisTurn = false;
      }
      if (event.type === 'turn/completed' && this.mode === 'agent' && event.threadId) {
        // Direct providers have no native todo stream. Checkbox lines in the
        // reply update the persisted list without rewriting the plan body.
        void this.mergeTodoProgressFromReply(event.backendId, event.threadId);
      }
    });
  }

  private get store(): ThreadStore {
    return this.registry.threads;
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
    // Only the active conversation's own turn is pushed: a background thread's
    // change set must not replace what the visible surface is showing.
    if (this.activeThread?.backendId !== set.backendId || this.activeThread?.threadId !== set.threadId) {
      return;
    }
    this.post({
      type: 'changes/changed',
      backendId: set.backendId,
      threadId: set.threadId,
      turnId: set.turnId,
      entries: set.entries
    });
    // A turn that just touched files makes its opening message a checkpoint, so
    // the per-message entry point offers it without waiting for a reload.
    await this.postCheckpoints(set.backendId, set.threadId);
  }

  /**
   * Push the active thread's most recent recorded change set, so a webview
   * reload repaints the change surface. Nothing is pushed when the latest turn
   * observed nothing, so a reload cannot manufacture a verified empty set.
   */
  private postLatestChanges(): void {
    const thread = this.activeThread;
    if (!thread) {
      return;
    }
    const set = this.changeTracker.latestFor(thread.threadId);
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
    const review = await this.changeStore.view(backendId, threadId, turnId);
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
    const review = await this.changeStore.view(backendId, threadId, turnId);
    const file = review?.files.find((entry) => entry.path === path);
    if (!file) {
      return;
    }
    const capped = capReviewLines(file.hunks, 120);
    this.post({ type: 'changes/hunks', turnId, path, hunks: capped.hunks, truncated: capped.truncated });
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
   * Push the per-message checkpoints a thread offers. A message whose turn
   * touched nothing is absent, so the entry point never offers an empty
   * checkpoint.
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
   * Restore a checkpoint, reverting the affected files to their checkpoint
   * content. The transcript and message list are never modified: only files are
   * written. A restore always captures the pre-restore content first, so it is
   * itself undoable; if that capture fails, no file is changed. A conflicting
   * file is reported and left alone unless the caller explicitly opted in.
   */
  private async restoreCheckpoint(message: {
    backendId: string;
    threadId: string;
    messageId?: string;
    restorePointId?: string;
    conflictResolution?: import('./changes/checkpoint').CheckpointConflictResolution;
  }): Promise<void> {
    const result = await this.checkpointStore.restore({
      backendId: message.backendId,
      threadId: message.threadId,
      ...(message.messageId !== undefined ? { messageId: message.messageId } : {}),
      ...(message.restorePointId !== undefined ? { restorePointId: message.restorePointId } : {}),
      ...(message.conflictResolution !== undefined ? { conflictResolution: message.conflictResolution } : {})
    });
    this.post({ type: 'changes/restoreResult', result });
    // A restore supersedes the recorded content for the affected turns; repaint
    // the checkpoint list so a restored-to point is offered for undo. Every
    // restore is itself undoable, which the result carries as `undoPointId`.
    await this.postCheckpoints(message.backendId, message.threadId);
    this.post({
      type: 'notice',
      level: result.ok ? 'info' : 'warning',
      message: result.message
    });
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
    // Listen before the document is written so a fast `ready` is not missed.
    const messages = view.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      if (message.type === 'ready') {
        this.webviewMounted = true;
        this.clearWebviewMountTimers();
      }
      void this.handle(message);
    });
    view.onDidDispose(() => {
      messages.dispose();
      this.clearWebviewMountTimers();
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

  private post(message: HostToWebviewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private async handle(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.post({ type: 'snapshot', availability: this.registry.snapshot() });
        await this.restore();
        // A reload repaints the change surface from the journal's recorded set
        // for the active thread (nothing when the latest turn observed nothing).
        this.postLatestChanges();
        // Repaint the per-message checkpoint list for the active thread, so the
        // per-message entry point offers the same messages after a reload.
        await this.postActiveCheckpoints();
        await this.postContextView();
        break;
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
      case 'getPermissions':
        await this.postPermissions(message.backendId);
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
   * Reconnects to the conversation persisted for this workspace. Runs once, and
   * always reports the restoring flag off so a failure cannot wedge the input.
   */
  private async restore(): Promise<void> {
    if (this.restored) {
      // The webview reloaded inside the same host session (e.g. it was
      // re-resolved): re-send the live conversation instead of restoring again.
      if (this.activeThread) {
        const { backendId, threadId, model } = this.activeThread;
        const ref = this.store.getActiveThread();
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
          plan: this.store.getPlanState(backendId, threadId) ? this.planArtifact(backendId, threadId) : undefined
        });
      }
      this.post({ type: 'restoring', value: false });
      return;
    }
    this.restored = true;
    this.post({ type: 'restoring', value: true });
    try {
      const ref = this.store.getActiveThread();
      if (!ref) {
        this.postFreshConversation();
        return;
      }
      const backend = this.registry.get(ref.backendId);
      if (!backend) {
        await this.store.clearActiveThread();
        this.postFreshConversation();
        return;
      }
      try {
        // Re-prime on resume: the upstream context may be gone after the replay,
        // so the snapshot is sent again rather than assumed to have survived.
        const prime = await this.contextDelivery.snapshot();
        const result = await backend.resumeThread(ref.threadId, { context: prime.payload });
        this.activeThread = result.handle;
        this.contextDelivery.begin(
          ContextDelivery.key(ref.backendId, ref.threadId),
          prime,
          Boolean(result.handle.contextPrimed)
        );
        const model = ref.modelId ?? result.model;
        // Restore the thread's mode so a resumed thread keeps the mode it ran in.
        this.mode = this.resolveMode(ref.backendId, ref.mode ?? this.mode);
        await this.store.setActiveThread({
          backendId: ref.backendId,
          threadId: ref.threadId,
          modelId: model,
          mode: this.mode,
          title: ref.title,
          updatedAt: Date.now()
        });
        this.post({
          type: 'conversation',
          backendId: ref.backendId,
          threadId: ref.threadId,
          model,
          permissionLevel: this.permissionLevel,
          mode: this.mode,
          replay: this.store.mergeApprovalMarkers(ref.backendId, ref.threadId, result.items),
          pendingApproval: this.pendingApproval,
          plan: this.store.getPlanState(ref.backendId, ref.threadId)
            ? this.planArtifact(ref.backendId, ref.threadId)
            : undefined
        });
      } catch (error) {
        await this.degradeToFresh(ref.backendId, error);
      }
    } finally {
      this.post({ type: 'restoring', value: false });
    }
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

  /**
   * A stale or unreadable thread must never block activation: keep the backend
   * selected, start empty, and explain quietly.
   */
  private async degradeToFresh(backendId: string, error: unknown): Promise<void> {
    await this.store.clearActiveThread();
    this.activeThread = undefined;
    if (error instanceof BackendError && error.code === 'provider') {
      this.post({
        type: 'notice',
        level: 'info',
        message: 'The previous conversation could not be restored, so a new one was started.'
      });
    } else if (!(error instanceof BackendError && error.code === 'unauthenticated')) {
      this.post({
        type: 'notice',
        level: 'info',
        message: 'The previous conversation is not available right now.'
      });
    }
    this.post({
      type: 'conversation',
      backendId,
      model: this.store.getLastUsedModel()?.modelId || undefined
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
    keepPendingUserMessage = false
  ): Promise<void> {
    const backend = this.registry.get(backendId);
    if (!backend) {
      this.post({ type: 'notice', level: 'error', message: `Backend ${backendId} is not registered.` });
      return;
    }
    // Re-read the stored defaults at start, so a default saved in the settings
    // screen applies to the next conversation without a reload; an explicit
    // value from the caller still wins. The mode is resolved against what the
    // backend can honour, so a mode it cannot enforce degrades to `agent`.
    const level = this.resolvePermission(backendId, permissionLevel ?? readDefaultPermissionLevel());
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
        context: prime.payload
      });
      this.activeThread = handle;
      this.contextDelivery.begin(ContextDelivery.key(backendId, handle.threadId), prime, Boolean(handle.contextPrimed));
      this.permissionLevel = level;
      this.mode = mode;
      await this.store.setActiveThread({
        backendId,
        threadId: handle.threadId,
        modelId: model ?? handle.model,
        mode,
        updatedAt: Date.now()
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
  private resolvePermission(backendId: string, requested?: PermissionLevel): PermissionLevel {
    const supported = this.registry.permissionLevels(backendId);
    if (requested && supported.includes(requested)) {
      return requested;
    }
    return supported.includes('default') ? 'default' : supported[0] ?? 'default';
  }

  /** Reconnects to a listed thread and replays its stored turns. */
  private async resumeThread(backendId: string, threadId: string): Promise<void> {
    const backend = this.registry.get(backendId);
    if (!backend) {
      return;
    }
    this.post({ type: 'restoring', value: true });
    try {
      // A resumed thread is re-primed with a fresh snapshot, because the upstream
      // context may be gone after the replay.
      const prime = await this.contextDelivery.snapshot();
      const result = await backend.resumeThread(threadId, { context: prime.payload });
      this.activeThread = result.handle;
      this.contextDelivery.begin(
        ContextDelivery.key(backendId, threadId),
        prime,
        Boolean(result.handle.contextPrimed)
      );
      // The thread index carries the mode, so a resumed thread keeps its mode;
      // a mode the backend cannot serve degrades to `agent`.
      const ref = this.store.listThreads(backendId).find((entry) => entry.threadId === threadId);
      this.mode = this.resolveMode(backendId, ref?.mode ?? this.mode);
      await this.store.setActiveThread({
        backendId,
        threadId,
        modelId: result.model,
        mode: this.mode,
        updatedAt: Date.now()
      });
      this.post({
        type: 'conversation',
        backendId,
        threadId,
        model: result.model,
        permissionLevel: this.permissionLevel,
        mode: this.mode,
        replay: this.store.mergeApprovalMarkers(backendId, threadId, result.items),
        pendingApproval: this.pendingApproval,
        plan: this.store.getPlanState(backendId, threadId)
          ? this.planArtifact(backendId, threadId)
          : undefined
      });
      // Repaint the resumed thread's own recorded change set, so the change
      // surface matches the thread now in view rather than carrying the previous
      // conversation's files.
      this.postLatestChanges();
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
      this.post({ type: 'notice', level: 'info', message: 'A request is already in progress. Wait for it to finish before sending another.' });
      return;
    }
    this.turnInProgress = true;
    try {
      await this.sendTurnCore(text, model, permissionLevel, requestedSettings, attachments, backendId, updatePlan);
    } finally {
      this.turnInProgress = false;
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
      await backend.steerTurn(active, value, messageId);
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
    // A model pick only updates the webview. Open a thread on the selected
    // backend before the turn, and tell the webview which thread the events
    // belong to, so a reply is not dropped for a backend mismatch.
    if (this.activeThread?.backendId !== candidateBackend) {
      await this.startThread(candidateBackend, model, permissionLevel, this.mode, true, requestedSettings, true);
    }
    if (!this.activeThread || this.activeThread.backendId !== candidateBackend) {
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
    this.permissionLevel = level;
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
    const messageId = await this.store.appendUserMessage(activeBackendId, threadId, text, persisted);
    await this.store.setActiveThread({
      backendId: activeBackendId,
      threadId,
      modelId: resolvedModel,
      mode,
      title: this.store.getActiveThread()?.title ?? ThreadStore.titleFromText(text),
      updatedAt: Date.now()
    });
    await this.store.setLastUsedModel({ backendId: activeBackendId, modelId: resolvedModel ?? '' });
    this.post({ type: 'busy', value: true, backendId: activeBackendId, threadId });
    // Bind the next turn boundary to this user message, so the turn's pre-state
    // snapshot becomes this message's checkpoint. `turn/started` consumes it;
    // a send that never starts a turn must not strand it on a later turn.
    this.pendingTurnMessage = { messageId, backendId: activeBackendId, threadId };
    try {
      await backend.sendTurn(
        { backendId: activeBackendId, threadId, model: resolvedModel },
        { text, model: resolvedModel, permissionLevel: level, mode, modelSettings, context, attachments }
      );
    } catch (error) {
      this.pendingTurnMessage = undefined;
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
   * Builds an attachment descriptor from a picked file. Only the basename, the
   * type and the size cross the protocol; file contents are never read here.
   * An oversized or unreadable file returns `undefined` so the pick can report
   * it as one skipped item.
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
    return {
      id: createAttachmentId(),
      name,
      path: uri.fsPath,
      mimeType,
      size: stat.size,
      kind: kindForMime(mimeType)
    };
  }

  /** Aborts the in-flight turn; the adapter emits the interrupted state. */
  private cancelTurn(): void {
    if (!this.activeThread) {
      return;
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
      includeViewedFile: this.contextDelivery.includeViewedFileEnabled()
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
   * Open the active thread's plan file in the editor. The stored path is
   * workspace-relative, so it is resolved against the open folder here rather
   * than trusted as an absolute path.
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
    const folder = vscode.workspace.workspaceFolders?.[0];
    const uri = folder
      ? vscode.Uri.joinPath(folder.uri, state.path)
      : vscode.Uri.file(state.path);
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: true });
    } catch {
      this.post({
        type: 'notice',
        level: 'warning',
        message: 'The plan file could not be opened. It may have been moved or deleted.'
      });
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
    this.post({ type: 'plan', plan: this.planArtifact(backendId, threadId) });
    this.post({ type: 'modes', modes: this.modeSnapshot(backendId) });
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
    await this.store.setPlanState(backendId, threadId, { ...state, built: false, updatedAt: Date.now() });
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
    const plan = { ...artifact, built: previous?.built ?? false };
    await this.store.setPlanState(backendId, threadId, {
      path: plan.path,
      title: plan.title,
      summary: plan.summary,
      body: plan.body,
      steps: plan.steps,
      built: plan.built,
      updatedAt: plan.updatedAt
    });
    this.post({ type: 'plan', plan });
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
        steps
      });
      const built = existing?.built ?? this.mode !== 'plan';
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
        updatedAt: artifact.updatedAt
      });
      this.post({
        type: 'plan',
        plan: { ...artifact, body: existing?.body ? artifact.body : undefined, built }
      });
      return;
    }
    await this.store.setPlanState(backendId, threadId, {
      path: existing?.path ?? planRelativePath(threadId),
      title: existing?.title ?? 'Plan',
      summary: existing?.summary,
      body: existing?.body,
      steps,
      built: existing?.built ?? false,
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
    const draft = planDocumentFromReply(reply);
    const steps = nativeSteps && existing && existing.steps.length > 0 ? existing.steps : draft.steps;
    if (steps.length === 0) {
      return;
    }
    const title = draft.title || existing?.title || this.store.getActiveThread()?.title || 'Plan';
    const artifact = await this.plans.write({
      threadId,
      title,
      summary: draft.summary ?? existing?.summary,
      body: draft.body ?? existing?.body,
      steps
    });
    const plan = { ...artifact, built: existing?.built ?? false };
    await this.store.setPlanState(backendId, threadId, {
      path: plan.path,
      title: plan.title,
      summary: plan.summary,
      body: plan.body,
      steps: plan.steps,
      built: plan.built,
      updatedAt: plan.updatedAt
    });
    this.post({ type: 'plan', plan });
  }

  /**
   * Fold checkbox lines from the latest assistant reply into a built plan.
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
    const lastReply = [...this.store.getTranscript(backendId, threadId)]
      .reverse()
      .find((item) => item.kind === 'message' && item.role === 'assistant');
    const steps = mergeCheckboxStatuses(existing.steps, lastReply?.text ?? '');
    if (!steps.some((step, index) => step.status !== existing.steps[index].status)) {
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
    const plan = {
      ...artifact,
      body: existing.body ? artifact.body : undefined,
      summary: existing.body ? artifact.summary : existing.summary,
      built: existing.built
    };
    await this.store.setPlanState(backendId, threadId, {
      path: plan.path,
      title: plan.title,
      summary: plan.summary,
      body: plan.body,
      steps: plan.steps,
      built: plan.built,
      updatedAt: plan.updatedAt
    });
    if (this.activeThread?.backendId === backendId && this.activeThread?.threadId === threadId) {
      this.post({ type: 'plan', plan });
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
      updatedAt: state?.updatedAt ?? Date.now()
    };
  }

  /**
   * Forwards a decision to the owning backend. This is the only path that
   * answers a pending request, and it is driven strictly by an explicit user
   * action in the webview: there is no timer, no retry, and no reconnect path
   * that calls it. A rejected request is therefore never retried by us.
   */
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
    'Build the approved plan. Execute each step in order. As you work, report progress with checkbox lines that repeat the step text exactly: "- [~] ..." while a step is in progress and "- [x] ..." when it is done. Leave the plan document prose unchanged.',
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

/** Strip inline bytes before an attachment is persisted to workspace state. */
function persistableAttachments(attachments?: Attachment[]): Attachment[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }
  return attachments.map(({ dataUrl: _dataUrl, ...rest }) => rest);
}
