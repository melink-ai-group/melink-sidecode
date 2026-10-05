import type { ContextView } from './context/contextView';
import type {
  ChangeDecisionResult,
  ChangeHunkView,
  ChangeView,
  ConflictResolution
} from './changes/changeStore';
import type {
  CheckpointConflictResolution,
  CheckpointView,
  RestoreCheckpointResult
} from './changes/checkpoint';
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRule,
  Attachment,
  BackendAvailability,
  BackendModel,
  BackendStatus,
  ChangeEntry,
  DefaultMode,
  ModelCapabilities,
  ModelSettingField,
  ModelSettingOverrides,
  PermissionLevel,
  PlanArtifact,
  ResolvedModelSettings,
  ThinkingLevel,
  ThreadSummary,
  TodoStep,
  TodoStepStatus,
  QuestionAnswer,
  QuestionRequest,
  TranscriptItem
} from './backends/types';

/**
 * The project-context defaults type, re-exported from the host-free module so
 * the webview names the same shape the snapshot path consumes.
 */
export type { ContextSettings } from './context/contextSettings';

/**
 * Webview <-> extension host message protocol.
 *
 * These types deliberately import only from `backends/types`, so the webview
 * never sees a provider-specific shape. The host is the only side allowed to
 * touch an adapter.
 */

/** App-level defaults a conversation starts from; overridable per conversation. */
export type { PermissionLevel } from './backends/types';
/** The one mode enum, re-exported so every surface names it once. */
export type { DefaultMode } from './backends/types';
export type { PlanArtifact, TodoStep, TodoStepStatus } from './backends/types';
export type { QuestionAnswer, QuestionRequest } from './backends/types';
/**
 * The provider-agnostic model capability vocabulary, re-exported so the webview
 * names the descriptor without reaching into the backend contract for it.
 */
export type {
  CapabilityState,
  ContextWindowCapability,
  ModelCapabilities,
  ModelSettingField,
  ModelSettingOverrides,
  ResolvedModelSettings,
  ThinkingLevel
} from './backends/types';
/** Every thinking level, so a picker can be built generically from the shared list. */
export { THINKING_LEVELS } from './backends/types';

/**
 * The settings screen's read model. The stored token is never included: only
 * `hasToken`, so the value can never be rendered back into the DOM.
 */
export interface SettingsSnapshot {
  target: 'workspace' | 'global';
  ollama: {
    baseUrl: string;
    defaultModel: string;
    hasToken: boolean;
    status: BackendStatus;
    detail?: string;
  };
  codex: {
    path: string;
    defaultModel: string;
    status: BackendStatus;
    detail?: string;
    /** The server-reported version, present only when `status` is `incompatible`. */
    version?: string;
    /**
     * The auth method the CLI last reported (for example `chatgpt` or `apikey`),
     * when it reported one. Text only; never a credential value.
     */
    authMode?: string;
  };
  /**
   * The optional opencode agentic runtime for Ollama. Reported separately from
   * `ollama.status`: the token can be valid while the CLI is absent, and the
   * setting can be off while the CLI is present, so the three states the screen
   * shows are not a single backend availability.
   */
  opencode: {
    enabled: boolean;
    path: string;
    status: 'detected' | 'missing' | 'not-runnable';
    /** Present only when `status` is `detected`. */
    version?: string;
  };
  defaults: {
    permissionLevel: PermissionLevel;
    mode: DefaultMode;
    thinking?: ThinkingLevel;
    /** Ollama model id that cleans dictated speech. Empty disables the microphone. */
    dictationModel: string;
  };
  /**
   * The project-context defaults. The screen reads and writes exactly the keys
   * the snapshot and injection paths read, so a control is never inert.
   */
  context: ContextSettingsSnapshot;
  /** Live model lists for the default-model picker, per backend id. */
  models: Record<string, BackendModel[]>;
  /**
   * Field-keyed messages the host refused on the most recent save, echoed so the
   * screen can mark the value not saved inline. Absent when the last save was
   * accepted; a field with a message was never persisted.
   */
  saveErrors?: Partial<Record<keyof SettingsPatch, string>>;
}

/**
 * The project-context read model. `defaultMaxBytes` is the documented default so
 * the panel can show the resolved default beside the editable cap, and
 * `minMaxBytes`/`maxMaxBytes` are the accepted range for inline validation.
 */
export interface ContextSettingsSnapshot {
  includeInstructions: boolean;
  includeShape: boolean;
  includeEditorState: boolean;
  includeSelection: boolean;
  includeChangedFiles: boolean;
  maxBytes: number;
  /** The documented overall byte cap, shown as the resolved default. */
  defaultMaxBytes: number;
  minMaxBytes: number;
  maxMaxBytes: number;
  /** Extra glob patterns, additive to the built-in ignore set. */
  exclude: string[];
}

/** Fields the settings screen may persist. Every field is optional. */
export interface SettingsPatch {
  ollamaBaseUrl?: string;
  ollamaDefaultModel?: string;
  codexPath?: string;
  codexDefaultModel?: string;
  permissionLevel?: PermissionLevel;
  mode?: DefaultMode;
  thinking?: ThinkingLevel | '';
  /** Ollama model id for dictation cleanup. Empty clears the choice. */
  dictationModel?: string;
  opencodeEnabled?: boolean;
  opencodePath?: string;
  contextIncludeInstructions?: boolean;
  contextIncludeShape?: boolean;
  contextIncludeEditorState?: boolean;
  contextIncludeSelection?: boolean;
  contextIncludeChangedFiles?: boolean;
  contextMaxBytes?: number;
  contextExclude?: string[];
}

/**
 * The permission read model for one backend, so the picker only offers levels
 * the backend can actually serve and knows which one needs confirmation.
 */
export interface PermissionOption {
  level: PermissionLevel;
  label: string;
  description: string;
  /** True for a level that widens permissions and must be confirmed. */
  requiresConfirmation: boolean;
}

export interface PermissionSnapshot {
  backendId: string;
  /** True when this backend has an approval channel to surface. */
  hasApprovalChannel: boolean;
  options: PermissionOption[];
  selected: PermissionLevel;
  /**
   * Increases every time the host stores a new selection. A snapshot older
   * than the level the webview already applied is ignored, so a late refresh
   * cannot put the previous level back.
   */
  epoch: number;
  /** Stored `always` rules, so they can be listed and revoked. */
  rules: ApprovalRule[];
}

/** One mode a backend honours, as offered to the UI. */
export interface ModeOption {
  mode: DefaultMode;
  label: string;
  description: string;
}

/**
 * The mode read model for one backend. Only the modes the backend reports are
 * offered, so a mode that would silently behave like Agent is never shown.
 */
export interface ModeSnapshot {
  backendId: string;
  options: ModeOption[];
  /** The mode the active conversation runs in, or the default before one exists. */
  selected: DefaultMode;
}

/**
 * Result of an on-demand authenticated call. `outcome` lets the UI name the
 * failure precisely instead of showing a raw stack or status code.
 */
export type ConnectionTestOutcome = 'ok' | 'invalid-key' | 'host' | 'network' | 'provider' | 'unavailable';

export interface ConnectionTestResult {
  backendId: string;
  outcome: ConnectionTestOutcome;
  /** Plain-language sentence for the result strip. Never includes the token. */
  message: string;
}

/**
 * The capability + effective-settings read model for one model.
 *
 * It carries the provider-agnostic descriptor and the resolved values, both in
 * the neutral vocabulary, so the UI can render or hide a control without knowing
 * which provider supplied the data. `isOverridden` drives the reset affordance.
 */
export interface ModelCapabilitySnapshot {
  providerId: string;
  modelId: string;
  /** The provider-agnostic descriptor, or `undefined` when the model is unknown. */
  capabilities?: ModelCapabilities;
  /** Effective settings resolved override > provider default > app default. */
  settings: ResolvedModelSettings;
}

/** One open chat in the sidebar tab strip. */
export interface ChatTabView {
  id: string;
  title: string;
  active: boolean;
  backendId?: string;
  threadId?: string;
}

export type HostToWebviewMessage =
  | { type: 'snapshot'; availability: BackendAvailability[] }
  | { type: 'models'; backendId: string; models: BackendModel[]; error?: string }
  | { type: 'agentEvent'; event: AgentEvent }
  | { type: 'busy'; value: boolean; backendId?: string; threadId?: string }
  /** Restore lifecycle: the input stays disabled until this reports `done`. */
  | { type: 'restoring'; value: boolean }
  /** The conversation now active in the host, so the webview can mirror it. */
  | {
      type: 'conversation';
      backendId: string;
      threadId?: string;
      model?: string;
      permissionLevel?: PermissionLevel;
      mode?: DefaultMode;
      replay?: TranscriptItem[];
      /**
       * The approval still blocking the active thread, when one is open. Carried
       * so a webview reload repaints exactly one pending prompt rather than none
       * or a stale duplicate.
       */
      pendingApproval?: ApprovalRequest;
      /**
       * The clarifying question still waiting on this thread. A reload repaints
       * the card above the composer instead of losing it.
       */
      pendingQuestion?: QuestionRequest;
      /** The thread's plan, so a resumed thread reopens its plan surface. */
      plan?: PlanArtifact;
      /**
       * A send that had to open a thread keeps the optimistic user line. A
       * normal conversation switch still replaces the transcript.
       */
      keepPendingUserMessage?: boolean;
    }
  | { type: 'threads'; backendId: string; threads: ThreadSummary[] }
  /** Open sidebar chat tabs. The webview paints the strip and shows the active one. */
  | { type: 'chatTabs'; tabs: ChatTabView[] }
  | { type: 'settings'; settings: SettingsSnapshot }
  | { type: 'permissions'; permissions: PermissionSnapshot }
  | { type: 'modes'; modes: ModeSnapshot }
  /** The active conversation's plan, whenever it is created or revised. */
  | { type: 'plan'; plan: PlanArtifact }
  | { type: 'connectionTest'; result: ConnectionTestResult }
  /** Result of `opencode upgrade`. `pending` is true while the CLI is still running. */
  | { type: 'opencodeUpgrade'; pending: boolean; ok?: boolean; message?: string }
  /**
   * Result of downloading the opencode CLI. `path` is the installed binary when
   * the install succeeded, so the settings field can adopt it.
   */
  | { type: 'opencodeInstall'; pending: boolean; ok?: boolean; message?: string; path?: string }
  /** The capability descriptor + effective settings for one provider+model. */
  | { type: 'modelCapability'; capability: ModelCapabilitySnapshot }
  /**
   * The capability read for a model could not complete. Carries the model it
   * was for, so the panel only reacts when that model is still selected, and a
   * plain-language message the panel shows instead of stale values.
   */
  | { type: 'modelCapabilityError'; providerId: string; modelId: string; message: string }
  /**
   * Files the host picked or read from the clipboard. `requestId` echoes the
   * request so the composer can ignore a stale response. `cancelled` reports a
   * dismissed picker, which is not an error.
   */
  | { type: 'attachmentsPicked'; requestId: string; attachments: Attachment[]; cancelled?: boolean }
  /**
   * An attach or paste failure the composer surfaces inline. The message is
   * plain language and never names a file path or its contents. `requestId` is
   * present when it answers an `attachFiles`/`readClipboard` request.
   */
  | { type: 'attachmentError'; message: string; requestId?: string }
  /** Cleaned dictation text. `requestId` matches the mic session; a stale id is ignored. */
  | { type: 'dictationCleaned'; requestId: string; text: string }
  /** Dictation failed. `raw` is the transcript when cleanup failed after speech was heard. */
  | { type: 'dictationError'; requestId: string; message: string; raw?: string }
  /** Progress for recording, model download, transcription, or cleanup. */
  | { type: 'dictationStatus'; requestId: string; message: string }
  | {
      type: 'notice';
      level: 'info' | 'warning' | 'error';
      message: string;
      /** Optional one-click recovery affordance, e.g. re-entering a token. */
      action?: 'setToken' | 'clearToken' | 'refresh';
    }
  /**
   * The project-context read model for the composer strip and its inline
   * inspect panel. Built by the host from the same snapshot a turn is sent
   * with, so the panel never shows context the next turn would not carry.
   */
  | {
      type: 'context';
      view: ContextView;
      settingsEnabled: boolean;
      exclusions: string[];
      /** Whether the file the user is viewing is included on the next turn. */
      includeViewedFile: boolean;
      /**
       * Open workspace folders. Chat cards use these to show a project path
       * instead of a path that starts at the drive root.
       */
      workspaceRoots?: string[];
    }
  /**
   * The files the thread has changed, pushed on turn end and on webview reload.
   *
   * `entries` is the net of every observed turn in the thread, not only `turnId`.
   * A plan runs one turn per step, and a later step must not hide the files an
   * earlier step wrote. `turnId` is the newest observed turn, which is the turn
   * the review snapshot is addressed by. An empty array means the host verified
   * the thread nets to no file changes (a real no-op), never that it failed to
   * observe. When no change could be observed at all, the host sends no
   * `changes/changed` message rather than an empty one, so the UI never
   * mistakes silence for a verified no-op.
   */
  | { type: 'changes/changed'; backendId: string; threadId: string; turnId: string; entries: ChangeEntry[] }
  /**
   * The post-hoc review snapshot for a turn: every recorded file, its diff, and
   * the decisions made so far. Pushed through one helper so the change-review
   * surface has exactly one repaint path, mirroring `postPermissions`. The
   * webview only consumes this; the review UI itself is a later ticket.
   */
  | { type: 'changes/review'; review: ChangeView }
  /**
   * Hunk lines for one expanded file. The review snapshot omits line bodies so
   * a large turn does not paint every diff up front.
   */
  | { type: 'changes/hunks'; turnId: string; path: string; hunks: ChangeHunkView[]; truncated: boolean }
  /**
   * The result of a decision request. Carries one outcome per file, so a
   * partial failure (a refused write, a conflict) is surfaced rather than
   * hidden. `message` is a plain-language sentence for a notice when any file
   * failed; absent when every file succeeded.
   */
  | { type: 'changes/decisionResult'; results: ChangeDecisionResult[]; message?: string }
  /**
   * The per-message checkpoints a thread offers: one entry per user message whose
   * turn touched files, newest first. A message whose turn touched nothing is
   * absent, so no empty checkpoint is ever offered. `files` is carried for the
   * confirmation so the affected paths are shown before anything is reverted.
   */
  | { type: 'changes/checkpoints'; backendId: string; threadId: string; checkpoints: CheckpointView[] }
  /**
   * The outcome of a checkpoint restore: per-file results and whether the
   * operation was complete, partial, or aborted. Restoring reverts files only;
   * the transcript is never altered, which the UI copy must state explicitly.
   */
  | { type: 'changes/restoreResult'; result: RestoreCheckpointResult }
  /** A Plan or Agent question card. Replaces any card already on screen. */
  | { type: 'question/asked'; request: QuestionRequest }
  /** The card was answered, skipped, or the turn that raised it was stopped. */
  | { type: 'question/cleared' };


export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  /**
   * Ask for a fresh project-context snapshot on demand. The next turn reflects
   * the current workspace (active file, selection, changed files) with no window
   * reload. Distinct from `refresh`, which re-probes backend availability.
   */
  | { type: 'refreshContext' }
  /**
   * Turn one item or whole category off for the next turn. The host applies the
   * set to the snapshot it sends and echoes the reduced view, so the strip and
   * the turn always agree. Nothing is re-added without the user asking.
   */
  | { type: 'setContextExclusions'; keys: string[] }
  /** Restore the default context set, dropping every per-turn exclusion. */
  | { type: 'resetContextExclusions' }
  /**
   * Include or remove the file open in the editor. Off by default. The host
   * echoes the choice on the next context view.
   */
  | { type: 'setIncludeViewedFile'; included: boolean }
  /** Open a context file in the editor (the active file named in the strip). */
  | { type: 'openContextFile'; path: string }
  | { type: 'openSettings' }
  | { type: 'setToken'; backendId: string }
  | { type: 'clearToken'; backendId: string }
  | { type: 'listModels'; backendId: string }
  | {
      type: 'startThread';
      backendId: string;
      model?: string;
      permissionLevel?: PermissionLevel;
      /** Mode the new thread starts in; falls back to the stored default. */
      mode?: DefaultMode;
      /**
       * Effective per-model settings the host resolved and clamped. The webview
       * never computes these itself; an absent field means the provider default.
       */
      modelSettings?: ModelSettingOverrides;
    }
  | {
      type: 'sendTurn';
      text: string;
      /** Backend the composer has selected. The host opens a thread there when the active one differs. */
      backendId?: string;
      model?: string;
      permissionLevel?: PermissionLevel;
      /** Effective per-model settings, already clamped by the host. */
      modelSettings?: ModelSettingOverrides;
      /** Files attached to this turn; carried on the outgoing message. */
      attachments?: Attachment[];
      /**
       * True when this turn should replace the plan document. Set by Ask for
       * changes. Composer text that asks to revise the plan is detected on
       * the host as well.
       */
      updatePlan?: boolean;
    }
  | { type: 'steerTurn'; text: string }
  /** Open the microphone. The host answers with status, then a cleaned or failed transcript. */
  | { type: 'startDictation'; requestId: string }
  /** Stop the microphone and transcribe what was recorded. */
  | { type: 'stopDictation'; requestId: string }
  /**
   * Ask the host to open a native file picker for attachments. The host answers
   * with `attachmentsPicked` (or `attachmentError`) carrying the same
   * `requestId`, so a dismissed or failed pick is data, never a silent no-op.
   */
  | { type: 'attachFiles'; requestId: string }
  /**
   * Fallback for a paste the webview cannot read bytes for (e.g. a non-image
   * clipboard item). The host reads the OS clipboard and answers like a pick.
   */
  | { type: 'readClipboard'; requestId: string }
  | { type: 'cancelTurn' }
  /**
   * Compact the active thread. The webview sends the fill it is showing; the
   * host compacts only while idle and only when that fill is above 25%.
   */
  | { type: 'compactContext'; usedTokens: number; maxTokens: number }
  | { type: 'listThreads'; backendId: string }
  | { type: 'resumeThread'; backendId: string; threadId: string }
  /** Open another sidebar chat tab. An existing blank tab is focused instead of stacking another. */
  | { type: 'newChat' }
  /** Show the sidebar tab for this thread, or open one and resume it. */
  | { type: 'openThread'; backendId: string; threadId: string }
  /** Bring one open sidebar chat tab to the front. */
  | { type: 'selectChatTab'; tabId: string }
  /** Close one sidebar chat tab. The thread stays in history. */
  | { type: 'closeChatTab'; tabId: string }
  /** Drag a sidebar chat tab to a new index among the open tabs. */
  | { type: 'reorderChatTab'; tabId: string; toIndex: number }
  | { type: 'getSettings' }
  | { type: 'saveSettings'; patch: SettingsPatch }
  | { type: 'setOllamaToken'; value: string }
  | { type: 'clearOllamaToken' }
  | { type: 'testConnection'; backendId: string }
  /** Run `opencode upgrade` when the CLI is connected. */
  | { type: 'upgradeOpencode' }
  /** Download and install the opencode CLI when it was not detected. */
  | { type: 'installOpencode' }
  /** A decision on a pending approval. Never sent by a timer or a retry. */
  | { type: 'decideApproval'; backendId: string; threadId: string; requestId: string; decision: ApprovalDecision }
  /**
   * The finished choice card. One entry per question, in ask order. The host
   * either continues the turn or answers the native request.
   */
  | { type: 'answerQuestion'; requestId: string; answers: QuestionAnswer[] }
  /** Read the permission options + stored rules for one backend. */
  | { type: 'getPermissions'; backendId: string }
  /** Read the mode options + current mode for one backend. */
  | { type: 'getModes'; backendId: string }
  /** Open the active thread's plan file in the editor (workspace-relative path). */
  | { type: 'openPlanFile' }
  /** Revoke one stored `always` rule. */
  | { type: 'revokeApprovalRule'; backendId: string; ruleId: string }
  /**
   * Select the mode for the backend the user is driving. Applies to the next
   * turn only: the existing transcript is never mutated or invalidated.
   * Persisted on the active thread when that thread belongs to `backendId`.
   */
  | { type: 'selectMode'; mode: DefaultMode; backendId?: string }
  /**
   * Select the permission level for the next turn and for later conversations.
   * The host stores it, so a new chat keeps the choice. `unrestricted` is only
   * posted after the labelled confirmation.
   */
  | { type: 'selectPermission'; level: PermissionLevel }
  /**
   * Build the plan. Moves the thread into execution (mode returns to `agent`)
   * and seeds the todo list from the plan's bullet list. This is the only route
   * from Plan mode to a write path.
   */
  | { type: 'buildPlan' }
  /** Reject the plan; leaves the workspace unchanged apart from the plan file. */
  | { type: 'rejectPlan' }
  /**
   * Create or revise a thread's plan file. The host writes the markdown at the
   * documented per-thread path; creating it is the one permitted write in Plan
   * mode. A revision updates the same file rather than creating a second plan.
   */
  | { type: 'writePlan'; title: string; summary?: string; body?: string; steps: TodoStep[] }
  /** Set one tracked todo step's status; persisted so a reload keeps progress. */
  | { type: 'setTodoStepStatus'; step: string; status: TodoStepStatus }
  /**
   * Read the capability descriptor + effective settings for one provider+model.
   * The host resolves them (override > provider default > app default) and
   * returns both in the neutral vocabulary; the webview only renders.
   */
  | { type: 'getModelCapability'; providerId: string; modelId: string }
  /**
   * Persist a per-model override. The host clamps it against the model's
   * reported range before storing, then echoes the resolved settings back.
   */
  | { type: 'setModelSettings'; providerId: string; modelId: string; settings: ModelSettingOverrides }
  /** Clear every override for one model, so it falls back to provider defaults. */
  | { type: 'resetModelSettings'; providerId: string; modelId: string }
  /**
   * Clear one field's override only, so the per-control reset returns exactly
   * that control to its default without disturbing the other field.
   */
  | { type: 'resetModelSettingField'; providerId: string; modelId: string; field: ModelSettingField }
  /**
   * Read the post-hoc review snapshot for a turn. The host answers through the
   * same `postChangeReview` path every other change surface uses, so a reload
   * and an on-demand read can never disagree.
   */
  | { type: 'changes/list'; backendId: string; threadId: string; turnId: string }
  /** Load hunk lines for one expanded file. The host answers with `changes/hunks`. */
  | { type: 'changes/hunks'; backendId: string; threadId: string; turnId: string; path: string }
  /**
   * Decide one file, or one hunk of it. Never sent by a timer: the host records
   * the decision and, for a reject, writes the workspace file. An explicit
   * `conflictResolution` is required only when the host reported a conflict.
   */
  | {
      type: 'changes/decide';
      backendId: string;
      threadId: string;
      turnId: string;
      path: string;
      hunkId?: string;
      decision: 'accepted' | 'rejected';
      conflictResolution?: ConflictResolution;
    }
  /**
   * Decide every file in a turn. All files are attempted and every outcome is
   * reported, so an accept-all or reject-all is never claimed to have fully
   * succeeded when some files failed.
   */
  | {
      type: 'changes/decideAll';
      backendId: string;
      threadId: string;
      turnId: string;
      decision: 'accepted' | 'rejected';
      conflictResolution?: ConflictResolution;
    }
  /**
   * Read the per-message checkpoints for a thread, so the per-message entry
   * point can offer exactly the messages whose turn touched files.
   */
  | { type: 'changes/listCheckpoints'; backendId: string; threadId: string }
  /**
   * Restore a checkpoint, reverting the affected files to their checkpoint
   * content. The transcript and message list are never modified. Never sent by
   * a timer: the host requires the caller to have confirmed, and a conflicting
   * file requires an explicit `conflictResolution` to be overwritten.
   */
  | {
      type: 'changes/restoreCheckpoint';
      backendId: string;
      threadId: string;
      /** The user message whose checkpoint is restored. */
      messageId?: string;
      /** A captured restore point, used to undo a previous restore. */
      restorePointId?: string;
      conflictResolution?: CheckpointConflictResolution;
    }
  /**
   * Open one changed file in the built-in diff editor, with the journal's
   * pre-turn content on the left and the working file on the right. Read-only:
   * the left side is served by the `melink-changes:` content provider, never a
   * temp file. The host degrades to opening the working file with an
   * explanatory message when the turn is no longer recorded.
   */
  | { type: 'changes/openDiff'; backendId: string; threadId: string; turnId: string; path: string }
  /**
   * Open the whole turn in the built-in multi-file changes editor, listing every
   * changed path so the user can walk file to file. Read-only, same provider.
   */
  | { type: 'changes/openView'; backendId: string; threadId: string; turnId: string }
  /**
   * Reveal one changed file in the Source Control view. The final fallback when
   * the native diff views are unavailable; the turn's changes are not a
   * source-control provider, so this opens the view rather than adding a row.
   */
  | { type: 'changes/reveal'; path?: string };

/** Re-exported so the webview names the review read model without reaching in. */
export type { ChangeView, ChangeFileView, ChangeHunkView, ChangeDecision, ChangeDecisionResult, ConflictResolution } from './changes/changeStore';
/** Re-exported so the checkpoint entry point names its read model without reaching in. */
export type { CheckpointConflictResolution, CheckpointView, RestoreCheckpointResult, RestoreFileResult } from './changes/checkpoint';

/** Re-exported so the settings screen can build a permission picker generically. */
export type { ApprovalDecision, ApprovalRequest, ApprovalRule };

/**
 * Attachment vocabulary, re-exported so the composer names the chip shape
 * without reaching into the backend contract for it.
 */
export type { Attachment, AttachmentKind } from './backends/types';

/*
 * Project context. The snapshot crosses to the webview as typed protocol data
 * only: it is provider-neutral by construction and names no adapter concept, so
 * the webview can render the workspace picture without reaching into the host.
 * Ticket 2 delivers this to each backend; the composer and settings tickets
 * surface and control it.
 */
export type { ContextView, ContextCategoryId, ContextCategoryView, ContextItemView, ContextStatus } from './context/contextView';
/**
 * The one exclusion-key vocabulary, re-exported so the webview and the host
 * agree on exactly which key toggles which item.
 */
export { applyViewExclusions, categoryExclusionKey, itemExclusionKey } from './context/contextView';
export type {
  ActiveEditorState,
  ContextInvalidation,
  DirectoryNode,
  EditorSelection,
  EditorState,
  ExcludedPath,
  ExclusionReason,
  InstructionDocument,
  InstructionDocs,
  LanguageCount,
  ManifestHit,
  OpenEditor,
  ProjectDelta,
  ProjectShape,
  ProjectSnapshot,
  WorkspaceIdentity
} from './context/projectContext';
