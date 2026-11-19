import type {
  ApprovalRequest,
  Attachment,
  DefaultMode,
  ModelSettingOverrides,
  PermissionLevel,
  ThreadHandle,
  TranscriptItem
} from '../backends/types';
import type { QuestionRequest } from '../questions';
import type { HostToWebviewMessage } from '../protocol';
import type { TurnPlan } from '../orchestration/plan.ts';

/** A notice message without its discriminant, so a session can carry it. */
export type NoticeView = Omit<Extract<HostToWebviewMessage, { type: 'notice' }>, 'type'>;

/**
 * One sidebar chat tab. Fields that used to live once on the provider move here
 * so two open conversations do not share a thread, a mode, or a pending prompt.
 */
export interface ChatSession {
  id: string;
  title: string;
  restored: boolean;
  activeThread?: ThreadHandle;
  mode: DefaultMode;
  /** True once this tab's mode was chosen or restored, so a later show does not replace it. */
  modeChosen: boolean;
  /** Permission this chat runs at. Absent until the tab is shown, then kept on the tab. */
  tabPermission?: PermissionLevel;
  /** Model the user picked for this chat. Absent until they pick one or the tab is first shown. */
  composerBackendId?: string;
  composerModelId?: string;
  /** Per-model setting overrides pinned to this chat. */
  modelSettings: Record<string, ModelSettingOverrides>;
  pendingApproval?: ApprovalRequest;
  pendingQuestion?: { source: 'fence' | 'native'; request: QuestionRequest };
  planTurnId?: string;
  nativePlanThisTurn: boolean;
  revisePlanThisTurn: boolean;
  /** Answers already folded into this thread's plan, in ask order. */
  planDecisions: string[];
  planContextExcluded: boolean;
  /** Bumped on a user send so a late autopilot decision cannot start another turn. */
  planEpoch: number;
  /** True when the open turn was started to keep a built plan moving. */
  planRunAutomatic: boolean;
  /** Steps-and-work signature of the previous turn, for the loop check. */
  planRunSignature?: string;
  /** A refused approval this turn must not be retried automatically. */
  planHold: boolean;
  /** Continuations already used since the provider last stopped. A user send resets this. */
  stopContinueAttempts: number;
  pendingTurnMessage?: { messageId: string; backendId: string; threadId: string };
  /** Policy decided once for the send in flight; `turn/started` moves it to the turn. */
  turnPlan?: TurnPlan;
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
  /** True from the moment this tab's send is accepted until that send's promise settles. */
  turnBusy: boolean;
  /** Notice that belongs to this tab and is shown again when the tab is reopened. */
  heldNotice?: { level: 'info' | 'warning' | 'error'; message: string };
  /** A question notice held for a background tab until that tab is painted. */
  questionNotice?: NoticeView;
  /**
   * The webview clears the composer as soon as Send is clicked. When that send
   * is refused, ignore the empty draft that is still in flight.
   */
  ignoreNextEmptyDraft: boolean;
  /** History captured for this tab, oldest first. Absent until a chat is painted. */
  loadedTranscript?: TranscriptItem[];
  /** Index of the first painted row. Rows before it load when the reader scrolls up. */
  historyHidden?: number;
  /** The provider still has rows older than `loadedTranscript`. */
  serverHasOlder?: boolean;
}

/** Open sidebar tabs, so a reload can put the same chats back. */
export const OPEN_CHAT_TABS_KEY = 'melink.openChatTabs';
