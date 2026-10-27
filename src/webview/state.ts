import { MODE_DESCRIPTORS } from '../backends/modes.ts';
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  BackendAvailability,
  BackendModel,
  ChangeEntry,
  DefaultMode,
  FileChange,
  ModelSettingOverrides,
  PermissionLevel,
  ThreadSummary,
  TranscriptItem,
  TranscriptItemKind
} from '../backends/types';
import { cleanToolTarget, isStatusText } from '../backends/toolLabel.ts';
import { messageSentAt, stampTurnWorked } from '../backends/turnTiming.ts';
import { tokensFromText } from '../backends/contextUsage.ts';
import { carriedPlanDismissal, shouldDismissCompletedPlan } from '../backends/plan.ts';
import { estimateConversationTokens } from './modelControls.ts';
import type {
  ConnectionTestResult,
  ContextView,
  ChangeView,
  ChangeHunkView,
  ChangeDecisionResult,
  CheckpointView,
  RestoreCheckpointResult,
  RestorePreview,
  ChatTabView,
  HostToWebviewMessage,
  ModeSnapshot,
  ModelCapabilitySnapshot,
  ModelSettingField,
  PermissionSnapshot,
  PlanArtifact,
  QueuedTurnEntryView,
  QuestionRequest,
  SettingsSection,
  SettingsSnapshot,
  WebviewToHostMessage
} from '../protocol';

/** Lifecycle of one transcript item, driving its status affordance. */
export type ItemStatus = 'streaming' | 'completed' | 'failed' | 'warning' | 'canceled' | 'pending';

export type NoticeAction =
  | 'setToken'
  | 'clearToken'
  | 'refresh'
  | 'retry'
  | 'retryQuestion'
  | 'preparePlanFollowUp'
  | 'prepareCheckFollowUp';

/** The files one chat turn changed, plus the review snapshot once the host sends it. */
export interface TurnChange {
  turnId: string;
  /** The user message that opened the turn, when the host recorded one. */
  messageId?: string;
  entries: ChangeEntry[];
  review?: ChangeView;
}

export interface TranscriptItemView {
  id: string;
  kind: TranscriptItemKind;
  /** Backend the item came from; drives the provider dot, never the renderer. */
  backendId?: string;
  role?: 'user' | 'assistant' | 'system';
  title?: string;
  /** Tool id (`read`, `grep`, `bash`) when the backend reported one. */
  tool?: string;
  detail?: string;
  /** `tool` items: the command or invocation that ran. */
  command?: string;
  /** `file-change` items: one entry per changed file. */
  files?: FileChange[];
  /** `approval-requested` items: the pending approval request, when known. */
  approval?: ApprovalRequest;
  /** `approval-decided`/`approval-denied` items: how a request was answered. */
  approvalDecision?: ApprovalDecision;
  /** Thread the item belongs to, so a decision can be routed back. */
  threadId?: string;
  /** `message` items: files the user attached to the turn. */
  attachments?: Attachment[];
  /** True for an injected orchestration continuation, not a user-typed message. */
  orchestration?: boolean;
  text: string;
  /** Epoch milliseconds when this user message was stored. */
  sentAt?: number;
  /** Milliseconds from that user message until the turn finished. */
  workedMs?: number;
  status: ItemStatus;
  /** Status-line notices: severity. Errors stay red; the line has no title. */
  noticeLevel?: 'info' | 'warning' | 'error';
  agentActivity?: TranscriptItem['agentActivity'];
  /** Status-line notices: recovery control, when the line offers one. */
  noticeAction?: NoticeAction;
}

export interface AppState {
  availability: BackendAvailability[];
  models: Record<string, BackendModel[]>;
  /** Per-backend `listModels()` failure, so the picker can offer a retry. */
  modelErrors: Record<string, string>;
  threads: Record<string, ThreadSummary[]>;
  /** Live activity and unread replies keyed by backend and thread identity. */
  threadActivity: Record<string, { busy: boolean; unread: boolean }>;
  threadLoading: Record<string, boolean>;
  /** Open sidebar chat tabs. The active one is the transcript on screen. */
  chatTabs: ChatTabView[];
  selectedBackendId?: string;
  selectedModel?: string;
  /** Permission level the active conversation runs at. */
  permissionLevel: PermissionLevel;
  /**
   * Host selection generation last applied. A permissions snapshot with a
   * lower epoch cannot replace the level.
   */
  permissionEpoch: number;
  /** Mode the active conversation runs at; applies to the next turn. */
  mode: DefaultMode;
  /** The permission read model for the selected backend. */
  permissions?: PermissionSnapshot;
  /** The mode read model for the selected backend. */
  modeOptions?: ModeSnapshot;
  /** The active thread's plan, present once one exists. */
  plan?: PlanArtifact;
  /**
   * True from the moment a revision is requested until the host answers with a
   * fresh plan (or the turn resolves). Drives the card's in-flight treatment; it
   * is derived from the user's own request, never inferred from the transcript.
   */
  planRevising: boolean;
  /** True while the destructive reject confirmation is shown on the plan card. */
  rejectConfirmationOpen: boolean;
  /** Host-side conversation id, present once a thread exists. */
  activeThreadId?: string;
  transcript: TranscriptItemView[];
  /** True when the host can prepend rows older than `transcript`. */
  hasOlderHistory: boolean;
  /** True while an older page is being read. */
  loadingOlder: boolean;
  /**
   * Tokens currently occupying the context window. Provider counts replace this;
   * streamed text adds to it between those counts so the ring moves while a
   * turn is running.
   */
  contextUsedTokens?: number;
  /** Window the live provider reported, used when the model setting is unknown. */
  contextWindowTokens?: number;
  busy: boolean;
  /** True while a turn is in flight and no assistant item has started yet. */
  startingTurn: boolean;
  /** True while the host restores a conversation; gates the input. */
  restoring: boolean;
  /**
   * The approval awaiting a decision, if any. While set, the composer stays
   * locked: the turn is blocked at the backend until a decision arrives, and
   * nothing may auto-decide it.
   */
  pendingApproval?: { backendId: string; threadId: string; request: ApprovalRequest };
  /**
   * The clarifying question card above the composer. While set, the composer
   * stays locked so a free-text send cannot race the choice.
   */
  pendingQuestion?: QuestionRequest;
  /** True while the labelled confirmation for an unrestricted level is shown. */
  permissionConfirmationOpen: boolean;
  /** True while the always-allow rules surface is open for review/revocation. */
  rulesOpen: boolean;
  /**
   * Files attached to the pending message. Cleared when the message is sent.
   * A chat switch restores that tab's own chips. Each chip is removable before
   * the turn leaves the composer.
   */
  attachments: Attachment[];
  /**
   * An inline composer message for a failed or refused attach/paste. Never a
   * file path or content; dismissed when the user acts or removes a chip.
   */
  attachmentError?: string;
  /**
   * User turns the host has accepted for later, for the visible chat only.
   * Oldest first; replaced by every `queuedTurns` echo and cleared on a chat
   * switch or clear. No paths or bytes, so a chip is safe to render.
   */
  queuedTurns: QueuedTurnEntryView[];
  notice?: { level: 'info' | 'warning' | 'error'; message: string; action?: NoticeAction };
  /** True while the settings screen is open (inline surface, never a popover). */
  settingsOpen: boolean;
  /** Provider page to select when settings opens from a failure action. */
  settingsProvider?: SettingsSection;
  /** Result of Validate version, or a pending marker while the checks run. */
  codexVersionCheck?: { pending: boolean; ok?: boolean; message?: string };
  /** The settings read model, present once the host has answered `getSettings`. */
  settings?: SettingsSnapshot;
  /**
   * Busy/result state of the latest settings save. `pending` starts on the
   * click and ends only when the host settles it (or the webview watchdog
   * fires), so a slow save is visible and a second click is refused.
   */
  settingsSave?: { pending: boolean; ok?: boolean; message?: string };
  /**
   * The capability descriptor + effective settings for the selected model, as
   * resolved and clamped by the host. Data only: no surface renders it yet.
   */
  modelCapability?: ModelCapabilitySnapshot;
  /**
   * Lifecycle of the selected model's capability read. `loading` covers the
   * moment a model is chosen until the host answers; `error` covers a read that
   * could not complete, so the panel explains rather than showing stale values.
   */
  modelCapabilityStatus: 'idle' | 'loading' | 'ready' | 'error';
  /** Plain-language reason the capability read failed, for the panel's notice. */
  modelCapabilityError?: string;
  /** Result of the last Test connection, or a pending marker while it runs. */
  connectionTest?: {
    backendId: string;
    pending: boolean;
    result?: ConnectionTestResult;
  };
  /** Result of the last opencode upgrade, or a pending marker while it runs. */
  opencodeUpgrade?: { pending: boolean; ok?: boolean; message?: string };
  /** Result of the last opencode install, or a pending marker while it downloads. */
  opencodeInstall?: { pending: boolean; ok?: boolean; message?: string; path?: string };
  /** Result of the last zvec-grep toggle, or a pending marker while it runs. */
  zvecGrep?: {
    pending: boolean;
    requested?: boolean;
    ok?: boolean;
    message?: string;
    /** The field a refused path belongs to, when the host refused one. */
    field?: 'zvecGrepPath' | 'astGrepPath';
    fieldMessage?: string;
  };
  astGrep?: {
    pending: boolean;
    requested?: boolean;
    ok?: boolean;
    message?: string;
    /** The field a refused path belongs to, when the host refused one. */
    field?: 'zvecGrepPath' | 'astGrepPath';
    fieldMessage?: string;
  };
  astGrepInstall?: { pending: boolean; ok?: boolean; message?: string; path?: string };
  zvecGrepInstall?: { pending: boolean; ok?: boolean; message?: string; path?: string };
  /** Latest read-only Test / Build index result for one skill. */
  skillAction?: {
    skill: 'zvecGrep' | 'astGrep';
    action: 'test' | 'index';
    pending: boolean;
    ok?: boolean;
    message?: string;
  };
  /**
   * The project-context read model the composer renders. Built and pushed by the
   * host; the webview never recomputes it. `undefined` until the first push, so
   * the strip is simply absent rather than guessing a workspace.
   */
  contextView?: ContextView;
  /**
   * Open workspace folders, used only to pretty-print paths in the transcript.
   * Empty until the host sends a context snapshot.
   */
  workspaceRoots: readonly string[];
  /**
   * False when every context category is disabled in settings, so the strip can
   * say context is off rather than reading as a workspace with nothing in it.
   */
  contextSettingsEnabled: boolean;
  /** Local, next-turn-only exclusions the user set from the panel. */
  contextExclusions: string[];
  /** Whether the file open in the editor is sent with the next turn. Default off. */
  includeViewedFile: boolean;
  /**
   * One card per turn that changed files, oldest first. A later turn is added
   * beside earlier ones. An empty list means this thread has no verified file
   * changes on screen.
   */
  turnChanges: TurnChange[];
  /**
   * The most recent decision outcome, surfaced so a partial failure (a refused
   * write, a conflict) is reported rather than silently swallowed.
   */
  changeDecision?: { results: ChangeDecisionResult[]; message?: string };
  /**
   * The destructive reject awaiting an explicit confirmation. Rejecting writes
   * the pre-turn content back to disk, so the affected paths are shown before
   * the host is asked to act. `scope` distinguishes a whole-turn reject-all from
   * a single-file reject; both name their paths.
   */
  changeRejectConfirm?: { turnId: string; scope: 'file' | 'all'; paths: string[] };
  /**
   * True while a decision request is in flight, so the review surface disables
   * its controls rather than accepting a second, racing decision.
   */
  changeDeciding: boolean;
  /**
   * The per-message checkpoints for the active thread, newest first. Every
   * sent user message is included, even when its turn touched no files.
   */
  checkpoints?: CheckpointView[];
  /** The most recent restore outcome, so a partial restore is surfaced. */
  restoreResult?: RestoreCheckpointResult;
  /**
   * The restore awaiting an explicit confirmation. Carries this chat's messages
   * and, when other chats would lose work, those chats too.
   */
  restoreConfirmation?: RestorePreview;
  /**
   * A send that would move into a mode with more reach. The turn stays paused
   * until the user switches or stays.
   */
  modeSwitch?: { requestId: string; from: DefaultMode; to: DefaultMode };
}

export type Action =
  | { type: 'snapshot'; availability: BackendAvailability[] }
  | { type: 'models'; backendId: string; models: BackendModel[]; error?: string }
  | { type: 'clearModels'; backendId: string }
  | { type: 'threadsLoading'; backendId: string; value: boolean }
  | { type: 'threads'; backendId: string; threads: ThreadSummary[] }
  | { type: 'chatTabs'; tabs: ChatTabView[] }
  | { type: 'selectBackend'; backendId: string }
  | { type: 'selectModel'; model: string }
  | { type: 'agentEvent'; event: AgentEvent }
  | { type: 'localUserMessage'; text: string; attachments?: Attachment[]; opensTurn?: boolean }
  /**
   * A queued turn started in the host. The user typed it earlier, so the
   * composer is untouched; only the transcript gains the stored message.
   */
  | {
      type: 'userMessageSent';
      backendId: string;
      threadId: string;
      messageId: string;
      text: string;
      attachments?: Attachment[];
      sentAt?: number;
      orchestration?: boolean;
    }
  /** Replace the optimistic user bubble id with the host message id. */
  | { type: 'userMessageId'; backendId: string; threadId: string; messageId: string; sentAt?: number }
  /** Remove the optimistic user bubble when the host did not accept the send. */
  | { type: 'revertLocalSend'; text: string }
  | {
      type: 'conversation';
      backendId: string;
      threadId?: string;
      model?: string;
      permissionLevel?: PermissionLevel;
      mode?: DefaultMode;
      replay?: TranscriptItem[];
      /**
       * The approval still blocking the active thread, when one is open. A
       * reload repaints exactly this one prompt, so a blocked turn is never
       * shown as idle and a settled request is never resurrected.
       */
      pendingApproval?: ApprovalRequest;
      pendingQuestion?: QuestionRequest;
      /** A status line appended after the replay, e.g. a lost native question. */
      notice?: {
        level: 'info' | 'warning' | 'error';
        message: string;
        action?: NoticeAction;
      };
      plan?: PlanArtifact;
      /** Keep the optimistic user line when a send opens a new thread. */
      keepPendingUserMessage?: boolean;
      /** True when rows older than `replay` can still be loaded. */
      hasOlderHistory?: boolean;
    }
  | { type: 'olderHistoryLoading' }
  | {
      type: 'olderHistory';
      backendId: string;
      threadId?: string;
      items: TranscriptItem[];
      hasOlderHistory: boolean;
    }
  | { type: 'questionAsked'; request: QuestionRequest }
  | { type: 'questionCleared' }
  | { type: 'restoring'; value: boolean }
  | { type: 'busy'; value: boolean; backendId?: string; threadId?: string }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string; action?: NoticeAction }
  /**
   * Remove the status line a Retry or refresh click is answering. A recovery
   * action ends the failed turn, so it also clears the busy flag; action-only
   * notices pass `preserveBusy` to leave a running turn untouched.
   */
  | { type: 'dismissStatusNotice'; text: string; preserveBusy?: boolean }
  | { type: 'dismissNotice' }
  /** Add picked/pasted files to the pending message; duplicates are ignored. */
  | { type: 'addAttachments'; attachments: Attachment[] }
  /** Remove one chip before sending. */
  | { type: 'removeAttachment'; id: string }
  /** Replace the pending chips, for a tab switch or a restored draft. */
  | { type: 'setAttachments'; attachments: Attachment[] }
  /** Surface an attach/paste failure inline in the composer. */
  | { type: 'attachmentError'; message: string }
  | { type: 'dismissAttachmentError' }
  /** Replace the visible chat's queued turns with the host's view. */
  | { type: 'queuedTurns'; entries: QueuedTurnEntryView[] }
  /** Remove one queued turn immediately, before the host echoes the list. */
  | { type: 'cancelQueuedTurn'; id: string }
  | { type: 'refresh' }
  | { type: 'openSettings'; provider?: SettingsSection }
  | { type: 'closeSettings' }
  | { type: 'settings'; settings: SettingsSnapshot }
  /** Host busy/result for the settings save; pending gates the Save button. */
  | { type: 'settingsSave'; pending: boolean; ok?: boolean; message?: string }
  | { type: 'permissions'; permissions: PermissionSnapshot }
  | { type: 'modes'; modes: ModeSnapshot }
  | { type: 'modelCapability'; capability: ModelCapabilitySnapshot }
  /** A model was chosen and its capability read has not answered yet. */
  | { type: 'modelCapabilityLoading' }
  /** The capability read failed; the panel explains instead of showing stale values. */
  | { type: 'modelCapabilityError'; providerId: string; modelId: string; message: string }
  | { type: 'plan'; plan: PlanArtifact }
  /** The user asked to revise the plan; the card shows an in-flight state. */
  | { type: 'planRevising' }
  /** A fresh plan replaced the old one; the in-flight state clears. */
  | { type: 'planSettled' }
  | { type: 'requestRejectConfirmation' }
  | { type: 'cancelRejectConfirmation' }
  | { type: 'selectMode'; mode: DefaultMode }
  | { type: 'selectPermission'; level: PermissionLevel }
  | { type: 'requestPermissionConfirmation' }
  | { type: 'cancelPermissionConfirmation' }
  | { type: 'openRules' }
  | { type: 'closeRules' }
  | { type: 'connectionTestPending'; backendId: string }
  | { type: 'connectionTest'; result: ConnectionTestResult }
  | { type: 'codexVersionCheck'; pending: boolean; ok?: boolean; message?: string }
  | { type: 'opencodeUpgrade'; pending: boolean; ok?: boolean; message?: string }
  | { type: 'opencodeInstall'; pending: boolean; ok?: boolean; message?: string; path?: string }
  | {
      type: 'zvecGrep';
      pending: boolean;
      requested?: boolean;
      ok?: boolean;
      message?: string;
      field?: 'zvecGrepPath' | 'astGrepPath';
      fieldMessage?: string;
    }
  | {
      type: 'astGrep';
      pending: boolean;
      requested?: boolean;
      ok?: boolean;
      message?: string;
      field?: 'zvecGrepPath' | 'astGrepPath';
      fieldMessage?: string;
    }
  | { type: 'astGrepInstall'; pending: boolean; ok?: boolean; message?: string; path?: string }
  | { type: 'zvecGrepInstall'; pending: boolean; ok?: boolean; message?: string; path?: string }
  | {
      type: 'skillAction';
      skill: 'zvecGrep' | 'astGrep';
      action: 'test' | 'index';
      pending: boolean;
      ok?: boolean;
      message?: string;
    }
  /** The host's project-context read model, pushed on every relevant change. */
  | {
      type: 'context';
      view: ContextView;
      settingsEnabled: boolean;
      exclusions: string[];
      includeViewedFile: boolean;
      workspaceRoots?: string[];
    }
  /** Toggle one item or category off for the next turn (or back on). */
  | { type: 'toggleContextExclusion'; key: string }
  /** Restore the default context set for the next turn. */
  | { type: 'resetContextExclusions' }
  /** Include or remove the file open in the editor. */
  | { type: 'setIncludeViewedFile'; included: boolean }
  /** Persist a per-model override; the host clamps it and echoes the result. */
  | { type: 'setModelSettings'; providerId: string; modelId: string; settings: ModelSettingOverrides }
  /** Clear every override for one model and echo the re-resolved settings. */
  | { type: 'resetModelSettings'; providerId: string; modelId: string }
  /** Clear one field's override only, so exactly that control resets. */
  | { type: 'resetModelSettingField'; providerId: string; modelId: string; field: ModelSettingField }
  /**
   * The host's recorded change set for a turn. An empty `entries` array is a
   * verified no-op; the host never sends this message for a turn it could not
   * observe, so the state's `undefined` stays distinct from an empty set.
   */
  | {
      type: 'changesChanged';
      backendId: string;
      threadId: string;
      turnId: string;
      messageId?: string;
      entries: ChangeEntry[];
    }
  /** The host's post-hoc review snapshot for a turn. */
  | { type: 'changeReview'; review: ChangeView }
  | { type: 'changeHunks'; turnId: string; path: string; hunks: ChangeHunkView[]; truncated: boolean }
  /** The outcome of a decision request, so a partial failure is surfaced. */
  | { type: 'changeDecision'; results: ChangeDecisionResult[]; message?: string }
  /** The per-message checkpoints the host offers for the active thread. */
  | { type: 'checkpoints'; checkpoints: CheckpointView[] }
  /** The outcome of a checkpoint restore, so a partial restore is surfaced. */
  | { type: 'restoreResult'; result: RestoreCheckpointResult }
  /** Open the confirmation from a host preview. Nothing has been written yet. */
  | { type: 'restorePreview'; preview: RestorePreview }
  | { type: 'cancelRestoreConfirmation' }
  /** Open the mode-switch dialog. A later prompt replaces one still on screen. */
  | { type: 'modeSwitchPrompt'; requestId: string; from: DefaultMode; to: DefaultMode }
  | { type: 'clearModeSwitch' }
  /**
   * Open the destructive reject confirmation for one file or the whole turn.
   * Rejecting writes to disk, so the paths are named before anything is posted.
   */
  | { type: 'requestChangeRejectConfirmation'; turnId: string; scope: 'file' | 'all'; paths: string[] }
  | { type: 'cancelChangeRejectConfirmation' }
  /** A decision request is now in flight, so the review controls lock. */
  | { type: 'changeDeciding'; value: boolean };

export const initialState: AppState = {
  availability: [],
  models: {},
  modelErrors: {},
  threads: {},
  threadActivity: {},
  threadLoading: {},
  chatTabs: [],
  permissionLevel: 'default',
  permissionEpoch: 0,
  mode: 'agent',
  transcript: [],
  hasOlderHistory: false,
  loadingOlder: false,
  busy: false,
  startingTurn: false,
  restoring: true,
  settingsOpen: false,
  permissionConfirmationOpen: false,
  rulesOpen: false,
  planRevising: false,
  rejectConfirmationOpen: false,
  attachments: [],
  queuedTurns: [],
  modelCapabilityStatus: 'idle',
  contextSettingsEnabled: true,
  workspaceRoots: [],
  contextExclusions: [],
  includeViewedFile: false,
  turnChanges: [],
  changeDeciding: false
};

/**
 * The mode list the composer shows for the selected backend.
 *
 * The host snapshot is used when it belongs to that backend and lists more
 * than Agent. Until that arrives, and whenever a snapshot is for a different
 * backend, Agent, Plan, and Ask stay available. Both Ollama and Codex honour
 * those three modes.
 */
export function visibleModeSnapshot(state: AppState): ModeSnapshot | undefined {
  const backendId = state.selectedBackendId;
  if (!backendId) {
    return undefined;
  }
  const hosted = state.modeOptions;
  if (hosted?.backendId === backendId && hosted.options.length > 1) {
    return hosted;
  }
  return {
    backendId,
    options: MODE_DESCRIPTORS.map((descriptor) => ({
      mode: descriptor.mode,
      label: descriptor.label,
      description: descriptor.description
    })),
    selected: hosted?.backendId === backendId ? hosted.selected : state.mode
  };
}

function upsertTurnChange(turns: readonly TurnChange[], next: TurnChange): TurnChange[] {
  const index = turns.findIndex((turn) => turn.turnId === next.turnId);
  if (index === -1) {
    return [...turns, next];
  }
  const copy = turns.slice();
  copy[index] = next;
  return copy;
}

/**
 * The action for a skill-toggle message from the host.
 *
 * The host reports a refused CLI path as `field` / `fieldMessage`, so the
 * screen can show the refusal on the path field itself. The bridge forwards
 * the message through this one helper, so a field can never be dropped
 * between the host and the reducer â€” the mistake that silently left the
 * refusal invisible.
 *
 * Pure and exported, so the forwarding is unit-tested rather than inferred
 * from a source grep.
 */
export function skillToggleAction(
  message: Extract<HostToWebviewMessage, { type: 'zvecGrep' | 'astGrep' }>
): Extract<Action, { type: 'zvecGrep' | 'astGrep' }> {
  return {
    type: message.type,
    pending: message.pending,
    requested: message.requested,
    ok: message.ok,
    message: message.message,
    field: message.field,
    fieldMessage: message.fieldMessage
  };
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'snapshot': {
      // A disabled provider is still in the snapshot so Settings can report its
      // state, but it is not a valid selection for the composer. Keep the
      // current provider only when the user left it enabled.
      const enabled = action.availability.filter((b) => b.enabled !== false);
      const selected =
        state.selectedBackendId && enabled.some((b) => b.id === state.selectedBackendId)
          ? state.selectedBackendId
          : enabled.find((b) => b.status === 'available')?.id;
      // Model lists are always live from `/api/tags`: drop the cache on every
      // availability change so a server-side removal is visible after refresh.
      // A model choice survives re-probing only when the backend is unchanged;
      // otherwise the stale id belongs to a backend that is no longer selected.
      const nextModel = selected === state.selectedBackendId ? state.selectedModel : undefined;
      const changedModel = nextModel !== state.selectedModel;
      return {
        ...state,
        availability: action.availability,
        selectedBackendId: selected,
        selectedModel: nextModel,
        modelCapability: changedModel ? undefined : state.modelCapability,
        modelCapabilityStatus: changedModel && nextModel ? 'loading' : state.modelCapabilityStatus,
        modelCapabilityError: changedModel ? undefined : state.modelCapabilityError,
        models: {},
        modelErrors: {}
      };
    }
    case 'models': {
      const models = { ...state.models, [action.backendId]: action.models };
      const modelErrors = { ...state.modelErrors };
      if (action.error !== undefined) {
        modelErrors[action.backendId] = action.error;
      } else {
        delete modelErrors[action.backendId];
      }
      const selectedModel =
        state.selectedBackendId === action.backendId &&
        (!state.selectedModel || !action.models.some((model) => model.id === state.selectedModel))
          ? action.models[0]?.id
          : state.selectedModel;
      // An auto-selected model is a model change like any other: resolve its
      // own capabilities rather than leaving the previous model's values up.
      const changedModel = selectedModel !== state.selectedModel;
      return {
        ...state,
        models,
        modelErrors,
        selectedModel,
        modelCapability: changedModel ? undefined : state.modelCapability,
        modelCapabilityStatus: changedModel ? 'loading' : state.modelCapabilityStatus,
        modelCapabilityError: changedModel ? undefined : state.modelCapabilityError
      };
    }
    case 'clearModels': {
      // Force one provider back to its loading state without touching the
      // transcript or thread cache; used by the panel's per-provider retry.
      const models = { ...state.models };
      const modelErrors = { ...state.modelErrors };
      delete models[action.backendId];
      delete modelErrors[action.backendId];
      return { ...state, models, modelErrors };
    }
    case 'threads':
      return {
        ...state,
        threads: { ...state.threads, [action.backendId]: action.threads },
        threadLoading: { ...state.threadLoading, [action.backendId]: false }
      };
    case 'chatTabs':
      return { ...state, chatTabs: action.tabs };
    case 'threadsLoading':
      return { ...state, threadLoading: { ...state.threadLoading, [action.backendId]: action.value } };
    case 'selectBackend':
      if (action.backendId === state.selectedBackendId) {
        return state;
      }
      return {
        ...state,
        selectedBackendId: action.backendId,
        selectedModel: state.models[action.backendId]?.[0]?.id,
        // The panel for the previous model must not linger: drop the resolved
        // capability and mark the read loading until the host answers for the
        // new selection, so values never carry across models.
        modelCapability: undefined,
        modelCapabilityStatus: 'loading',
        modelCapabilityError: undefined,
        // The permission and mode read models belong to the previous backend
        // until the host answers for the new one; clearing them avoids showing
        // the wrong levels or modes for a moment.
        permissions: undefined,
        modeOptions: undefined
      };
    case 'selectModel':
      if (action.model === state.selectedModel) {
        return state;
      }
      return {
        ...state,
        selectedModel: action.model,
        // Same rule as a backend switch: a new model resolves its own defaults,
        // and the previous model's values are never shown against it.
        modelCapability: undefined,
        modelCapabilityStatus: 'loading',
        modelCapabilityError: undefined
      };
    case 'userMessageId': {
      if (state.activeThreadId && state.activeThreadId !== action.threadId) {
        return state;
      }
      if (state.selectedBackendId && state.selectedBackendId !== action.backendId) {
        return state;
      }
      let index = -1;
      for (let cursor = state.transcript.length - 1; cursor >= 0; cursor -= 1) {
        const item = state.transcript[cursor];
        if (item?.kind === 'message' && item.role === 'user' && item.id.startsWith('local_')) {
          index = cursor;
          break;
        }
      }
      if (index === -1) {
        return state;
      }
      const transcript = state.transcript.slice();
      const item = transcript[index];
      if (!item) {
        return state;
      }
      const existing = messageSentAt(item);
      const incoming = action.sentAt != null ? messageSentAt({ sentAt: action.sentAt }) : undefined;
      // Keep the moment the user sent. A later host stamp must not move the
      // start, and a finished turn must not be remeasured.
      const sentAt =
        item.workedMs != null
          ? existing
          : existing != null && incoming != null
            ? Math.min(existing, incoming)
            : (existing ?? incoming);
      transcript[index] = {
        ...item,
        id: action.messageId,
        ...(sentAt != null ? { sentAt } : {})
      };
      return { ...state, transcript };
    }
    case 'revertLocalSend': {
      let index = -1;
      for (let cursor = state.transcript.length - 1; cursor >= 0; cursor -= 1) {
        const item = state.transcript[cursor];
        if (item?.kind === 'message' && item.role === 'user' && item.id.startsWith('local_') && item.text === action.text) {
          index = cursor;
          break;
        }
      }
      if (index === -1) {
        return state;
      }
      const transcript = state.transcript.slice();
      transcript.splice(index, 1);
      return { ...state, transcript, contextUsedTokens: estimateConversationTokens(transcript) };
    }
    case 'userMessageSent': {
      if (state.activeThreadId && state.activeThreadId !== action.threadId) {
        return state;
      }
      if (state.selectedBackendId && state.selectedBackendId !== action.backendId) {
        return state;
      }
      // A replay may already carry this stored row; the id is authoritative.
      if (state.transcript.some((item) => item.id === action.messageId)) {
        return state;
      }
      const sent: TranscriptItemView = {
        id: action.messageId,
        kind: 'message',
        backendId: action.backendId,
        threadId: action.threadId,
        role: 'user',
        attachments: action.attachments,
        text: action.text,
        status: 'completed',
        ...(action.sentAt != null ? { sentAt: action.sentAt } : {}),
        ...(action.orchestration ? { orchestration: true } : {})
      };
      // A webview that already showed an optimistic bubble for this text gets
      // it adopted rather than duplicated. An orchestration row is never the
      // user's own bubble, so it must not adopt one even if the text matches.
      let localIndex = -1;
      if (!action.orchestration) {
        for (let cursor = state.transcript.length - 1; cursor >= 0; cursor -= 1) {
          const item = state.transcript[cursor];
          if (item?.kind === 'message' && item.role === 'user' && item.id.startsWith('local_') && item.text === action.text) {
            localIndex = cursor;
            break;
          }
        }
      }
      if (localIndex !== -1) {
        const transcript = state.transcript.slice();
        transcript[localIndex] = { ...transcript[localIndex], ...sent };
        return { ...state, transcript };
      }
      return {
        ...state,
        transcript: [...state.transcript, sent],
        contextUsedTokens: (state.contextUsedTokens ?? 0) + tokensFromText(action.text)
      };
    }
    case 'localUserMessage':
      return {
        ...state,
        notice: withoutFailureNotice(state.notice),
        attachments: [],
        attachmentError: undefined,
        // A finished plan's status row is for that result. The next message
        // moves the conversation on, so the row hides with the send.
        plan:
          state.plan && shouldDismissCompletedPlan(state.plan, false)
            ? { ...state.plan, completedDismissed: true }
            : state.plan,
        contextUsedTokens: (state.contextUsedTokens ?? 0) + tokensFromText(action.text),
        transcript: [
          ...state.transcript,
          {
            id: `local_${state.transcript.length}_${Date.now()}`,
            kind: 'message',
            role: 'user',
            attachments: action.attachments,
            text: action.text,
            status: 'completed',
            // A steer or a mid-turn answer stays on the turn already running.
            ...(action.opensTurn === false ? {} : { sentAt: Date.now() })
          }
        ]
      };
    case 'conversation': {
      const replay = action.replay ? action.replay.map(toTranscriptItemView(action.backendId)) : [];
      const localUser = [...state.transcript]
        .reverse()
        .find((item) => item.kind === 'message' && item.role === 'user' && item.id.startsWith('local_'));
      const sameChat =
        Boolean(action.threadId) &&
        action.threadId === state.activeThreadId &&
        action.backendId === state.selectedBackendId;
      const replayHasUser =
        localUser != null &&
        replay.some((item) => item.kind === 'message' && item.role === 'user' && item.text === localUser.text);
      // A send that is still only on screen must survive a repaint of this chat.
      // A rate-limit failure reloads history that does not contain the message yet.
      const pendingUser =
        localUser && !replayHasUser && (action.keepPendingUserMessage || sameChat) ? localUser : undefined;
      // Exactly one pending prompt per request: drop any replayed
      // `approval-requested` card that is not the still-open request, then
      // re-inject the live one so a reload can never show none or two.
      const transcript = reconcilePendingItems(
        replay,
        action.backendId,
        action.threadId,
        action.pendingApproval
      );
      const nextTranscript = pendingUser ? [...transcript, pendingUser] : transcript;
      // A provider change must not keep the previous provider's model. That
      // pairing sent an Ollama Cloud model to the Codex thread left open
      // after a compaction failure.
      const providerChanged = action.backendId !== state.selectedBackendId;
      const nextModel = action.model ?? (providerChanged ? undefined : state.selectedModel);
      const activityKey = action.threadId ? `${action.backendId}:${action.threadId}` : undefined;
      const changedModel = nextModel !== state.selectedModel;
      const nextState: AppState = {
        ...state,
        selectedBackendId: action.backendId,
        selectedModel: nextModel,
        // A resumed conversation pins a model, so the panel must resolve that
        // model's defaults fresh rather than showing whatever was on screen.
        modelCapability: changedModel ? undefined : state.modelCapability,
        modelCapabilityStatus: changedModel ? 'loading' : state.modelCapabilityStatus,
        modelCapabilityError: changedModel ? undefined : state.modelCapabilityError,
        permissionLevel: action.permissionLevel ?? state.permissionLevel,
        permissionEpoch: action.permissionLevel !== undefined ? state.permissionEpoch + 1 : state.permissionEpoch,
        mode: action.mode ?? state.mode,
        modeOptions:
          state.modeOptions?.backendId === action.backendId
            ? { ...state.modeOptions, selected: action.mode ?? state.mode }
            : state.modeOptions,
        activeThreadId: action.threadId,
        // A failure banner belongs to the conversation that produced it.
        notice:
          action.threadId !== state.activeThreadId || action.backendId !== state.selectedBackendId
            ? undefined
            : state.notice,
        busy: activityKey ? Boolean(state.threadActivity[activityKey]?.busy) : false,
        threadActivity: activityKey && state.threadActivity[activityKey]?.unread
          ? { ...state.threadActivity, [activityKey]: { ...state.threadActivity[activityKey], unread: false } }
          : state.threadActivity,
        // Pending chips belong to the composer draft, which the view restores
        // per tab. A repaint of the open chat must not drop them.
        attachmentError: undefined,
        // Queued chips belong to the thread on screen. A repaint or snapshot of
        // this same chat keeps them; only a thread/provider switch clears them.
        queuedTurns: sameChat ? state.queuedTurns : [],
        // A revision belongs to the plan that was on screen; a switch resets it.
        planRevising: false,
        rejectConfirmationOpen: false,
        pendingApproval: action.pendingApproval
          ? { backendId: action.backendId, threadId: action.threadId ?? '', request: action.pendingApproval }
          : undefined,
        pendingQuestion: action.pendingQuestion,
        // A replay replaces the transcript; a fresh conversation clears it.
        // A send that just opened this thread keeps the optimistic user line.
        transcript: nextTranscript,
        hasOlderHistory: action.hasOlderHistory ?? false,
        loadingOlder: false,
        contextUsedTokens: estimateConversationTokens(nextTranscript),
        contextWindowTokens: changedModel ? undefined : state.contextWindowTokens,
        // A plan is carried with the conversation so a resumed thread reopens it.
        plan: action.plan,
        // Hydration and other same-thread replays replace the transcript without
        // necessarily reposting its change cards. Keep that evidence until the
        // host explicitly replaces it; switching conversations still drops it.
        turnChanges: sameChat ? state.turnChanges : [],
        changeDecision: undefined,
        changeRejectConfirm: undefined,
        changeDeciding: false,
        // Some turn cards use checkpoints to find their opening user message.
        // Preserve those anchors on a replay too; never carry them into a switch.
        checkpoints: sameChat ? state.checkpoints : undefined,
        restoreResult: undefined,
        restoreConfirmation: undefined
      };
      return action.notice
        ? appendStatusNotice(nextState, action.notice.message, action.notice.level, action.notice.action)
        : nextState;
    }
    case 'olderHistoryLoading':
      return { ...state, loadingOlder: true };
    case 'olderHistory': {
      if (action.threadId !== state.activeThreadId || action.backendId !== state.selectedBackendId) {
        return { ...state, loadingOlder: false };
      }
      const seen = new Set(state.transcript.map((item) => item.id));
      const older = action.items.map(toTranscriptItemView(action.backendId)).filter((item) => !seen.has(item.id));
      const transcript = older.length > 0 ? [...older, ...state.transcript] : state.transcript;
      return {
        ...state,
        loadingOlder: false,
        hasOlderHistory: action.hasOlderHistory,
        transcript,
        contextUsedTokens: estimateConversationTokens(transcript)
      };
    }
    case 'questionAsked':
      return {
        ...state,
        pendingQuestion: action.request,
        transcript: action.request.itemId
          ? state.transcript.map((item) =>
              item.id === action.request.itemId && action.request.strippedText !== undefined
                ? { ...item, text: action.request.strippedText }
                : item
            )
          : state.transcript
      };
    case 'questionCleared':
      return { ...state, pendingQuestion: undefined };
    case 'restoring':
      return { ...state, restoring: action.value };
    case 'busy':
      if (action.backendId && action.threadId) {
        const key = `${action.backendId}:${action.threadId}`;
        const threadActivity = { ...state.threadActivity, [key]: { ...state.threadActivity[key], busy: action.value, unread: state.threadActivity[key]?.unread ?? false } };
        const active = state.selectedBackendId === action.backendId && state.activeThreadId === action.threadId;
        return { ...state, threadActivity, ...(active ? { busy: action.value, startingTurn: action.value ? state.startingTurn : false } : {}) };
      }
      return { ...state, busy: action.value, startingTurn: action.value ? state.startingTurn : false };
    case 'notice':
      return placeNotice(state, {
        level: action.level,
        message: action.message,
        action: action.action
      });
    case 'dismissNotice':
      return { ...state, notice: undefined };
    case 'dismissStatusNotice': {
      const text = action.text.trim();
      if (!text) {
        return state;
      }
      const transcript = state.transcript.filter(
        (item) => !(item.kind === 'notice' && item.detail === 'status' && item.text === text)
      );
      return {
        ...state,
        notice: undefined,
        busy: action.preserveBusy ? state.busy : false,
        startingTurn: action.preserveBusy ? state.startingTurn : false,
        transcript
      };
    }
    case 'addAttachments': {
      // A file already on the message is never added twice; two picks of the
      // same path would otherwise render duplicate chips.
      const seen = new Set(state.attachments.map((attachment) => attachment.path ?? attachment.id));
      const additions = action.attachments.filter(
        (attachment) => !seen.has(attachment.path ?? attachment.id)
      );
      if (additions.length === 0) {
        return state;
      }
      return { ...state, attachments: [...state.attachments, ...additions], attachmentError: undefined };
    }
    case 'removeAttachment':
      return {
        ...state,
        attachments: state.attachments.filter((attachment) => attachment.id !== action.id)
      };
    case 'setAttachments':
      return { ...state, attachments: action.attachments };
    case 'attachmentError':
      return { ...state, attachmentError: action.message };
    case 'dismissAttachmentError':
      return { ...state, attachmentError: undefined };
    case 'queuedTurns':
      return { ...state, queuedTurns: action.entries };
    case 'cancelQueuedTurn':
      return {
        ...state,
        queuedTurns: state.queuedTurns.filter((entry) => entry.id !== action.id)
      };
    case 'refresh':
      // Drop cached model lists so the live `/api/tags` result repopulates the
      // picker; a model removed server-side disappears on the next fetch.
      return { ...state, models: {}, modelErrors: {}, threads: {}, threadLoading: {} };
    case 'openSettings':
      return {
        ...state,
        settingsOpen: true,
        settingsProvider: action.provider
      };
    case 'closeSettings':
      // Leaving the screen discards a transient test result so re-opening it
      // never shows a stale success or failure.
      return {
        ...state,
        settingsOpen: false,
        settingsProvider: undefined,
        connectionTest: undefined,
        codexVersionCheck: undefined,
        opencodeUpgrade: undefined,
        opencodeInstall: undefined,
        zvecGrep: undefined,
        astGrep: undefined,
        astGrepInstall: undefined,
        zvecGrepInstall: undefined,
        skillAction: undefined,
        settingsSave: undefined
      };
    case 'settings':
      return { ...state, settings: action.settings };
    case 'settingsSave':
      return { ...state, settingsSave: { pending: action.pending, ok: action.ok, message: action.message } };
    case 'permissions': {
      const applySelected = action.permissions.epoch >= state.permissionEpoch;
      return {
        ...state,
        permissions: action.permissions,
        permissionLevel: applySelected ? action.permissions.selected : state.permissionLevel,
        permissionEpoch: applySelected ? action.permissions.epoch : state.permissionEpoch
      };
    }
    case 'modes':
      // A snapshot belongs to one backend. Applying a Codex list while Ollama
      // is selected would hide or replace the mode the user is about to use.
      if (state.selectedBackendId && action.modes.backendId !== state.selectedBackendId) {
        return state;
      }
      return { ...state, modeOptions: action.modes, mode: action.modes.selected };
    case 'selectMode':
      // Changing mode applies to the next turn; the transcript is untouched.
      return { ...state, mode: action.mode };
    case 'plan':
      // A fresh plan arrives when one is created or revised. It replaces the
      // displayed plan in place (one card, never a second), so a pending
      // revision resolves here.
      return { ...state, plan: action.plan, planRevising: false, rejectConfirmationOpen: false };
    case 'planRevising':
      return { ...state, planRevising: true, rejectConfirmationOpen: false };
    case 'planSettled':
      return { ...state, planRevising: false };
    case 'requestRejectConfirmation':
      return { ...state, rejectConfirmationOpen: true };
    case 'cancelRejectConfirmation':
      return { ...state, rejectConfirmationOpen: false };
    case 'selectPermission':
      // The host is told in the same gesture and stores the level for the next
      // chat. Bumping the epoch drops a permissions snapshot that was already
      // in flight with the previous level. `unrestricted` is only dispatched
      // after the labelled confirmation.
      return {
        ...state,
        permissionLevel: action.level,
        permissionConfirmationOpen: false,
        permissionEpoch: state.permissionEpoch + 1
      };
    case 'requestPermissionConfirmation':
      return { ...state, permissionConfirmationOpen: true };
    case 'cancelPermissionConfirmation':
      return { ...state, permissionConfirmationOpen: false };
    case 'openRules':
      return { ...state, rulesOpen: true };
    case 'closeRules':
      return { ...state, rulesOpen: false };
    case 'connectionTestPending':
      return { ...state, connectionTest: { backendId: action.backendId, pending: true } };
    case 'connectionTest':
      return {
        ...state,
        connectionTest: { backendId: action.result.backendId, pending: false, result: action.result }
      };
    case 'codexVersionCheck':
      return {
        ...state,
        codexVersionCheck: { pending: action.pending, ok: action.ok, message: action.message }
      };
    case 'opencodeUpgrade':
      return {
        ...state,
        opencodeUpgrade: { pending: action.pending, ok: action.ok, message: action.message }
      };
    case 'opencodeInstall':
      return {
        ...state,
        opencodeInstall: { pending: action.pending, ok: action.ok, message: action.message, path: action.path }
      };
    case 'zvecGrep':
      return {
        ...state,
        zvecGrep: {
          pending: action.pending,
          requested: action.requested,
          ok: action.ok,
          message: action.message,
          field: action.field,
          fieldMessage: action.fieldMessage
        }
      };
    case 'astGrep':
      return {
        ...state,
        astGrep: {
          pending: action.pending,
          requested: action.requested,
          ok: action.ok,
          message: action.message,
          field: action.field,
          fieldMessage: action.fieldMessage
        }
      };
    case 'astGrepInstall':
      return {
        ...state,
        astGrepInstall: {
          pending: action.pending,
          ok: action.ok,
          message: action.message,
          path: action.path
        }
      };
    case 'zvecGrepInstall':
      return {
        ...state,
        zvecGrepInstall: {
          pending: action.pending,
          ok: action.ok,
          message: action.message,
          path: action.path
        }
      };
    case 'skillAction':
      return {
        ...state,
        skillAction: {
          skill: action.skill,
          action: action.action,
          pending: action.pending,
          ok: action.ok,
          message: action.message
        }
      };
    case 'context':
      // The host is the single source of truth for both the view and the
      // exclusion set in effect. The local set exists only to make a toggle read
      // immediately; this echo replaces it, so a turn that consumed the
      // exclusions (or a reset) cannot leave a stale one on screen.
      return {
        ...state,
        contextView: action.view,
        contextSettingsEnabled: action.settingsEnabled,
        contextExclusions: action.exclusions,
        includeViewedFile: action.includeViewedFile,
        workspaceRoots: action.workspaceRoots ?? state.workspaceRoots
      };
    case 'setIncludeViewedFile':
      return { ...state, includeViewedFile: action.included };
    case 'toggleContextExclusion': {
      const next = state.contextExclusions.includes(action.key)
        ? state.contextExclusions.filter((key) => key !== action.key)
        : [...state.contextExclusions, action.key];
      return { ...state, contextExclusions: next };
    }
    case 'resetContextExclusions':
      return { ...state, contextExclusions: [] };
    case 'changesChanged': {
      // Only the active thread's turn updates the visible cards; a background
      // thread's set must not overwrite what the surface is showing.
      if (state.activeThreadId && state.activeThreadId !== action.threadId) {
        return state;
      }
      // A blank turn id is the host clearing every card before it reposts the
      // turns that survived a reload or a restore.
      if (!action.turnId) {
        return {
          ...state,
          turnChanges: [],
          changeDecision: undefined,
          changeRejectConfirm: undefined,
          changeDeciding: false
        };
      }
      // A verified no-op does not open a card and does not erase other turns.
      // A repaint of a turn that already has a review keeps that review.
      if (action.entries.length === 0) {
        return state;
      }
      const existing = state.turnChanges.find((turn) => turn.turnId === action.turnId);
      const next: TurnChange = {
        turnId: action.turnId,
        messageId: action.messageId ?? existing?.messageId,
        entries: action.entries,
        review: existing?.review
      };
      return { ...state, turnChanges: upsertTurnChange(state.turnChanges, next) };
    }
    case 'changeReview': {
      // A review belongs to the turn it was recorded for. A background thread's
      // review is ignored. Other turns' cards stay.
      if (state.activeThreadId && state.activeThreadId !== action.review.threadId) {
        return state;
      }
      const existingReview = state.turnChanges.find((turn) => turn.turnId === action.review.turnId);
      const reviewed: TurnChange = {
        turnId: action.review.turnId,
        messageId: action.review.messageId ?? existingReview?.messageId,
        entries: existingReview?.entries ?? [],
        review: action.review
      };
      return {
        ...state,
        turnChanges: upsertTurnChange(state.turnChanges, reviewed),
        changeRejectConfirm:
          state.changeRejectConfirm?.turnId === action.review.turnId ? undefined : state.changeRejectConfirm,
        changeDeciding: false
      };
    }
    case 'changeHunks': {
      const index = state.turnChanges.findIndex((turn) => turn.review?.turnId === action.turnId);
      if (index === -1) {
        return state;
      }
      const turn = state.turnChanges[index];
      const review = turn.review;
      if (!review) {
        return state;
      }
      const turnChanges = state.turnChanges.slice();
      turnChanges[index] = {
        ...turn,
        review: {
          ...review,
          files: review.files.map((file) =>
            file.path === action.path
              ? {
                  ...file,
                  hunks: action.hunks,
                  linesOmitted: false,
                  detail: action.truncated ? 'Showing the first lines. Open the diff to see the rest.' : file.detail
                }
              : file
          )
        }
      };
      return { ...state, turnChanges };
    }
    case 'changeDecision':
      return {
        ...state,
        changeDecision: { results: action.results, message: action.message },
        // A decision answer settles the in-flight lock and any confirmation that
        // opened it; a conflict is not a failure here, only a second explicit
        // choice the row must now offer.
        changeDeciding: false,
        changeRejectConfirm: undefined
      };
    case 'requestChangeRejectConfirmation':
      return { ...state, changeRejectConfirm: { turnId: action.turnId, scope: action.scope, paths: action.paths } };
    case 'cancelChangeRejectConfirmation':
      return { ...state, changeRejectConfirm: undefined };
    case 'changeDeciding':
      return { ...state, changeDeciding: action.value };
    case 'checkpoints':
      return { ...state, checkpoints: action.checkpoints };
    case 'restoreResult':
      return { ...state, restoreResult: action.result, restoreConfirmation: undefined };
    case 'restorePreview':
      return { ...state, restoreConfirmation: action.preview };
    case 'cancelRestoreConfirmation':
      return { ...state, restoreConfirmation: undefined };
    case 'modeSwitchPrompt':
      return {
        ...state,
        modeSwitch: { requestId: action.requestId, from: action.from, to: action.to }
      };
    case 'clearModeSwitch':
      return { ...state, modeSwitch: undefined };
    case 'modelCapability':
      // The host resolved and clamped these values; the webview stores them and
      // the inline settings panel renders them. Ignore a late answer for a model
      // that is no longer selected, so a slower read cannot overwrite the
      // current model's values.
      if (
        state.selectedBackendId !== action.capability.providerId ||
        state.selectedModel !== action.capability.modelId
      ) {
        return state;
      }
      return {
        ...state,
        modelCapability: action.capability,
        modelCapabilityStatus: 'ready',
        modelCapabilityError: undefined
      };
    case 'modelCapabilityLoading':
      // Drop the previous snapshot so a tab switch cannot keep showing another
      // chat's thinking level while this chat's settings are read.
      return {
        ...state,
        modelCapability: undefined,
        modelCapabilityStatus: 'loading',
        modelCapabilityError: undefined
      };
    case 'modelCapabilityError':
      // Ignore a failure for a model that is no longer selected, so a slow
      // failed read never errors the panel showing the current model.
      if (
        state.selectedBackendId !== action.providerId ||
        state.selectedModel !== action.modelId
      ) {
        return state;
      }
      return { ...state, modelCapabilityStatus: 'error', modelCapabilityError: action.message };
    case 'setModelSettings':
    case 'resetModelSettings':
    case 'resetModelSettingField':
      // Intent actions: the host owns persistence and echoes the resolved
      // result back as a `modelCapability` message, so there is no state change
      // here. Naming them keeps the dispatch type exhaustive.
      return state;
    case 'agentEvent': {
      const { event } = action;
      const key = event.threadId ? `${event.backendId}:${event.threadId}` : undefined;
      const active = state.selectedBackendId === event.backendId && state.activeThreadId === event.threadId;
      const lifecycleBusy = event.type === 'turn/started' || (event.type === 'thread/status/changed' && event.status === 'active');
      const lifecycleDone = event.type === 'turn/completed' || event.type === 'turn/interrupted';
      if (!key) return applyAgentEvent(state, event);
      const old = state.threadActivity[key] ?? { busy: false, unread: false };
      const threadActivity = { ...state.threadActivity, [key]: { ...old, ...(lifecycleBusy ? { busy: true } : {}), ...(lifecycleDone ? { busy: false } : {}), ...(!active && (event.type === 'item/started' || event.type === 'item/delta' || event.type === 'item/completed') ? { unread: true } : {}) } };
      if (!active) return { ...state, threadActivity };
      let next = applyAgentEvent(state, event);
      if (lifecycleBusy || lifecycleDone) next = { ...next, busy: lifecycleBusy };
      return { ...next, threadActivity };
    }
    default:
      return state;
  }
}

/**
 * The single pending approval, preferring the explicitly tracked request so a
 * reload and a live event resolve to the same card. Falls back to a transcript
 * card only when no request was tracked.
 */
export function pendingApproval(state: AppState): TranscriptItemView | undefined {
  const requestId = state.pendingApproval?.request.id;
  if (requestId) {
    const tracked = state.transcript.find((item) => item.id === requestId);
    if (tracked) {
      return { ...tracked, status: 'pending' };
    }
  }
  return state.transcript.find((item) => item.kind === 'approval-requested' && item.status === 'pending');
}

/** Map a replayed host item onto the renderer's view shape. */
function toTranscriptItemView(backendId: string) {
  return (item: TranscriptItem): TranscriptItemView => ({
    id: item.id,
    kind: item.kind,
    noticeLevel: item.noticeLevel,
    agentActivity: item.agentActivity,
    backendId,
    role: item.role,
    title: item.title,
    tool: item.tool,
    detail: item.detail,
    command: item.command,
    files: item.files,
    approval: item.approval,
    approvalDecision: item.approvalDecision,
    attachments: item.attachments,
    orchestration: item.orchestration,
    text: item.text ?? '',
    sentAt: item.sentAt,
    workedMs: item.workedMs,
    status: item.status ?? 'completed'
  });
}

/**
 * Keep exactly one pending prompt in a replayed transcript. Any
 * `approval-requested` card that is not the still-open request is dropped (it
 * was settled before the reload), and the live request is re-injected once.
 */
function reconcilePendingItems(
  items: TranscriptItemView[],
  backendId: string,
  threadId: string | undefined,
  pending: ApprovalRequest | undefined
): TranscriptItemView[] {
  const withoutPending = items.filter((item) => item.kind !== 'approval-requested');
  if (!pending) {
    return withoutPending;
  }
  const existing = items.find((item) => item.id === pending.id && item.kind === 'approval-requested');
  const card: TranscriptItemView = existing
    ? { ...existing, status: 'pending' }
    : {
        id: pending.id,
        kind: 'approval-requested',
        backendId,
        threadId,
        title: 'Approval needed',
        approval: pending,
        text: requestMessage(pending),
        status: 'pending'
      };
  return [...withoutPending, card];
}

function preferDetail(current: string | undefined, incoming: string | undefined): string | undefined {
  const next = incoming?.trim();
  if (next && !isStatusText(next)) {
    return next;
  }
  if (current && !isStatusText(current)) {
    return current;
  }
  return undefined;
}

/** Keep the fuller tool output when a later event restates the same call. */
function preferText(current: string, incoming: string | undefined): string {
  if (!incoming) {
    return current;
  }
  if (!current || incoming.startsWith(current)) {
    return incoming;
  }
  if (current.startsWith(incoming)) {
    return current;
  }
  return incoming.length >= current.length ? incoming : current;
}

/**
 * True when the latest user row is an injected orchestration continuation.
 * The row is posted before the backend turn starts, so `turn/started` can use
 * it to keep the "Starting" placeholder out of the transcript.
 */
function latestUserIsOrchestration(transcript: readonly TranscriptItemView[]): boolean {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item?.kind === 'message' && item.role === 'user') {
      return item.orchestration === true;
    }
  }
  return false;
}

function mergeToolItem(item: TranscriptItemView, incoming: TranscriptItem): TranscriptItemView {
  return {
    ...item,
    title: incoming.title || item.title,
    tool: incoming.tool || item.tool,
    command: cleanToolTarget(incoming.command) ?? cleanToolTarget(item.command),
    detail: preferDetail(item.detail, incoming.detail),
    files: incoming.files && incoming.files.length > 0 ? incoming.files : item.files,
    text: preferText(item.text, incoming.text)
  };
}

function applyAgentEvent(state: AppState, event: AgentEvent): AppState {
  switch (event.type) {
    case 'thread/started':
      return state;
    case 'thread/status/changed':
      // The provider's own thread status is informational: `active` means a turn
      // is running, so the composer stays locked, but a status flap never clears
      // a busy state early â€” only the turn lifecycle does that.
      if (event.status === 'active' && !state.busy) {
        return { ...state, busy: true };
      }
      return state;
    case 'turn/started': {
      // A new turn freezes the review surface rather than discarding it: the
      // panel keeps the last completed turn's rows but renders them pending with
      // their controls locked, so a running turn never shows a settled decision
      // as actionable. The authoritative counts are replaced by a pending strip
      // in the surface itself. Decision bookkeeping for the prior round resets.
      //
      // An orchestration continuation is already represented by its own
      // collapsed row, so it has no "Starting" row of its own. A normal user
      // turn keeps that affordance until its first item arrives.
      const opensFromOrchestration = latestUserIsOrchestration(state.transcript);
      return {
        ...state,
        busy: true,
        startingTurn: !opensFromOrchestration,
        notice: withoutFailureNotice(state.notice),
        changeDecision: undefined,
        changeRejectConfirm: undefined,
        changeDeciding: false
      };
    }
    case 'item/started': {
      // One card per id. A later tool event can fill in the real command or
      // output once the runtime reports it; it must not open a second card.
      const existing = state.transcript.find((item) => item.id === event.item.id);
      if (existing) {
        if (existing.agentActivity && event.item.agentActivity) {
          return {
            ...state,
            transcript: state.transcript.map((item) => item.id === event.item.id
              ? { ...item, agentActivity: event.item.agentActivity, text: event.item.text ?? item.text,
                  status: event.item.status ?? item.status }
              : item)
          };
        }
        if (existing.kind !== 'tool' && existing.kind !== 'file-change') {
          return state;
        }
        return {
          ...state,
          transcript: state.transcript.map((item) =>
            item.id === event.item.id ? mergeToolItem(item, event.item) : item
          )
        };
      }
      return {
        ...state,
        startingTurn: false,
        notice: withoutFailureNotice(state.notice),
        transcript: [
          ...state.transcript,
          {
            id: event.item.id,
            kind: event.item.kind,
            noticeLevel: event.item.noticeLevel,
            agentActivity: event.item.agentActivity,
            backendId: event.backendId,
            role: event.item.role,
            title: event.item.title,
            tool: event.item.tool,
            detail: preferDetail(undefined, event.item.detail),
            command: cleanToolTarget(event.item.command),
            files: event.item.files,
            approval: event.item.approval,
            text: event.item.kind === 'tool' || event.item.kind === 'notice' ? (event.item.text ?? '') : '',
            status: 'streaming'
          }
        ]
      };
    }
    case 'item/delta':
      return {
        ...state,
        contextUsedTokens: (state.contextUsedTokens ?? 0) + tokensFromText(event.delta),
        transcript: state.transcript.map((item) =>
          item.id === event.itemId ? { ...item, text: item.text + event.delta } : item
        )
      };
    case 'context/usage':
      return {
        ...state,
        contextUsedTokens: event.usedTokens,
        contextWindowTokens: event.windowTokens ?? state.contextWindowTokens
      };
    case 'item/completed':
      return {
        ...state,
        transcript: state.transcript.map((item) =>
          item.id === event.itemId ? { ...item, status: event.status } : item
        )
      };
    case 'approval/requested':
      // A distinct item kind carries the pending request through the same
      // provider-agnostic transcript path as every other card. The request is
      // also tracked as `pendingApproval`, which is what locks the composer
      // until a decision arrives. Nothing here ever resolves it on its own.
      return {
        ...state,
        startingTurn: false,
        pendingApproval: { backendId: event.backendId, threadId: event.threadId, request: event.approval },
        transcript: state.transcript.some((item) => item.id === event.approval.id)
          ? state.transcript
          : [
              ...state.transcript,
              {
                id: event.approval.id,
                kind: 'approval-requested',
                backendId: event.backendId,
                threadId: event.threadId,
                title: 'Approval needed',
                approval: event.approval,
                text: requestMessage(event.approval),
                status: 'pending'
              }
            ]
      };
    case 'approval/decided': {
      // The same card transitions kind: a rejection becomes `approval-denied`,
      // anything else `approval-decided`, so the transcript shows one card.
      const denied = event.outcome.decision === 'reject';
      const wasPending = state.pendingApproval?.request.id === event.outcome.requestId;
      return {
        ...state,
        pendingApproval: wasPending ? undefined : state.pendingApproval,
        transcript: state.transcript.map((item) =>
          item.id === event.outcome.requestId
            ? {
                ...item,
                kind: denied ? 'approval-denied' : 'approval-decided',
                approvalDecision: event.outcome.decision,
                status: 'completed',
                text: decisionMessage(event.outcome.decision)
              }
            : item
        )
      };
    }
    case 'approval/denied': {
      // Show the backend's own reason (for a safety block, the risk and the
      // command) so the user sees what was refused. The agent is told only that
      // the request was denied, so do not claim it received this sentence.
      const reason = event.reason?.trim();
      return placeNotice(state, {
        level: 'info',
        message: reason
          ? `${reason} The agent was told it was denied.`
          : `${event.subject ? `${event.subject}: ` : ''}the request was denied and the agent was told.`
      });
    }
    case 'error': {
      // A backend the user is not currently driving must never surface a status
      // or error: a failed Codex auth attempt stays invisible while Ollama is
      // the selected provider, and vice versa. A failure from another chat
      // stays there too.
      if (!eventForActiveChat(state, event.backendId, event.threadId)) {
        return state;
      }
      const failure = noticeForError(event);
      // A provider failure ends the turn. Leave the composer free so Retry can
      // send again; a still-running turn is cleared by `turn/interrupted`.
      const idle = failure.action === 'retry';
      return placeNotice(
        {
          ...state,
          planRevising: false,
          ...(idle ? { busy: false, startingTurn: false } : {})
        },
        failure
      );
    }
    case 'turn/interrupted':
      if (!eventForActiveChat(state, event.backendId, event.threadId)) {
        return state;
      }
      if (event.canceled) {
        const stopped = {
          ...state,
          busy: false,
          startingTurn: false,
          pendingApproval: undefined,
          planRevising: false,
          transcript: stampTurnWorked(markStreamingItems(state.transcript, 'canceled'), Date.now()),
          notice: undefined
        };
        return event.reason ? appendStatusNotice(stopped, event.reason, 'info') : stopped;
      }
      const interrupted = {
        ...state,
        busy: false,
        startingTurn: false,
        pendingApproval: undefined,
        planRevising: false,
        transcript: stampTurnWorked(markStreamingItems(state.transcript, 'warning'), Date.now()),
        notice: undefined
      };
      return event.reason ? appendStatusNotice(interrupted, event.reason, 'warning') : interrupted;
    case 'turn/completed':
      // A finished turn cannot still be blocking on an approval; a card that
      // somehow survived is stale, so it is dropped rather than left pending. A
      // revision in flight also resolves here if its plan echo was missed.
      return {
        ...state,
        busy: false,
        startingTurn: false,
        pendingApproval: undefined,
        planRevising: false,
        transcript: stampTurnWorked(state.transcript, Date.now())
      };
    case 'plan/updated':
      // A native plan update carries the provider's bullet list; mirror it as
      // the active plan so the review surface reflects the tracked steps. The
      // title, summary and built flag are preserved from the existing artifact.
      return {
        ...state,
        plan: {
          path: state.plan?.path ?? '',
          title: state.plan?.title ?? 'Plan',
          summary: state.plan?.summary,
          body: state.plan?.body,
          steps: event.steps,
          built: state.plan?.built,
          completedDismissed: carriedPlanDismissal(event.steps, state.plan?.completedDismissed),
          updatedAt: Date.now()
        }
      };
    case 'notice':
      // A provider-neutral line from a backend (e.g. a degraded session resume).
      // A line from another chat does not replace what is on screen.
      if (!eventForActiveChat(state, event.backendId, event.threadId)) {
        return state;
      }
      return placeNotice(state, { level: event.level, message: event.message });
    default:
      return state;
  }
}

/** The pending-card sentence for a request, in the user's terms. */
export function requestMessage(request: ApprovalRequest): string {
  switch (request.kind) {
    case 'command': {
      const command = request.displayCommand ?? request.command;
      return command ? `The agent wants to run: ${command}` : 'The agent wants to run a command.';
    }
    case 'file-change':
      return request.paths && request.paths.length > 0
        ? `The agent wants to change files under: ${request.paths.join(', ')}`
        : 'The agent wants to apply file changes.';
    case 'permissions':
      return request.network
        ? `The agent is asking for network access to ${request.network}.`
        : 'The agent is asking for extra permissions.';
    default:
      return 'The agent is asking for a decision.';
  }
}

/** The scope a decision persisted at, in plain words, for the resolved marker. */
export function decisionScope(decision: ApprovalDecision): string {
  switch (decision) {
    case 'allow-always':
      return 'saved as a lasting rule, kept across sessions';
    case 'allow-session':
      return 'this conversation only';
    case 'allow-once':
      return 'one run only';
    case 'reject':
      return 'nothing was changed';
    default:
      return '';
  }
}

/** Short label for the decision, used as the resolved marker's verb. */
export function decisionLabel(decision: ApprovalDecision): string {
  switch (decision) {
    case 'allow-once':
      return 'Allowed once';
    case 'allow-always':
      return 'Allowed always';
    case 'allow-session':
      return 'Allowed for this session';
    case 'reject':
      return 'Rejected';
    default:
      return 'Decided';
  }
}

/** The settled-card sentence for a decision. */
export function decisionMessage(decision: ApprovalDecision): string {
  switch (decision) {
    case 'allow-once':
      return 'Allowed once.';
    case 'allow-always':
      return 'Allowed, and a lasting rule was saved.';
    case 'allow-session':
      return 'Allowed for this conversation.';
    case 'reject':
      return 'Denied. The agent was told this was refused.';
    default:
      return 'Decided.';
  }
}

/** Whether an event belongs on the chat currently on screen. */
function eventForActiveChat(state: AppState, backendId: string, threadId?: string): boolean {
  if (state.selectedBackendId && backendId !== state.selectedBackendId) {
    return false;
  }
  if (threadId && state.activeThreadId && threadId !== state.activeThreadId) {
    return false;
  }
  return true;
}

/** Leave no item stuck in `streaming` after a turn ends. */
function markStreamingItems(
  transcript: TranscriptItemView[],
  status: ItemStatus
): TranscriptItemView[] {
  let changed = false;
  const next = transcript.map((item) => {
    if (item.status !== 'streaming') {
      return item;
    }
    changed = true;
    return { ...item, status };
  });
  return changed ? next : transcript;
}

/**
 * Map the error taxonomy to plain-language copy and a recovery affordance.
 *
 * Provider wording is not trusted verbatim for the generic cases: the code
 * decides the sentence, so a raw protocol failure never reaches the transcript.
 */
/**
 * Every notice is a transcript line at the moment it happens. A later reply
 * follows it. Nothing stays pinned under the thread.
 */
function placeNotice(state: AppState, notice: NonNullable<AppState['notice']>): AppState {
  return appendStatusNotice(state, notice.message, notice.level, notice.action);
}

/** Insert one status sentence where the conversation is right now. */
function appendStatusNotice(
  state: AppState,
  message: string,
  level: 'info' | 'warning' | 'error' = 'info',
  action?: NoticeAction
): AppState {
  const text = message.trim();
  if (!text) {
    return { ...state, notice: undefined };
  }
  const previous = state.transcript.at(-1);
  // Codex reports one failure twice (the error notification and the failed
  // turn). The second copy is the same sentence and must not become a second banner.
  if (
    previous?.kind === 'notice' &&
    previous.detail === 'status' &&
    previous.text === text &&
    previous.noticeLevel === level &&
    previous.noticeAction === action
  ) {
    return { ...state, notice: undefined };
  }
  return {
    ...state,
    notice: undefined,
    transcript: [
      ...state.transcript,
      {
        id: `status_${state.transcript.length}_${text.length}`,
        kind: 'notice',
        detail: 'status',
        text,
        status: 'completed',
        noticeLevel: level,
        noticeAction: action
      }
    ]
  };
}

/** Drop an error banner once the user or the agent continues. Info notices stay. */
function withoutFailureNotice(notice: AppState['notice']): AppState['notice'] {
  if (notice?.level === 'error' || notice?.level === 'warning') {
    return undefined;
  }
  return notice;
}

function noticeForError(event: Extract<AgentEvent, { type: 'error' }>): NonNullable<AppState['notice']> {
  switch (event.code) {
    case 'unauthenticated':
      return { level: 'warning', message: event.message, action: 'setToken' };
    case 'auth-mismatch':
      // The credential is rejected but it is the wrong kind: the message names
      // the API-key-vs-ChatGPT mismatch, and retrying after a fix is the route.
      return { level: 'warning', message: event.message, action: 'refresh' };
    case 'network':
      return { level: 'warning', message: event.message };
    case 'stream':
      return { level: 'warning', message: event.message };
    case 'canceled':
      return { level: 'info', message: event.message };
    case 'cli-missing':
    case 'spawn':
    case 'invalid-config':
      // Distinct, actionable states for the optional runtime, none of which is
      // a crash or a silent stall.
      return { level: 'error', message: event.message, action: 'refresh' };
    case 'provider':
      return { level: 'error', message: event.message, action: 'retry' };
    default:
      return { level: 'error', message: event.message, action: 'retry' };
  }
}

/** Typed wrapper over the VS Code webview message bridge. */
export interface HostBridge {
  post(message: WebviewToHostMessage): void;
  subscribe(listener: (message: HostToWebviewMessage) => void): () => void;
  /** Persist the editor-tab identity so a reload reopens this conversation. */
  setState(state: unknown): void;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export function createHostBridge(): HostBridge {
  const api = acquireVsCodeApi();
  const listeners = new Set<(message: HostToWebviewMessage) => void>();

  window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
    for (const listener of listeners) {
      listener(event.data);
    }
  });

  return {
    post: (message) => api.postMessage(message),
    setState: (state) => api.setState(state),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

