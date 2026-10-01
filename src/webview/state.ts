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
import type {
  ConnectionTestResult,
  ContextView,
  ChangeView,
  ChangeDecisionResult,
  CheckpointView,
  RestoreCheckpointResult,
  HostToWebviewMessage,
  ModeSnapshot,
  ModelCapabilitySnapshot,
  ModelSettingField,
  PermissionSnapshot,
  PlanArtifact,
  SettingsSnapshot,
  WebviewToHostMessage
} from '../protocol';

/** Lifecycle of one transcript item, driving its status affordance. */
export type ItemStatus = 'streaming' | 'completed' | 'failed' | 'warning' | 'canceled' | 'pending';

export interface TranscriptItemView {
  id: string;
  kind: TranscriptItemKind;
  /** Backend the item came from; drives the provider dot, never the renderer. */
  backendId?: string;
  role?: 'user' | 'assistant' | 'system';
  title?: string;
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
  text: string;
  status: ItemStatus;
}

export type NoticeAction = 'setToken' | 'clearToken' | 'refresh';

export interface AppState {
  availability: BackendAvailability[];
  models: Record<string, BackendModel[]>;
  /** Per-backend `listModels()` failure, so the picker can offer a retry. */
  modelErrors: Record<string, string>;
  threads: Record<string, ThreadSummary[]>;
  /** Live activity and unread replies keyed by backend and thread identity. */
  threadActivity: Record<string, { busy: boolean; unread: boolean }>;
  threadLoading: Record<string, boolean>;
  selectedBackendId?: string;
  selectedModel?: string;
  /** Permission level the active conversation runs at. */
  permissionLevel: PermissionLevel;
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
  /** True while the labelled confirmation for an unrestricted level is shown. */
  permissionConfirmationOpen: boolean;
  /** True while the always-allow rules surface is open for review/revocation. */
  rulesOpen: boolean;
  /**
   * Files attached to the pending message; cleared on send or new conversation.
   * Each chip is removable before the turn leaves the composer.
   */
  attachments: Attachment[];
  /**
   * An inline composer message for a failed or refused attach/paste. Never a
   * file path or content; dismissed when the user acts or removes a chip.
   */
  attachmentError?: string;
  notice?: { level: 'info' | 'warning' | 'error'; message: string; action?: NoticeAction };
  /** True while the settings screen is open (inline surface, never a popover). */
  settingsOpen: boolean;
  /** The settings read model, present once the host has answered `getSettings`. */
  settings?: SettingsSnapshot;
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
  /**
   * The project-context read model the composer renders. Built and pushed by the
   * host; the webview never recomputes it. `undefined` until the first push, so
   * the strip is simply absent rather than guessing a workspace.
   */
  contextView?: ContextView;
  /**
   * False when every context category is disabled in settings, so the strip can
   * say context is off rather than reading as a workspace with nothing in it.
   */
  contextSettingsEnabled: boolean;
  /** Local, next-turn-only exclusions the user set from the panel. */
  contextExclusions: string[];
  /**
   * The files the most recent turn recorded, or `undefined` when no change set
   * has been verified for the active thread. `undefined` is distinct from `[]`:
   * an empty array is a verified no-op, while `undefined` means nothing was
   * observed and no claim is being made.
   */
  changes?: ChangeEntry[];
  /** The turn the current `changes` set belongs to. */
  changesTurnId?: string;
  /**
   * The post-hoc review snapshot for the active turn, when the host pushed one.
   * `undefined` means no review has been read; the review UI is a later ticket,
   * so this is carried as data only and never inferred.
   */
  changeReview?: ChangeView;
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
  changeRejectConfirm?: { scope: 'file' | 'all'; paths: string[] };
  /**
   * True while a decision request is in flight, so the review surface disables
   * its controls rather than accepting a second, racing decision.
   */
  changeDeciding: boolean;
  /**
   * The per-message checkpoints for the active thread, newest first. A message
   * whose turn touched no files is absent, so no empty checkpoint is offered.
   */
  checkpoints?: CheckpointView[];
  /** The most recent restore outcome, so a partial restore is surfaced. */
  restoreResult?: RestoreCheckpointResult;
  /**
   * The checkpoint awaiting an explicit confirmation before any file is
   * reverted. Restoring is destructive and never implicit, so the affected file
   * count and paths are shown here first.
   */
  restoreConfirmation?: { messageId: string; fileCount: number; paths: string[] };
}

export type Action =
  | { type: 'snapshot'; availability: BackendAvailability[] }
  | { type: 'models'; backendId: string; models: BackendModel[]; error?: string }
  | { type: 'clearModels'; backendId: string }
  | { type: 'threadsLoading'; backendId: string; value: boolean }
  | { type: 'threads'; backendId: string; threads: ThreadSummary[] }
  | { type: 'selectBackend'; backendId: string }
  | { type: 'selectModel'; model: string }
  | { type: 'agentEvent'; event: AgentEvent }
  | { type: 'localUserMessage'; text: string; attachments?: Attachment[] }
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
      plan?: PlanArtifact;
    }
  | { type: 'restoring'; value: boolean }
  | { type: 'busy'; value: boolean; backendId?: string; threadId?: string }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string; action?: NoticeAction }
  | { type: 'dismissNotice' }
  /** Add picked/pasted files to the pending message; duplicates are ignored. */
  | { type: 'addAttachments'; attachments: Attachment[] }
  /** Remove one chip before sending. */
  | { type: 'removeAttachment'; id: string }
  /** Surface an attach/paste failure inline in the composer. */
  | { type: 'attachmentError'; message: string }
  | { type: 'dismissAttachmentError' }
  | { type: 'refresh' }
  | { type: 'openSettings' }
  | { type: 'closeSettings' }
  | { type: 'settings'; settings: SettingsSnapshot }
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
  /** The host's project-context read model, pushed on every relevant change. */
  | { type: 'context'; view: ContextView; settingsEnabled: boolean; exclusions: string[] }
  /** Toggle one item or category off for the next turn (or back on). */
  | { type: 'toggleContextExclusion'; key: string }
  /** Restore the default context set for the next turn. */
  | { type: 'resetContextExclusions' }
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
  | { type: 'changesChanged'; backendId: string; threadId: string; turnId: string; entries: ChangeEntry[] }
  /** The host's post-hoc review snapshot for a turn. */
  | { type: 'changeReview'; review: ChangeView }
  /** The outcome of a decision request, so a partial failure is surfaced. */
  | { type: 'changeDecision'; results: ChangeDecisionResult[]; message?: string }
  /** The per-message checkpoints the host offers for the active thread. */
  | { type: 'checkpoints'; checkpoints: CheckpointView[] }
  /** The outcome of a checkpoint restore, so a partial restore is surfaced. */
  | { type: 'restoreResult'; result: RestoreCheckpointResult }
  /** Open the confirmation for one checkpoint, showing its affected files. */
  | { type: 'requestRestoreConfirmation'; messageId: string; fileCount: number; paths: string[] }
  | { type: 'cancelRestoreConfirmation' }
  /**
   * Open the destructive reject confirmation for one file or the whole turn.
   * Rejecting writes to disk, so the paths are named before anything is posted.
   */
  | { type: 'requestChangeRejectConfirmation'; scope: 'file' | 'all'; paths: string[] }
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
  permissionLevel: 'default',
  mode: 'agent',
  transcript: [],
  busy: false,
  startingTurn: false,
  restoring: true,
  settingsOpen: false,
  permissionConfirmationOpen: false,
  rulesOpen: false,
  planRevising: false,
  rejectConfirmationOpen: false,
  attachments: [],
  modelCapabilityStatus: 'idle',
  contextSettingsEnabled: true,
  contextExclusions: [],
  changeDeciding: false
};

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'snapshot': {
      const selected =
        state.selectedBackendId && action.availability.some((b) => b.id === state.selectedBackendId)
          ? state.selectedBackendId
          : action.availability.find((b) => b.status === 'available')?.id;
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
    case 'threadsLoading':
      return { ...state, threadLoading: { ...state.threadLoading, [action.backendId]: action.value } };
    case 'selectBackend':
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
      return {
        ...state,
        selectedModel: action.model,
        // Same rule as a backend switch: a new model resolves its own defaults,
        // and the previous model's values are never shown against it.
        modelCapability: undefined,
        modelCapabilityStatus: 'loading',
        modelCapabilityError: undefined
      };
    case 'localUserMessage':
      return {
        ...state,
        attachments: [],
        attachmentError: undefined,
        transcript: [
          ...state.transcript,
          {
            id: `local_${state.transcript.length}_${Date.now()}`,
            kind: 'message',
            role: 'user',
            attachments: action.attachments,
            text: action.text,
            status: 'completed'
          }
        ]
      };
    case 'conversation': {
      const replay = action.replay ? action.replay.map(toTranscriptItemView(action.backendId)) : [];
      // Exactly one pending prompt per request: drop any replayed
      // `approval-requested` card that is not the still-open request, then
      // re-inject the live one so a reload can never show none or two.
      const transcript = reconcilePendingItems(
        replay,
        action.backendId,
        action.threadId,
        action.pendingApproval
      );
      const nextModel = action.model ?? state.selectedModel;
      const activityKey = action.threadId ? `${action.backendId}:${action.threadId}` : undefined;
      const changedModel = nextModel !== state.selectedModel;
      return {
        ...state,
        selectedBackendId: action.backendId,
        selectedModel: nextModel,
        // A resumed conversation pins a model, so the panel must resolve that
        // model's defaults fresh rather than showing whatever was on screen.
        modelCapability: changedModel ? undefined : state.modelCapability,
        modelCapabilityStatus: changedModel ? 'loading' : state.modelCapabilityStatus,
        modelCapabilityError: changedModel ? undefined : state.modelCapabilityError,
        permissionLevel: action.permissionLevel ?? state.permissionLevel,
        mode: action.mode ?? state.mode,
        activeThreadId: action.threadId,
        busy: activityKey ? Boolean(state.threadActivity[activityKey]?.busy) : false,
        threadActivity: activityKey && state.threadActivity[activityKey]?.unread
          ? { ...state.threadActivity, [activityKey]: { ...state.threadActivity[activityKey], unread: false } }
          : state.threadActivity,
        // A conversation switch discards any pending composer attachments: they
        // belonged to the message the user was about to send in the old one.
        attachments: [],
        attachmentError: undefined,
        // A revision belongs to the plan that was on screen; a switch resets it.
        planRevising: false,
        rejectConfirmationOpen: false,
        pendingApproval: action.pendingApproval
          ? { backendId: action.backendId, threadId: action.threadId ?? '', request: action.pendingApproval }
          : undefined,
        // A replay replaces the transcript; a fresh conversation clears it.
        transcript,
        // A plan is carried with the conversation so a resumed thread reopens it.
        plan: action.plan,
        // A change set belongs to the thread it was recorded for; a switch drops
        // it rather than showing the previous conversation's files against this
        // one. The host re-posts the resumed thread's set right after.
        changes: undefined,
        changesTurnId: undefined,
        // The review snapshot and any destructive confirmation likewise belong to
        // the thread in view; both are cleared so a switch can never show the
        // previous thread's files or act on them.
        changeReview: undefined,
        changeDecision: undefined,
        changeRejectConfirm: undefined,
        changeDeciding: false,
        // Checkpoints and a restore result belong to the thread they were read
        // for; a switch drops them rather than showing the previous thread's.
        checkpoints: undefined,
        restoreResult: undefined,
        restoreConfirmation: undefined
      };
    }
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
      return {
        ...state,
        notice:
          action.action !== undefined
            ? { level: action.level, message: action.message, action: action.action }
            : { level: action.level, message: action.message }
      };
    case 'dismissNotice':
      return { ...state, notice: undefined };
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
    case 'attachmentError':
      return { ...state, attachmentError: action.message };
    case 'dismissAttachmentError':
      return { ...state, attachmentError: undefined };
    case 'refresh':
      // Drop cached model lists so the live `/api/tags` result repopulates the
      // picker; a model removed server-side disappears on the next fetch.
      return { ...state, models: {}, modelErrors: {}, threads: {}, threadLoading: {} };
    case 'openSettings':
      return { ...state, settingsOpen: true };
    case 'closeSettings':
      // Leaving the screen discards a transient test result so re-opening it
      // never shows a stale success or failure.
      return { ...state, settingsOpen: false, connectionTest: undefined };
    case 'settings':
      return { ...state, settings: action.settings };
    case 'permissions':
      return { ...state, permissions: action.permissions, permissionLevel: action.permissions.selected };
    case 'modes':
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
      // Selecting a level only updates the working value. The host persists it
      // when the next turn is sent; the UI is what gates `unrestricted` behind
      // an explicit confirmation before this action is ever dispatched.
      return { ...state, permissionLevel: action.level, permissionConfirmationOpen: false };
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
    case 'context':
      // The host is the single source of truth for both the view and the
      // exclusion set in effect. The local set exists only to make a toggle read
      // immediately; this echo replaces it, so a turn that consumed the
      // exclusions (or a reset) cannot leave a stale one on screen.
      return {
        ...state,
        contextView: action.view,
        contextSettingsEnabled: action.settingsEnabled,
        contextExclusions: action.exclusions
      };
    case 'toggleContextExclusion': {
      const next = state.contextExclusions.includes(action.key)
        ? state.contextExclusions.filter((key) => key !== action.key)
        : [...state.contextExclusions, action.key];
      return { ...state, contextExclusions: next };
    }
    case 'resetContextExclusions':
      return { ...state, contextExclusions: [] };
    case 'changesChanged': {
      // Only the active thread's turn replaces the visible set; a background
      // thread's set must not overwrite what the surface is showing.
      if (state.activeThreadId && state.activeThreadId !== action.threadId) {
        return state;
      }
      // A different turn replaces the visible review. The previous review is
      // dropped here so a turn that changed nothing (`entries: []`) shows no
      // panel at all — not the last turn's rows. A turn that did change files
      // repaints from the review snapshot the reader effect reads next.
      const turnChanged = state.changeReview !== undefined && state.changeReview.turnId !== action.turnId;
      return {
        ...state,
        changes: action.entries,
        changesTurnId: action.turnId,
        ...(turnChanged
          ? { changeReview: undefined, changeDecision: undefined, changeRejectConfirm: undefined, changeDeciding: false }
          : {})
      };
    }
    case 'changeReview':
      // A review belongs to the turn it was recorded for; the host is the only
      // source, so the snapshot replaces whatever was on screen. A background
      // thread's review is ignored, exactly like its `changes/changed` set.
      if (state.activeThreadId && state.activeThreadId !== action.review.threadId) {
        return state;
      }
      return {
        ...state,
        changeReview: action.review,
        // A fresh snapshot supersedes any confirmation opened against the old one.
        changeRejectConfirm: undefined,
        changeDeciding: false
      };
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
      return { ...state, changeRejectConfirm: { scope: action.scope, paths: action.paths } };
    case 'cancelChangeRejectConfirmation':
      return { ...state, changeRejectConfirm: undefined };
    case 'changeDeciding':
      return { ...state, changeDeciding: action.value };
    case 'checkpoints':
      return { ...state, checkpoints: action.checkpoints };
    case 'restoreResult':
      return { ...state, restoreResult: action.result, restoreConfirmation: undefined };
    case 'requestRestoreConfirmation':
      return {
        ...state,
        restoreConfirmation: { messageId: action.messageId, fileCount: action.fileCount, paths: action.paths }
      };
    case 'cancelRestoreConfirmation':
      return { ...state, restoreConfirmation: undefined };
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
      return { ...state, modelCapabilityStatus: 'loading', modelCapabilityError: undefined };
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
    backendId,
    role: item.role,
    title: item.title,
    detail: item.detail,
    command: item.command,
    files: item.files,
    approval: item.approval,
    approvalDecision: item.approvalDecision,
    attachments: item.attachments,
    text: item.text ?? '',
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

function applyAgentEvent(state: AppState, event: AgentEvent): AppState {
  switch (event.type) {
    case 'thread/started':
      return state;
    case 'thread/status/changed':
      // The provider's own thread status is informational: `active` means a turn
      // is running, so the composer stays locked, but a status flap never clears
      // a busy state early — only the turn lifecycle does that.
      if (event.status === 'active' && !state.busy) {
        return { ...state, busy: true };
      }
      return state;
    case 'turn/started':
      // A new turn freezes the review surface rather than discarding it: the
      // panel keeps the last completed turn's rows but renders them pending with
      // their controls locked, so a running turn never shows a settled decision
      // as actionable. The authoritative counts are replaced by a pending strip
      // in the surface itself. Decision bookkeeping for the prior round resets.
      return {
        ...state,
        busy: true,
        startingTurn: true,
        changeDecision: undefined,
        changeRejectConfirm: undefined,
        changeDeciding: false
      };
    case 'item/started':
      // Idempotent per id: a re-sent `item.started` must not open a second card.
      if (state.transcript.some((item) => item.id === event.item.id)) {
        return state;
      }
      return {
        ...state,
        startingTurn: false,
        transcript: [
          ...state.transcript,
          {
            id: event.item.id,
            kind: event.item.kind,
            backendId: event.backendId,
            role: event.item.role,
            title: event.item.title,
            detail: event.item.detail,
            command: event.item.command,
            files: event.item.files,
            approval: event.item.approval,
            text: '',
            status: 'streaming'
          }
        ]
      };
    case 'item/delta':
      return {
        ...state,
        transcript: state.transcript.map((item) =>
          item.id === event.itemId ? { ...item, text: item.text + event.delta } : item
        )
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
    case 'approval/denied':
      // The agent was told explicitly, so the turn does not stall silently.
      return {
        ...state,
        notice: {
          level: 'info',
          message: `${event.subject ? `${event.subject}: ` : ''}the request was denied and the agent was told.`
        }
      };
    case 'error':
      // A backend the user is not currently driving must never surface a status
      // or error: a failed Codex auth attempt stays invisible while Ollama is
      // the selected provider, and vice versa.
      if (state.selectedBackendId && event.backendId !== state.selectedBackendId) {
        return state;
      }
      return { ...state, planRevising: false, notice: noticeForError(event) };
    case 'turn/interrupted':
      if (event.canceled) {
        return {
          ...state,
          busy: false,
          startingTurn: false,
          pendingApproval: undefined,
          planRevising: false,
          transcript: markStreamingItems(state.transcript, 'canceled'),
          notice: { level: 'info', message: event.reason ?? 'Response stopped.' }
        };
      }
      return {
        ...state,
        busy: false,
        startingTurn: false,
        pendingApproval: undefined,
        planRevising: false,
        transcript: markStreamingItems(state.transcript, 'warning'),
        notice: event.reason ? { level: 'warning', message: event.reason } : state.notice
      };
    case 'turn/completed':
      // A finished turn cannot still be blocking on an approval; a card that
      // somehow survived is stale, so it is dropped rather than left pending. A
      // revision in flight also resolves here if its plan echo was missed.
      return { ...state, busy: false, startingTurn: false, pendingApproval: undefined, planRevising: false };
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
          steps: event.steps,
          built: state.plan?.built,
          updatedAt: Date.now()
        }
      };
    case 'notice':
      // A provider-neutral informational line from a backend (e.g. a degraded
      // session resume), rendered with the existing notice path.
      return { ...state, notice: { level: event.level, message: event.message } };
    default:
      return state;
  }
}

/** The pending-card sentence for a request, in the user's terms. */
export function requestMessage(request: ApprovalRequest): string {
  switch (request.kind) {
    case 'command':
      return request.command ? `The agent wants to run: ${request.command}` : 'The agent wants to run a command.';
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
function noticeForError(event: Extract<AgentEvent, { type: 'error' }>): AppState['notice'] {
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
      return { level: 'error', message: event.message, action: 'refresh' };
    default:
      return { level: 'error', message: event.message, action: 'refresh' };
  }
}

/** Typed wrapper over the VS Code webview message bridge. */
export interface HostBridge {
  post(message: WebviewToHostMessage): void;
  subscribe(listener: (message: HostToWebviewMessage) => void): () => void;
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
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
