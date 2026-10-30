import { Fragment, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react';
import type { ApprovalDecision, ApprovalRule } from '../backends/types';
import { historyEntries, historyLoading } from './historyEntries';
import { reasoningTransition } from './reasoningStatus';
import { pinnedUserMessage, userMessagePinText, type UserMessageFrame } from './pinnedUserMessage';
import { isSubmitEnter } from './keys';
import { acceptComposerRestore, hostAttachments, switchComposerDraft, type ComposerDraft } from './composerDraft';
import {
  AlertIcon,
  ChevronDownIcon,
  HistoryIcon,
  MicSolidIcon,
  PaperclipIcon,
  PlusIcon,
  SlidersIcon,
  SendSolidIcon,
  StopSolidIcon
} from './Icons';
import { SettingsScreen } from './SettingsScreen';
import { SendButton } from './composer/SendButton';
import { ContextMeter, ContextStrip } from './ContextStrip';
import { ChangesReview } from './ChangesReview';
import { ChangedFilesStrip } from './ChangedFilesStrip';
import { showBuiltPlanDock } from '../backends/plan';
import { continueAfterStopInstruction } from '../backends/threadRecovery';
import { PlanSurface } from './PlanSurface';
import { estimateConversationTokens, modelSettingsView } from './modelControls';
import {
  initialState,
  pendingApproval,
  reduce,
  skillToggleAction,
  visibleModeSnapshot,
  type ItemStatus,
  type NoticeAction,
  type TranscriptItemView,
  type TurnChange
} from './state';
import { attentionFollowUpText, type AttentionKind } from '../orchestration/completion.ts';
import { setPrettyPathRoots } from './prettyPath.ts';
import { groupTranscript, speakerRows, turnElapsedNotes, type TranscriptEntry } from './activityGroups.ts';
import { hasAutomaticCorrection, placeTurnChanges } from './turnChanges.ts';
import { formatWorked } from '../backends/turnTiming.ts';
import { resolveContextMax } from '../backends/contextUsage.ts';
import { DEFAULT_TAB_TITLE, tabTitle } from '../chatTabs.ts';
import type {
  ConflictResolution,
  HostToWebviewMessage,
  ModelSettingField,
  ModelSettingOverrides,
  PermissionOption,
  QueuedTurnEntryView,
  SettingsPatch,
  ThinkingLevel
} from '../protocol';
import { deferHostClick, setHostBacklog } from './hostActivity';
import { createMessagePump, isUrgentHostMessage } from './messagePump';
import type { Attachment, PermissionLevel } from '../backends/types';
import { formatQuestionAnswers, questionRetryInstruction } from '../questions';
import { QuestionCard } from './QuestionCard';

import { dictationVisual, appendDraft } from './dictationView';
import { bridge } from './hostBridge';
import { usePopupSide } from './composer/popupSide';
import { BusyCorner } from './components/BusyCorner';
import { ModelPanel } from './modelPanel/ModelPanel';
import { ChatTabStrip } from './tabs/ChatTabStrip';
import { HistoryPanel } from './history/HistoryPanel';
import { EmptyState } from './screens/EmptyState';
import { RestoreResultStrip } from './screens/RestoreResultStrip';
import { RulesScreen } from './screens/RulesScreen';
import { entryContains } from './transcript/shared';
import { TranscriptRow } from './transcript/TranscriptRow';
import { ActivityGroup, NarrationRow } from './transcript/ActivityCards';
import { AttachmentList, ImageViewer, readClipboardFile, type ViewableImage } from './composer/attachments';
import { QueuedTurns } from './composer/QueuedTurns';
import { ModeMenu, ModeTrigger, PermissionPanel, PermissionTrigger } from './composer/Controls';
import { ModelSettingsPanel } from './composer/ModelSettingsPanel';
import { ModeSwitchModal, RestoreConfirmation, UnrestrictedConfirmation } from './dialogs/ConfirmDialogs';
import { acceptsSteer } from './steer';
import { queuedEntryMatches, sameAttachmentIds, sendIntent } from './queue';

/**
 * One live region for every reasoning item in the transcript. It stays mounted
 * while reasoning is collapsed inside an activity group or narration row, where
 * the reasoning card itself is not rendered. Streamed text never enters it.
 */
function ReasoningAnnouncements({ items }: { items: TranscriptItemView[] }): JSX.Element {
  const [announcement, setAnnouncement] = useState('');
  const previous = useRef<Map<string, ItemStatus>>(new Map());
  const signature = items
    .filter((item) => item.kind === 'reasoning')
    .map((item) => `${item.id}:${item.status}`)
    .join('|');
  useEffect(() => {
    const next = reasoningTransition(previous.current, items);
    previous.current = next.statuses;
    if (next.announcement) {
      setAnnouncement(next.announcement);
    }
  }, [signature]);
  return (
    <p className="sr-only" role="status">
      {announcement}
    </p>
  );
}
/** The screen's outer bound; the host settles at 15 s, this only unsticks a lost reply. */
const SETTINGS_SAVE_WATCHDOG_MS = 20000;
export function App(): JSX.Element {
  const [state, dispatch] = useReducer(reduce, initialState);
  /** Set synchronously on click so two clicks in one tick post once. */
  const settingsSavePendingRef = useRef(false);
  const settingsSaveWatchdogRef = useRef<number | undefined>(undefined);
  const clearSettingsSaveWatchdog = (): void => {
    if (settingsSaveWatchdogRef.current !== undefined) {
      window.clearTimeout(settingsSaveWatchdogRef.current);
      settingsSaveWatchdogRef.current = undefined;
    }
  };
  useEffect(() => () => clearSettingsSaveWatchdog(), []);
  setPrettyPathRoots(state.workspaceRoots);
  const [draft, setDraft] = useState('');
  /** A request to focus the card a notice points at, after the notice is gone. */
  const [attentionFocus, setAttentionFocus] = useState<{ kind: AttentionKind; nonce: number }>();
  const attentionFocusSeq = useRef(0);
  useLayoutEffect(() => {
    if (!attentionFocus) {
      return;
    }
    const cards = document.querySelectorAll<HTMLElement>(
      attentionFocus.kind === 'plan-remaining'
        ? '.todo-dock .todo, .plan-card'
        : '.turn-changes .changes-review, .turn-changes .changed-files'
    );
    const card = cards[cards.length - 1];
    if (!card) {
      return;
    }
    card.scrollIntoView?.({ block: 'nearest' });
    const target = card.querySelector<HTMLElement>('button:not([disabled]), .plan-doc') ?? card;
    target.focus();
  }, [attentionFocus]);
  /** True between queueing a message and the host's `queuedTurns` echo. */
  const [queuePending, setQueuePending] = useState(false);
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const [modelFilter, setModelFilter] = useState('');
  const [modePanelOpen, setModePanelOpen] = useState(false);
  const [permissionPanelOpen, setPermissionPanelOpen] = useState(false);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [imageViewer, setImageViewer] = useState<{ images: ViewableImage[]; index: number } | undefined>();
  const permissionPopup = usePopupSide(permissionPanelOpen);
  const modelPopup = usePopupSide(modelPanelOpen);
  const modelSettingsPopup = usePopupSide(modelSettingsOpen);
  const [pinnedUserId, setPinnedUserId] = useState<string | undefined>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  /** Bumped when a thread is created or a turn finishes, so the next open can refresh. */
  const [historyStale, setHistoryStale] = useState(false);
  const historyLoadedRef = useRef(new Set<string>());
  /** True once a provider list has been stored, so a later wipe is a refresh rather than the first load. */
  const historySeenRef = useRef(false);
  const markHistoryStaleRef = useRef<() => void>(() => {});
  markHistoryStaleRef.current = () => setHistoryStale(true);
  const historyRef = useRef<HTMLDivElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  /** Follow new transcript content only while the reader is already at the bottom. */
  const stickToBottomRef = useRef(true);
  /** Thread last painted with its messages visible, so a restore or history switch can jump to the end. */
  const pinnedThreadRef = useRef<string | undefined>(undefined);
  /** Ignore the scroll event fired by our own jump to the bottom. */
  const ignoreTranscriptScrollRef = useRef(false);
  /** True while the reader is scrolling, so streamed renders wait. */
  const scrollingRef = useRef(false);
  /** The latest scroll is near the top, checked after the scroll settles. */
  const nearTopRef = useRef(false);
  /** In-flight host clicks, released when the matching answer arrives. */
  const hostFlightsRef = useRef<Record<string, Array<() => void>>>({});
  const releaseHostFlightRef = useRef<(kind: string) => void>(() => {});
  releaseHostFlightRef.current = (kind: string): void => {
    hostFlightsRef.current[kind]?.shift()?.();
  };
  const runHostClick = (kind: string, work: () => void): void => {
    const release = deferHostClick(work);
    const queue = hostFlightsRef.current[kind] ?? [];
    queue.push(release);
    hostFlightsRef.current[kind] = queue;
  };
  /** While a click is scrolling back to a user message, leave that message expanded. */
  const pinLockRef = useRef(false);
  /** Scroll height before older rows were prepended, so the reader stays on the same line. */
  const olderAnchorRef = useRef<{ height: number; top: number } | null>(null);
  /** A page that added nothing should not immediately request another. */
  const olderStallRef = useRef(false);
  /**
   * The in-flight attach request. A late `attachmentsPicked` from a superseded
   * pick is ignored, so an old response cannot repopulate cleared chips.
   */
  const attachRequestRef = useRef<string | undefined>(undefined);
  /**
   * The text and chips posted as a queued turn. The composer keeps showing them
   * until the host's `queuedTurns` echo contains this message, so a rejected
   * queue never loses the draft.
   */
  const queueAwaitRef = useRef<{ text: string; attachments: Attachment[] } | undefined>(undefined);
  const queueTimerRef = useRef<number | undefined>(undefined);
  const onQueuedTurnsRef = useRef<(entries: QueuedTurnEntryView[]) => void>(() => {});
  const onUserMessageSentRef = useRef<
    (message: Extract<HostToWebviewMessage, { type: 'userMessageSent' }>) => void
  >(() => {});
  /** The host refused the queue: keep the draft and let the user retry. */
  const onQueueRejectedRef = useRef<() => void>(() => {});
  /** The mode-switch dialog on screen, so a replacement can decline the one it covers. */
  const modeSwitchRequestRef = useRef<string | undefined>(undefined);
  const attachCounterRef = useRef(0);
  /** Unsent composer text and files, remembered per open tab. */
  const composerMemoryRef = useRef<Record<string, ComposerDraft>>({});
  const composerDirtyRef = useRef(false);
  /** True until the host has restored this tab, so an empty composer is not saved over it. */
  const composerSkipPublishRef = useRef(true);
  const composerCarryRef = useRef<ComposerDraft | undefined>(undefined);
  const composerCarryFromRef = useRef<string | undefined>(undefined);
  const composerSentBytesRef = useRef(new Set<string>());
  const activeChatTabIdRef = useRef<string | undefined>(undefined);
  const activeThreadIdRef = useRef(state.activeThreadId);
  const selectedBackendIdRef = useRef(state.selectedBackendId);
  activeThreadIdRef.current = state.activeThreadId;
  selectedBackendIdRef.current = state.selectedBackendId;
  const draftMirrorRef = useRef(draft);
  const attachmentsMirrorRef = useRef(state.attachments);
  draftMirrorRef.current = draft;
  attachmentsMirrorRef.current = state.attachments;
  const onComposerDraftRef = useRef<
    (message: { tabId: string; text: string; attachments: Attachment[] }) => void
  >(() => {});
  const markComposerEdited = (): void => {
    composerDirtyRef.current = true;
    composerSkipPublishRef.current = false;
  };
  const publishComposer = (tabId: string | undefined, text: string, attachments: Attachment[]): void => {
    if (tabId) {
      composerMemoryRef.current[tabId] = {
        text,
        attachments: attachments.map((attachment) => ({ ...attachment }))
      };
    }
    composerSkipPublishRef.current = false;
    bridge.post({
      type: 'composerDraft',
      ...(tabId ? { tabId } : {}),
      text,
      attachments: hostAttachments(attachments, composerSentBytesRef.current)
    });
  };
  const [listening, setListening] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const listeningRef = useRef(false);
  /** Click latches the mic until the next click. Hold is push-to-talk. */
  const [dictationGesture, setDictationGesture] = useState<'idle' | 'latched' | 'ptt'>('idle');
  const dictationGestureRef = useRef<'idle' | 'latched' | 'ptt'>('idle');
  const micHoldTimerRef = useRef<number | undefined>(undefined);
  const micHeldRef = useRef(false);
  const micPointerRef = useRef(false);
  /** This press opened the mic. A short release leaves it on; a hold stops on release. */
  const micPressStartedRef = useRef(false);
  const [dictationStatus, setDictationStatus] = useState<string | undefined>();
  const dictationRequestRef = useRef<string | undefined>(undefined);
  const stopDictationRef = useRef<() => void>(() => {});
  const onDictationRef = useRef<
    (
      message:
        | { type: 'dictationCleaned'; requestId: string; text: string }
        | { type: 'dictationError'; requestId: string; message: string; raw?: string }
        | { type: 'dictationStatus'; requestId: string; message: string }
    ) => void
  >(() => {});

  useEffect(() => {
    const applyHostMessage = (message: HostToWebviewMessage): void => {
      switch (message.type) {
        case 'snapshot':
          dispatch({ type: 'snapshot', availability: message.availability });
          break;
        case 'models':
          dispatch({ type: 'models', backendId: message.backendId, models: message.models, error: message.error });
          break;
        case 'threads':
          dispatch({ type: 'threads', backendId: message.backendId, threads: message.threads });
          break;
        case 'chatTabs':
          dispatch({ type: 'chatTabs', tabs: message.tabs });
          break;
        case 'composerDraft':
          onComposerDraftRef.current(message);
          break;
        case 'attachmentsAdded':
          if (message.tabId !== activeChatTabIdRef.current) {
            break;
          }
          markComposerEdited();
          dispatch({ type: 'addAttachments', attachments: message.attachments });
          break;
        case 'agentEvent':
          dispatch({ type: 'agentEvent', event: message.event });
          if (message.event.type === 'approval/decided') {
            releaseHostFlightRef.current('approval');
          }
          break;
        case 'question/asked':
          dispatch({ type: 'questionAsked', request: message.request });
          break;
        case 'question/cleared':
          dispatch({ type: 'questionCleared' });
          break;
        case 'conversation':
          markHistoryStaleRef.current();
          olderStallRef.current = false;
          olderAnchorRef.current = null;
          dispatch({
            type: 'conversation',
            backendId: message.backendId,
            threadId: message.threadId,
            model: message.model,
            permissionLevel: message.permissionLevel,
            mode: message.mode,
            replay: message.replay,
            pendingApproval: message.pendingApproval,
            pendingQuestion: message.pendingQuestion,
            notice: message.notice,
            plan: message.plan,
            keepPendingUserMessage: message.keepPendingUserMessage,
            hasOlderHistory: message.hasOlderHistory
          });
          break;
        case 'olderHistory':
          if (message.items.length === 0) {
            olderStallRef.current = true;
          }
          releaseHostFlightRef.current('older');
          dispatch({
            type: 'olderHistory',
            backendId: message.backendId,
            threadId: message.threadId,
            items: message.items,
            hasOlderHistory: message.hasOlderHistory
          });
          break;
        case 'restoring':
          dispatch({ type: 'restoring', value: message.value });
          break;
        case 'busy':
          if (!message.value) {
            markHistoryStaleRef.current();
          }
          dispatch({ type: 'busy', value: message.value, backendId: message.backendId, threadId: message.threadId });
          break;
        case 'notice':
          dispatch({ type: 'notice', level: message.level, message: message.message, action: message.action });
          break;
        case 'settings':
          dispatch({ type: 'settings', settings: message.settings });
          break;
        case 'settingsSave':
          settingsSavePendingRef.current = message.pending;
          if (!message.pending) {
            clearSettingsSaveWatchdog();
          }
          dispatch({
            type: 'settingsSave',
            pending: message.pending,
            ok: message.ok,
            message: message.message
          });
          break;
        case 'showSettings':
          dispatch({ type: 'openSettings', provider: message.section });
          bridge.post({ type: 'getSettings' });
          break;
        case 'codexVersionCheck':
          dispatch({
            type: 'codexVersionCheck',
            pending: message.pending,
            ok: message.ok,
            message: message.message
          });
          break;
        case 'permissions':
          dispatch({ type: 'permissions', permissions: message.permissions });
          break;
        case 'modes':
          dispatch({ type: 'modes', modes: message.modes });
          break;
        case 'plan':
          dispatch({ type: 'plan', plan: message.plan });
          break;
        case 'connectionTest':
          dispatch({ type: 'connectionTest', result: message.result });
          break;
        case 'opencodeUpgrade':
          dispatch({
            type: 'opencodeUpgrade',
            pending: message.pending,
            ok: message.ok,
            message: message.message
          });
          break;
        case 'opencodeInstall':
          dispatch({
            type: 'opencodeInstall',
            pending: message.pending,
            ok: message.ok,
            message: message.message,
            path: message.path
          });
          break;
        case 'zvecGrep':
          dispatch(skillToggleAction(message));
          break;
        case 'astGrep':
          dispatch(skillToggleAction(message));
          break;
        case 'astGrepInstall':
          dispatch({
            type: 'astGrepInstall',
            pending: message.pending,
            ok: message.ok,
            message: message.message,
            path: message.path
          });
          break;
        case 'zvecGrepInstall':
          dispatch({
            type: 'zvecGrepInstall',
            pending: message.pending,
            ok: message.ok,
            message: message.message,
            path: message.path
          });
          break;
        case 'skillAction':
          dispatch({
            type: 'skillAction',
            skill: message.skill,
            action: message.action,
            pending: message.pending,
            ok: message.ok,
            message: message.message
          });
          break;
        case 'context':
          dispatch({
            type: 'context',
            view: message.view,
            settingsEnabled: message.settingsEnabled,
            exclusions: message.exclusions,
            includeViewedFile: message.includeViewedFile,
            workspaceRoots: message.workspaceRoots
          });
          break;
        case 'modelCapability':
          dispatch({ type: 'modelCapability', capability: message.capability });
          break;
        case 'changes/changed':
          dispatch({
            type: 'changesChanged',
            backendId: message.backendId,
            threadId: message.threadId,
            turnId: message.turnId,
            messageId: message.messageId,
            entries: message.entries
          });
          break;
        case 'changes/review':
          dispatch({ type: 'changeReview', review: message.review });
          break;
        case 'changes/hunks':
          dispatch({
            type: 'changeHunks',
            turnId: message.turnId,
            path: message.path,
            hunks: message.hunks,
            truncated: message.truncated
          });
          break;
        case 'changes/decisionResult':
          releaseHostFlightRef.current('decide');
          dispatch({ type: 'changeDecision', results: message.results, message: message.message });
          break;
        case 'changes/checkpoints':
          dispatch({ type: 'checkpoints', checkpoints: message.checkpoints });
          break;
        case 'userMessageId':
          dispatch({
            type: 'userMessageId',
            backendId: message.backendId,
            threadId: message.threadId,
            messageId: message.messageId,
            sentAt: message.sentAt
          });
          break;
        case 'revertLocalSend':
          dispatch({ type: 'revertLocalSend', text: message.text });
          break;
        case 'changes/restorePreview':
          releaseHostFlightRef.current('restorePreview');
          dispatch({ type: 'restorePreview', preview: message.preview });
          break;
        case 'modeSwitchPrompt': {
          const previous = modeSwitchRequestRef.current;
          if (previous && previous !== message.requestId) {
            bridge.post({ type: 'modeSwitchChoice', requestId: previous, accept: false });
          }
          modeSwitchRequestRef.current = message.requestId;
          dispatch({
            type: 'modeSwitchPrompt',
            requestId: message.requestId,
            from: message.from,
            to: message.to
          });
          break;
        }
        case 'changes/restoreResult':
          releaseHostFlightRef.current('restore');
          dispatch({ type: 'restoreResult', result: message.result });
          break;
        case 'modelCapabilityError':
          dispatch({
            type: 'modelCapabilityError',
            providerId: message.providerId,
            modelId: message.modelId,
            message: message.message
          });
          break;
        case 'attachmentsPicked':
          if (message.cancelled || message.requestId !== attachRequestRef.current) {
            // A dismissed picker, or a response to an earlier request, leaves
            // the composer exactly as it was.
            break;
          }
          markComposerEdited();
          dispatch({ type: 'addAttachments', attachments: message.attachments });
          break;
        case 'attachmentError':
          onQueueRejectedRef.current();
          dispatch({ type: 'attachmentError', message: message.message });
          break;
        case 'queuedTurns':
          onQueuedTurnsRef.current(message.entries);
          break;
        case 'userMessageSent':
          dispatch({
            type: 'userMessageSent',
            backendId: message.backendId,
            threadId: message.threadId,
            messageId: message.messageId,
            text: message.text,
            attachments: message.attachments,
            sentAt: message.sentAt,
            orchestration: message.orchestration
          });
          onUserMessageSentRef.current(message);
          break;
        case 'dictationCleaned':
        case 'dictationError':
        case 'dictationStatus':
          onDictationRef.current(message);
          break;
      }
    };
    const pump = createMessagePump({
      apply: applyHostMessage,
      shouldDefer: () => scrollingRef.current && !stickToBottomRef.current,
      onHold: setHostBacklog
    });
    const unsubscribe = bridge.subscribe((message) => {
      pump.push(message, isUrgentHostMessage(message.type));
    });
    bridge.post({ type: 'ready' });
    bridge.post({ type: 'getSettings' });
    return () => {
      unsubscribe();
      pump.dispose();
    };
  }, []);

  useEffect(() => {
    if (!listening) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      stopDictationRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [listening]);

  // Keep the permission read model in step with the selected backend: this is
  // what tells the picker which levels the backend actually serves and which of
  // them needs the labelled confirmation.
  useEffect(() => {
    if (state.selectedBackendId) {
      bridge.post({ type: 'getPermissions', backendId: state.selectedBackendId });
      bridge.post({ type: 'getModes', backendId: state.selectedBackendId });
    }
  }, [state.selectedBackendId]);

  // Opening the rules surface re-reads the permission read model, so the
  // revocation route lists the rule an `always` decision just created even if a
  // pushed update was missed.
  useEffect(() => {
    if (state.rulesOpen && state.selectedBackendId) {
      bridge.post({ type: 'getPermissions', backendId: state.selectedBackendId });
    }
  }, [state.rulesOpen, state.selectedBackendId]);

  // Keep the capability descriptor + effective settings in step with the
  // selected model. The host owns resolution and clamping, so the webview never
  // guesses a valid value; it marks the read loading until the answer arrives,
  // and the floating panel renders whatever the host resolved.
  const activeChatTabId = state.chatTabs.find((tab) => tab.active)?.id;
  activeChatTabIdRef.current = activeChatTabId;

  useEffect(() => {
    if (state.selectedBackendId && state.selectedModel) {
      dispatch({ type: 'modelCapabilityLoading' });
      bridge.post({
        type: 'getModelCapability',
        providerId: state.selectedBackendId,
        modelId: state.selectedModel
      });
    }
  }, [state.selectedBackendId, state.selectedModel, activeChatTabId]);

  const requestOlder = (fromReader = false): void => {
    if (fromReader) {
      olderStallRef.current = false;
    }
    if (state.restoring || !state.hasOlderHistory || state.loadingOlder || olderStallRef.current) {
      return;
    }
    if ((hostFlightsRef.current.older?.length ?? 0) > 0) {
      return;
    }
    const el = transcriptRef.current;
    if (el) {
      olderAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
    }
    stickToBottomRef.current = false;
    runHostClick('older', () => {
      startTransition(() => dispatch({ type: 'olderHistoryLoading' }));
      bridge.post({ type: 'loadOlderHistory' });
    });
  };
  const requestOlderRef = useRef(requestOlder);
  requestOlderRef.current = requestOlder;

  const syncPinnedUser = useCallback((): void => {
    if (pinLockRef.current) {
      return;
    }
    const el = transcriptRef.current;
    if (!el) {
      return;
    }
    const edge = el.getBoundingClientRect().top;
    const frames: UserMessageFrame[] = [];
    el.querySelectorAll<HTMLElement>('[data-user-message]').forEach((node) => {
      const id = node.dataset.userMessage;
      if (!id) {
        return;
      }
      const box = node.getBoundingClientRect();
      frames.push({ id, top: box.top - edge, bottom: box.bottom - edge });
    });
    const next = pinnedUserMessage(frames);
    setPinnedUserId((current) => (current === next ? current : next));
  }, []);

  useEffect(() => {
    const el = transcriptRef.current;
    if (!el || state.settingsOpen || state.rulesOpen) {
      return;
    }
    let idle = 0;
    const settle = (): void => {
      if (!scrollingRef.current) {
        return;
      }
      scrollingRef.current = false;
      if (nearTopRef.current) {
        requestOlderRef.current();
      }
      if (!pinLockRef.current) {
        syncPinnedUser();
      }
    };
    const onScroll = (): void => {
      if (ignoreTranscriptScrollRef.current) {
        return;
      }
      scrollingRef.current = true;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distance <= 48;
      if (el.scrollTop > 120) {
        olderStallRef.current = false;
      }
      nearTopRef.current = el.scrollTop < 48;
      window.clearTimeout(idle);
      idle = window.setTimeout(settle, 80);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('scrollend', settle);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('scrollend', settle);
      window.clearTimeout(idle);
      scrollingRef.current = false;
    };
  }, [state.settingsOpen, state.rulesOpen, syncPinnedUser]);

  const jumpToUserMessage = (id: string): void => {
    const el = transcriptRef.current;
    const message = el?.querySelector<HTMLElement>(`[data-user-message="${CSS.escape(id)}"]`);
    if (!el || !message) {
      return;
    }
    const top = message.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    stickToBottomRef.current = false;
    pinLockRef.current = true;
    setPinnedUserId(undefined);
    const target = Math.max(0, top - 8);
    if (Math.abs(el.scrollTop - target) < 2) {
      pinLockRef.current = false;
      return;
    }
    el.scrollTo({ top: target, behavior: 'smooth' });
    window.setTimeout(() => {
      if (!pinLockRef.current) {
        return;
      }
      pinLockRef.current = false;
      syncPinnedUser();
    }, 700);
  };

  const scrollTranscriptToBottom = (): void => {
    const el = transcriptRef.current;
    if (!el) {
      return;
    }
    ignoreTranscriptScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    ignoreTranscriptScrollRef.current = false;
  };

  /** A message the reader just sent should land in view, even after they scrolled up. */
  const followSentMessage = (): void => {
    stickToBottomRef.current = true;
    pinLockRef.current = false;
    olderAnchorRef.current = null;
  };

  useLayoutEffect(() => {
    // While restoring, the transcript shows a placeholder instead of the
    // messages. Scrolling then would pin the short placeholder; wait until the
    // conversation is actually on screen.
    if (state.restoring || olderAnchorRef.current) {
      return;
    }
    const threadChanged = pinnedThreadRef.current !== state.activeThreadId;
    pinnedThreadRef.current = state.activeThreadId;
    if (threadChanged) {
      stickToBottomRef.current = true;
    }
    if (!stickToBottomRef.current) {
      return;
    }
    scrollTranscriptToBottom();
    // Markdown and code blocks can grow after the first layout pass.
    const frame = requestAnimationFrame(() => {
      if (stickToBottomRef.current) {
        scrollTranscriptToBottom();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    state.transcript,
    state.restoring,
    state.activeThreadId,
    state.notice,
    state.startingTurn,
    state.busy,
    state.plan,
    state.restoreResult,
    state.settingsOpen,
    state.rulesOpen
  ]);

  useLayoutEffect(() => {
    const anchor = olderAnchorRef.current;
    const el = transcriptRef.current;
    if (!anchor || !el || state.loadingOlder) {
      return;
    }
    olderAnchorRef.current = null;
    const nextTop = anchor.top + (el.scrollHeight - anchor.height);
    ignoreTranscriptScrollRef.current = true;
    el.scrollTop = nextTop;
    stickToBottomRef.current = false;
    ignoreTranscriptScrollRef.current = false;
    if (nextTop < 48 && state.hasOlderHistory) {
      olderStallRef.current = true;
    }
    syncPinnedUser();
  }, [state.transcript, state.loadingOlder, state.hasOlderHistory, syncPinnedUser]);

  useEffect(() => {
    if (scrollingRef.current) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (!scrollingRef.current) {
        syncPinnedUser();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [state.transcript, state.restoring, state.activeThreadId, state.settingsOpen, state.rulesOpen, syncPinnedUser]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) {
      return;
    }
    const release = (): void => {
      if (!pinLockRef.current) {
        return;
      }
      pinLockRef.current = false;
      syncPinnedUser();
    };
    el.addEventListener('scrollend', release);
    el.addEventListener('wheel', release, { passive: true });
    el.addEventListener('touchstart', release, { passive: true });
    return () => {
      el.removeEventListener('scrollend', release);
      el.removeEventListener('wheel', release);
      el.removeEventListener('touchstart', release);
    };
  }, [state.settingsOpen, state.rulesOpen, syncPinnedUser]);

  // Read a review for each turn that has files but no snapshot yet. The host
  // also pushes the review when the turn ends; this covers a reload that
  // delivered the file list first.
  const turnsNeedingReview = state.turnChanges
    .filter((turn) => turn.entries.length > 0 && !turn.review)
    .map((turn) => turn.turnId)
    .join('\n');
  useEffect(() => {
    if (!state.activeThreadId || !state.selectedBackendId || !turnsNeedingReview) {
      return;
    }
    for (const turnId of turnsNeedingReview.split('\n')) {
      bridge.post({
        type: 'changes/list',
        backendId: state.selectedBackendId,
        threadId: state.activeThreadId,
        turnId
      });
    }
  }, [state.activeThreadId, state.selectedBackendId, turnsNeedingReview]);

  // Providers the switcher may show: those the user left enabled and that
  // report `available` or `unauthenticated`. A provider switched off under
  // Settings > Providers, or with no usable integration (Codex CLI not
  // installed), is omitted entirely rather than shown as broken.
  const providers = useMemo(
    () =>
      state.availability.filter(
        (backend) => backend.enabled !== false && backend.status !== 'unavailable'
      ),
    [state.availability]
  );

  const available = useMemo(
    () => providers.filter((backend) => backend.status === 'available'),
    [providers]
  );

  // A provider the user has a working account for may never be diluted with
  // entries from a provider they do not: once anything is available, only
  // available providers are listed. An unauthenticated provider is surfaced
  // only when it is the whole story, so the switcher is never empty.
  const switcherProviders = useMemo(
    () => (available.length > 0 ? available : providers),
    [providers, available]
  );

  // Load every available backend's models so the floating panel can list them all
  // in one place; the provider concept stays in the host, the panel only reads
  // the neutral `models` payload. An unauthenticated provider has no list to
  // fetch â€” it is represented by an actionable entry instead.
  useEffect(() => {
    for (const backend of available) {
      if (state.models[backend.id] === undefined && state.modelErrors[backend.id] === undefined) {
        bridge.post({ type: 'listModels', backendId: backend.id });
      }
    }
  }, [available, state.models, state.modelErrors]);

  const active = useMemo(
    () => state.availability.find((backend) => backend.id === state.selectedBackendId),
    [state.availability, state.selectedBackendId]
  );
  const activeModels = state.selectedBackendId ? state.models[state.selectedBackendId] ?? [] : [];
  const selectedModelLabel =
    activeModels.find((model) => model.id === state.selectedModel)?.label ??
    activeModels[0]?.label;

  useEffect(() => {
    const firstUser = state.transcript.find(
      (item) => item.kind === 'message' && item.role === 'user' && !item.orchestration && item.text?.trim()
    );
    const blank = !state.activeThreadId && !firstUser;
    bridge.setState({
      backendId: state.selectedBackendId,
      threadId: state.activeThreadId,
      blank,
      title: firstUser?.text ? tabTitle(firstUser.text) : DEFAULT_TAB_TITLE
    });
  }, [state.activeThreadId, state.selectedBackendId, state.transcript]);

  useEffect(() => {
    if (!historyOpen) {
      return;
    }
    const onPointer = (event: PointerEvent): void => {
      if (!historyRef.current?.contains(event.target as Node)) {
        setHistoryOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setHistoryOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [historyOpen]);

  const composerPopupOpen = modePanelOpen || permissionPanelOpen || modelPanelOpen || modelSettingsOpen;
  const closeComposerPopups = useCallback((): void => {
    setModePanelOpen(false);
    setPermissionPanelOpen(false);
    setModelPanelOpen(false);
    setModelFilter('');
    setModelSettingsOpen(false);
  }, []);

  // Composer menus (mode, permission, model, model settings) dismiss on an
  // outside press or Escape. The trigger sits inside the same root as the
  // card, so pressing it still toggles instead of being treated as outside.
  useEffect(() => {
    if (!composerPopupOpen) {
      return;
    }
    const onPointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      const inside = [modeMenuRef.current, permissionPopup.ref.current, modelPopup.ref.current, modelSettingsPopup.ref.current].some(
        (node) => node?.contains(target)
      );
      if (!inside) {
        closeComposerPopups();
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        closeComposerPopups();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [composerPopupOpen, closeComposerPopups, permissionPopup.ref, modelPopup.ref, modelSettingsPopup.ref]);

  const history = useMemo(
    () => historyEntries(state.availability, state.threads),
    [state.availability, state.threads]
  );
  const historyPending = historyLoading(state.availability, state.threadLoading);

  const toggleHistory = (): void => {
    setHistoryOpen((open) => {
      if (!open) {
        setHistoryQuery('');
      }
      return !open;
    });
  };

  // The first open loads every provider. Later opens reuse that list. A new
  // chat or a finished turn marks the list stale, and the next open (or an
  // open panel) refreshes without replacing the rows with a spinner.
  useEffect(() => {
    const providers = state.availability;
    const hasLists = providers.some((backend) => state.threads[backend.id] !== undefined);
    if (hasLists) {
      historySeenRef.current = true;
    } else if (historySeenRef.current && providers.length > 0) {
      historyLoadedRef.current.clear();
      historySeenRef.current = false;
    }
    if (!historyOpen || providers.length === 0) {
      return;
    }
    const refresh = providers.filter((backend) => historyStale || !historyLoadedRef.current.has(backend.id));
    if (refresh.length === 0) {
      return;
    }
    const showLoading = providers.every((backend) => state.threads[backend.id] === undefined);
    for (const backend of refresh) {
      if (showLoading) {
        dispatch({ type: 'threadsLoading', backendId: backend.id, value: true });
      }
      bridge.post({ type: 'listThreads', backendId: backend.id });
      historyLoadedRef.current.add(backend.id);
    }
    if (historyStale) {
      setHistoryStale(false);
    }
  }, [historyOpen, historyStale, state.availability, state.threads]);

  const resumeThread = (backendId: string, threadId: string): void => {
    setHistoryOpen(false);
    setHistoryQuery('');
    stickToBottomRef.current = true;
    bridge.post({ type: 'openThread', backendId, threadId });
  };

  const toggleModelPanel = (): void => {
    setModelPanelOpen((open) => {
      const next = !open;
      if (next) {
        // Refresh on open. The cached lists stay visible (so the collapsed
        // trigger keeps the current model), and the host replaces each list
        // with a fresh `listModels()` result as it arrives.
        for (const backend of available) {
          bridge.post({ type: 'listModels', backendId: backend.id });
        }
      }
      return next;
    });
  };

  const closeSettings = (): void => {
    settingsSavePendingRef.current = false;
    clearSettingsSaveWatchdog();
    dispatch({ type: 'closeSettings' });
  };

  const saveSettings = (patch: SettingsPatch, target?: 'global' | 'workspace' | 'folder'): void => {
    // Set before dispatch/post so a second click in the same tick is ignored,
    // not merely hidden by the disabled attribute on the next render.
    if (settingsSavePendingRef.current || state.settingsSave?.pending) {
      return;
    }
    settingsSavePendingRef.current = true;
    dispatch({ type: 'settingsSave', pending: true });
    bridge.post({ type: 'saveSettings', patch, ...(target ? { target } : {}) });
    clearSettingsSaveWatchdog();
    settingsSaveWatchdogRef.current = window.setTimeout(() => {
      if (!settingsSavePendingRef.current) {
        return;
      }
      settingsSavePendingRef.current = false;
      dispatch({
        type: 'settingsSave',
        pending: false,
        ok: false,
        message:
          'The save did not answer in time. Your draft is still here, so you can retry; reopen Settings to see anything that was stored.'
      });
    }, SETTINGS_SAVE_WATCHDOG_MS);
  };

  const saveOllamaToken = (value: string): void => {
    bridge.post({ type: 'setOllamaToken', value });
  };

  const clearOllamaToken = (): void => {
    bridge.post({ type: 'clearOllamaToken' });
  };

  const saveOpencodeZenToken = (value: string): void => {
    bridge.post({ type: 'setOpencodeZenToken', value });
  };

  const clearOpencodeZenToken = (): void => {
    bridge.post({ type: 'clearOpencodeZenToken' });
  };

  const upgradeOpencode = (draft: { cliSource: 'local' | 'bundled'; path: string }): void => {
    dispatch({ type: 'opencodeUpgrade', pending: true });
    bridge.post({ type: 'upgradeOpencode', cliSource: draft.cliSource, path: draft.path });
  };

  const installOpencode = (draft: { cliSource: 'local' | 'bundled'; path: string }): void => {
    dispatch({ type: 'opencodeInstall', pending: true });
    bridge.post({ type: 'installOpencode', cliSource: draft.cliSource, path: draft.path });
  };

  const setZvecGrep = (
    enabled: boolean,
    draft?: { cliSource: 'local' | 'bundled'; path: string }
  ): void => {
    dispatch({ type: 'zvecGrep', pending: true, requested: enabled });
    bridge.post({
      type: 'setZvecGrep',
      enabled,
      ...(draft ? { cliSource: draft.cliSource, path: draft.path } : {})
    });
  };

  const setAstGrep = (
    enabled: boolean,
    draft?: { cliSource: 'local' | 'bundled'; path: string }
  ): void => {
    dispatch({ type: 'astGrep', pending: true, requested: enabled });
    bridge.post({
      type: 'setAstGrep',
      enabled,
      ...(draft ? { cliSource: draft.cliSource, path: draft.path } : {})
    });
  };

  const installAstGrep = (draft: { cliSource: 'local' | 'bundled'; path: string }): void => {
    dispatch({ type: 'astGrepInstall', pending: true });
    bridge.post({ type: 'installAstGrep', cliSource: draft.cliSource, path: draft.path });
  };

  const upgradeAstGrep = (draft: { cliSource: 'local' | 'bundled'; path: string }): void => {
    dispatch({ type: 'astGrepInstall', pending: true });
    bridge.post({ type: 'upgradeAstGrep', cliSource: draft.cliSource, path: draft.path });
  };

  const installZvecGrep = (draft: { cliSource: 'local' | 'bundled'; path: string }): void => {
    dispatch({ type: 'zvecGrepInstall', pending: true });
    bridge.post({ type: 'installZvecGrep', cliSource: draft.cliSource, path: draft.path });
  };

  const runSkillAction = (
    skill: 'zvecGrep' | 'astGrep',
    action: 'test' | 'index',
    draft?: { cliSource: 'local' | 'bundled'; path: string }
  ): void => {
    dispatch({ type: 'skillAction', skill, action, pending: true });
    bridge.post({
      type: 'skillAction',
      skill,
      action,
      ...(draft ? { cliSource: draft.cliSource, path: draft.path } : {})
    });
  };

  const testConnection = (
    backendId: string,
    draft?: { cliSource: 'local' | 'bundled'; path: string }
  ): void => {
    dispatch({ type: 'connectionTestPending', backendId });
    bridge.post({
      type: 'testConnection',
      backendId,
      ...(draft
        ? {
            cliSource: draft.cliSource,
            path: draft.path
          }
        : {})
    });
  };

  const validateCodexVersion = (): void => {
    dispatch({ type: 'codexVersionCheck', pending: true });
    bridge.post({ type: 'validateCodexVersion' });
  };

  // The permission picker is driven by the host's read model, so it only offers
  // levels this backend actually serves. A backend without an approval channel
  // reports one level and the picker is absent.
  const permissionOptions: PermissionOption[] = state.permissions?.options ?? [];
  const hasApprovalChannel = state.permissions?.hasApprovalChannel ?? false;
  const modeSnapshot = visibleModeSnapshot(state);
  // Stored `always` rules: each shows what it actually allows and can be
  // revoked here, so a lasting rule is never invisible.
  const storedRules = state.permissions?.rules ?? [];
  const pending = pendingApproval(state);

  const applyPermission = (level: PermissionLevel): void => {
    dispatch({ type: 'selectPermission', level });
    bridge.post({ type: 'selectPermission', level });
  };

  const selectPermission = (option: PermissionOption): void => {
    // A widening level is never applied as a side effect: it opens the labelled
    // confirmation and only an explicit confirm dispatches the change.
    if (option.requiresConfirmation) {
      dispatch({ type: 'requestPermissionConfirmation' });
      return;
    }
    applyPermission(option.level);
  };

  const confirmPermissionChange = (): void => {
    const target = permissionOptions.find((option) => option.requiresConfirmation);
    if (target) {
      applyPermission(target.level);
    }
    dispatch({ type: 'cancelPermissionConfirmation' });
  };

  const revokeRule = (rule: ApprovalRule): void => {
    if (state.selectedBackendId) {
      bridge.post({ type: 'revokeApprovalRule', backendId: state.selectedBackendId, ruleId: rule.id });
    }
  };

  const decide = (decision: ApprovalDecision): void => {
    if (!pending?.approval) {
      return;
    }
    if ((hostFlightsRef.current.approval?.length ?? 0) > 0) {
      return;
    }
    const message = {
      type: 'decideApproval' as const,
      backendId: pending.backendId ?? state.selectedBackendId ?? '',
      threadId: pending.threadId ?? state.activeThreadId ?? '',
      requestId: pending.approval.id,
      decision
    };
    runHostClick('approval', () => {
      bridge.post(message);
    });
  };

  const fitComposerInput = useCallback(() => {
    const element = composerInputRef.current;
    if (!element) {
      return;
    }
    // The empty-chat field fills the composer by flex. A content height would
    // either stop short of the box or push the control row past its bottom edge.
    if (element.closest('.composer--expanded')) {
      element.style.height = '';
      return;
    }
    element.style.height = '0px';
    const composer = element.closest('.composer');
    let room = Number.POSITIVE_INFINITY;
    if (composer instanceof HTMLElement) {
      const limit = Number.parseFloat(getComputedStyle(composer).maxHeight);
      if (Number.isFinite(limit)) {
        const chrome = composer.scrollHeight - element.offsetHeight;
        room = Math.max(72, limit - chrome);
      }
    }
    element.style.height = 'auto';
    const max = Number.parseFloat(getComputedStyle(element).maxHeight);
    const content = element.scrollHeight;
    const cap = Number.isFinite(max) ? Math.min(content, max) : content;
    element.style.height = `${Math.min(cap, room)}px`;
  }, []);

  useLayoutEffect(() => {
    fitComposerInput();
  }, [draft, state.transcript.length, state.restoring, state.settingsOpen, state.rulesOpen, fitComposerInput]);

  useEffect(() => {
    const box = composerInputRef.current?.parentElement;
    if (!box) {
      return;
    }
    let width = box.clientWidth;
    const observer = new ResizeObserver(() => {
      if (box.clientWidth === width) {
        return;
      }
      width = box.clientWidth;
      fitComposerInput();
    });
    observer.observe(box);
    window.addEventListener('resize', fitComposerInput);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fitComposerInput);
    };
  }, [state.settingsOpen, state.rulesOpen, fitComposerInput]);

  useEffect(
    () => () => {
      if (queueTimerRef.current !== undefined) {
        window.clearTimeout(queueTimerRef.current);
      }
    },
    []
  );

  // A busy turn or a queued message pins the provider, model and permission
  // controls: queued turns snapshot those values when they are enqueued, so
  // changing them now would dispatch the next turn on a provider this chat no
  // longer shows. Closing an open panel avoids leaving a stale picker on screen.
  useEffect(() => {
    if (!state.busy && state.queuedTurns.length === 0) {
      return;
    }
    setModePanelOpen(false);
    setPermissionPanelOpen(false);
    setModelPanelOpen(false);
    setModelSettingsOpen(false);
  }, [state.busy, state.queuedTurns.length]);

  const send = (quick = false): void => {
    const text = draft.trim();
    const intent = sendIntent({
      busy: state.busy,
      backendId: active?.id,
      backendStatus: active?.status,
      text,
      attachmentCount: state.attachments.length,
      restoring: state.restoring,
      pendingApproval: Boolean(pending),
      askingQuestion: Boolean(state.pendingQuestion),
      modeSwitch: Boolean(state.modeSwitch)
    });
    // The queued message stays in the composer until the host echoes it back;
    // a second Enter in that window must not enqueue the same text twice.
    if (intent === 'blocked' || (state.busy && queuePending)) {
      return;
    }
    const attachments = state.attachments;
    const backendId = state.selectedBackendId;
    const model = state.selectedModel;
    const permissionLevel = state.permissionLevel;
    if (intent === 'queue') {
      queueAwaitRef.current = {
        text,
        attachments: attachments.map((attachment) => ({ ...attachment }))
      };
      setQueuePending(true);
      if (queueTimerRef.current !== undefined) {
        window.clearTimeout(queueTimerRef.current);
      }
      queueTimerRef.current = window.setTimeout(() => {
        // No echo arrived. Release the duplicate-send guard and keep the draft
        // so the user can retry instead of being stuck with a disabled Send.
        queueTimerRef.current = undefined;
        queueAwaitRef.current = undefined;
        setQueuePending(false);
        dispatch({
          type: 'notice',
          level: 'warning',
          message:
            'Queue confirmation timed out. Your message stays in the composer; check the queued list before sending again.'
        });
      }, 4000);
      dispatch({ type: 'dismissAttachmentError' });
      bridge.post({
        type: 'sendTurn',
        text,
        backendId,
        model,
        permissionLevel,
        attachments,
        queue: true
      });
      return;
    }
    if (intent === 'steer') {
      followSentMessage();
      setDraft('');
      startTransition(() => {
        dispatch({ type: 'localUserMessage', text, opensTurn: false });
        dispatch({ type: 'dismissNotice' });
      });
      bridge.post({ type: 'steerTurn', text });
      publishComposer(activeChatTabIdRef.current, '', attachments);
      return;
    }
    followSentMessage();
    setDraft('');
    setHistoryStale(true);
    startTransition(() => {
      dispatch({ type: 'localUserMessage', text, attachments });
      dispatch({ type: 'dismissNotice' });
    });
    bridge.post({
      type: 'sendTurn',
      text,
      backendId,
      model,
      permissionLevel,
      attachments,
      ...(quick ? { quick: true } : {})
    });
    publishComposer(activeChatTabIdRef.current, '', []);
  };

  // The attach button opens a native picker in the host; the response arrives as
  // `attachmentsPicked`. Each request carries an id so a superseded response is
  // dropped rather than adding chips to a message the user already changed.
  const openFilePicker = (): void => {
    attachCounterRef.current += 1;
    const requestId = `attach_${Date.now()}_${attachCounterRef.current}`;
    attachRequestRef.current = requestId;
    dispatch({ type: 'dismissAttachmentError' });
    bridge.post({ type: 'attachFiles', requestId });
  };

  const removeAttachment = (id: string): void => {
    markComposerEdited();
    dispatch({ type: 'removeAttachment', id });
  };

  const cancelQueuedTurn = (id: string): void => {
    dispatch({ type: 'cancelQueuedTurn', id });
    bridge.post({ type: 'cancelQueuedTurn', id });
  };

  // A paste the webview can fully read is turned into a local attachment and the
  // default is prevented so no garbage text lands in the textarea. Plain text
  // paste is untouched: it falls through to the browser's normal insertion. Any
  // non-text, non-image clipboard content is handed to the host, which reports
  // whether it could be attached instead of pasting nothing.
  const onComposerPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = event.clipboardData?.items;
    if (!items) {
      return;
    }
    const files: File[] = [];
    let sawText = false;
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      } else if (item.kind === 'string') {
        // Any text-ish item (plain or rich) is left to the browser's normal
        // insertion, so existing typing/paste behaviour is unchanged.
        sawText = true;
      }
    }
    if (files.length === 0) {
      if (!sawText) {
        dispatch({ type: 'dismissAttachmentError' });
        bridge.post({ type: 'readClipboard', requestId: `paste_${Date.now()}` });
      }
      return;
    }
    event.preventDefault();
    markComposerEdited();
    void Promise.all(files.map(readClipboardFile)).then((attachments) => {
      const usable = attachments.filter((attachment): attachment is Attachment => attachment !== undefined);
      const skipped = attachments.length - usable.length;
      if (usable.length > 0) {
        dispatch({ type: 'addAttachments', attachments: usable });
      }
      if (skipped > 0) {
        dispatch({
          type: 'attachmentError',
          message:
            skipped === 1
              ? 'One pasted item could not be attached because it was unreadable, unsupported, or too large.'
              : `${skipped} pasted items could not be attached because they were unreadable, unsupported, or too large.`
        });
      }
    });
  };

  const cancel = (): void => {
    dispatch({ type: 'dismissNotice' });
    bridge.post({ type: 'cancelTurn' });
  };

  const retryLastTurn = (noticeText: string): void => {
    if (state.restoring || pending || state.pendingQuestion || state.modeSwitch) {
      return;
    }
    // Continue the unfinished turn. The original prompt and the work already
    // done stay in the thread; sending them again would start that work over.
    const text = continueAfterStopInstruction();
    followSentMessage();
    setHistoryStale(true);
    startTransition(() => {
      dispatch({ type: 'dismissStatusNotice', text: noticeText });
      dispatch({ type: 'localUserMessage', text });
    });
    bridge.post({
      type: 'sendTurn',
      text,
      backendId: state.selectedBackendId,
      model: state.selectedModel,
      permissionLevel: state.permissionLevel
    });
  };

  const retryQuestion = (noticeText: string): void => {
    // Remove the warning even when an open card makes a new turn impossible:
    // the card itself is the actionable surface in that case.
    startTransition(() => dispatch({ type: 'dismissStatusNotice', text: noticeText }));
    if (state.restoring || pending || state.pendingQuestion || state.modeSwitch) {
      return;
    }
    const text = questionRetryInstruction();
    followSentMessage();
    setHistoryStale(true);
    startTransition(() => dispatch({ type: 'localUserMessage', text }));
    bridge.post({
      type: 'retryQuestion',
      backendId: state.selectedBackendId,
      model: state.selectedModel,
      permissionLevel: state.permissionLevel
    });
  };

  const dismissNoticeRow = (noticeText?: string, preserveBusy = false): void => {
    if (noticeText) {
      dispatch({ type: 'dismissStatusNotice', text: noticeText, preserveBusy });
    } else {
      dispatch({ type: 'dismissNotice' });
    }
  };

  // Point at the evidence that already exists in its owning card. Focusing a
  // control inside the card keeps the target real without adding a tab stop.
  const focusAttentionEvidence = (kind: AttentionKind): void => {
    attentionFocusSeq.current += 1;
    setAttentionFocus({ kind, nonce: attentionFocusSeq.current });
  };

  const runNoticeAction = (action: NoticeAction, noticeText?: string): void => {
    if (action === 'preparePlanFollowUp' || action === 'prepareCheckFollowUp') {
      const kind: AttentionKind = action === 'preparePlanFollowUp' ? 'plan-remaining' : 'check-failed';
      // Existing draft or files are the user's own work: never replace them.
      if (draft.length > 0 || state.attachments.length > 0) {
        dismissNoticeRow(noticeText, true);
        focusAttentionEvidence(kind);
        return;
      }
      // The composer is not free to accept text: leave it empty and point at
      // the card the notice is about. A running turn keeps running.
      if (state.busy || state.restoring || pending || state.pendingQuestion || state.modeSwitch) {
        dismissNoticeRow(noticeText, true);
        focusAttentionEvidence(kind);
        return;
      }
      setDraft(attentionFollowUpText(kind));
      dismissNoticeRow(noticeText, true);
      composerInputRef.current?.focus();
      return;
    }
    if (action === 'retry') {
      retryLastTurn(noticeText ?? '');
      return;
    }
    if (action === 'retryQuestion') {
      retryQuestion(noticeText ?? '');
      return;
    }
    dispatch({ type: 'dismissNotice' });
    if (action === 'refresh') {
      dispatch({ type: 'refresh' });
      bridge.post({ type: 'refresh' });
      return;
    }
    bridge.post({ type: action, backendId: state.selectedBackendId ?? 'ollama' });
  };

  // While an approval is pending the turn is blocked at the backend, so the
  // composer and Send are locked until a decision arrives.
  const asking = Boolean(state.pendingQuestion);
  const composerIntent = sendIntent({
    busy: state.busy,
    backendId: active?.id,
    backendStatus: active?.status,
    text: draft,
    attachmentCount: state.attachments.length,
    restoring: state.restoring,
    pendingApproval: Boolean(pending),
    askingQuestion: asking,
    modeSwitch: Boolean(state.modeSwitch)
  });
  // A busy send is labelled for what it will do once content exists. Queueing
  // is the only option when a chip is attached or the provider cannot steer.
  const hasComposerContent = draft.trim().length > 0 || state.attachments.length > 0;
  const busyActionLabel =
    state.attachments.length > 0 || !acceptsSteer(active?.id) ? 'Queue message' : 'Send';
  const canSend = composerIntent !== 'blocked' && !(state.busy && queuePending);
  // Queued turns keep the backend/model/permission snapshot they were accepted
  // with, so those controls stay locked until the turn and the queue finish.
  const controlsLocked = state.busy || state.queuedTurns.length > 0;
  const controlsLockedReason = 'Available when the current turn and queued messages finish.';

  const dictationModel = state.settings?.defaults.dictationModel?.trim() ?? '';
  const micPhase = dictationVisual(dictationStatus, listening, cleaning);
  const composerModeClass = `composer-action--mode-${state.mode}`;
  const micDisabled = !dictationModel;
  const micGestureHint = cleaning
    ? undefined
    : dictationGesture === 'ptt'
      ? 'Release to stop'
      : listening
        ? 'Click to stop'
        : 'Click to dictate, or hold to talk';
  const micTitle = !state.settings
    ? 'Loading settings…'
    : !dictationModel
      ? 'Choose a dictation model in Settings.'
      : dictationStatus && micGestureHint
        ? `${dictationStatus} â€” ${micGestureHint}`
        : dictationStatus ?? micGestureHint ?? 'Dictate a message';
  const showMic =
    listening || cleaning || (!state.busy && draft.trim().length === 0 && state.attachments.length === 0);

  const setDictationGestureBoth = (gesture: 'idle' | 'latched' | 'ptt'): void => {
    dictationGestureRef.current = gesture;
    setDictationGesture(gesture);
  };

  const stopDictation = (): void => {
    const requestId = dictationRequestRef.current;
    if (!requestId || !listeningRef.current) {
      return;
    }
    listeningRef.current = false;
    setListening(false);
    setCleaning(true);
    setDictationStatus('Finishing the recordingâ€¦');
    bridge.post({ type: 'stopDictation', requestId });
  };
  stopDictationRef.current = stopDictation;

  const startDictation = (): void => {
    if (cleaning || listeningRef.current) {
      return;
    }
    const requestId = `dictation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    dictationRequestRef.current = requestId;
    listeningRef.current = true;
    dispatch({ type: 'dismissAttachmentError' });
    setListening(true);
    setDictationStatus('Starting the microphoneâ€¦');
    bridge.post({ type: 'startDictation', requestId });
  };

  const clearMicHold = (): void => {
    window.clearTimeout(micHoldTimerRef.current);
    micHoldTimerRef.current = undefined;
  };

  const latchDictation = (): void => {
    if (cleaning) {
      return;
    }
    if (listeningRef.current || dictationGestureRef.current === 'latched') {
      setDictationGestureBoth('idle');
      stopDictation();
      return;
    }
    setDictationGestureBoth('latched');
    startDictation();
  };

  const onMicPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0 || micDisabled || cleaning) {
      return;
    }
    micPointerRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    micHeldRef.current = false;
    micPressStartedRef.current = false;
    clearMicHold();
    if (dictationGestureRef.current === 'idle' && !listeningRef.current) {
      micPressStartedRef.current = true;
      startDictation();
    }
    micHoldTimerRef.current = window.setTimeout(() => {
      micHeldRef.current = true;
      if (micPressStartedRef.current) {
        setDictationGestureBoth('ptt');
      }
    }, 400);
  };

  const onMicPointerUp = (): void => {
    if (!micPointerRef.current) {
      return;
    }
    micPointerRef.current = false;
    clearMicHold();
    const held = micHeldRef.current;
    micHeldRef.current = false;
    if (dictationGestureRef.current === 'ptt') {
      micPressStartedRef.current = false;
      setDictationGestureBoth('idle');
      stopDictation();
      return;
    }
    if (micPressStartedRef.current) {
      micPressStartedRef.current = false;
      setDictationGestureBoth('latched');
      return;
    }
    if (cleaning || held) {
      return;
    }
    latchDictation();
  };

  const onMicPointerCancel = (): void => {
    const stopPress = dictationGestureRef.current === 'ptt' || micPressStartedRef.current;
    micPointerRef.current = false;
    micPressStartedRef.current = false;
    clearMicHold();
    micHeldRef.current = false;
    if (stopPress) {
      setDictationGestureBoth('idle');
      stopDictation();
    }
  };

  onDictationRef.current = (message) => {
    if (message.requestId !== dictationRequestRef.current) {
      return;
    }
    if (message.type === 'dictationStatus') {
      setDictationStatus(message.message);
      return;
    }
    dictationRequestRef.current = undefined;
    listeningRef.current = false;
    dictationGestureRef.current = 'idle';
    setDictationGesture('idle');
    setListening(false);
    setCleaning(false);
    setDictationStatus(undefined);
    if (message.type === 'dictationError') {
      if (message.raw?.trim()) {
        markComposerEdited();
        setDraft((current) => appendDraft(current, message.raw as string));
      }
      if (message.message !== 'No speech was heard.') {
        dispatch({ type: 'attachmentError', message: message.message });
      }
      return;
    }
    if (!message.text.trim()) {
      dispatch({ type: 'attachmentError', message: 'Dictation cleanup returned nothing.' });
      return;
    }
    const next = appendDraft(draft, message.text);
    const locked =
      state.restoring || Boolean(pending) || asking || state.busy || active?.status !== 'available' || !next.trim();
    if (locked) {
      markComposerEdited();
      setDraft(next);
      return;
    }
    const text = next.trim();
    followSentMessage();
    dispatch({ type: 'localUserMessage', text, attachments: state.attachments });
    dispatch({ type: 'dismissNotice' });
    dispatch({ type: 'dismissAttachmentError' });
    setHistoryStale(true);
    bridge.post({
      type: 'sendTurn',
      text,
      backendId: state.selectedBackendId,
      model: state.selectedModel,
      permissionLevel: state.permissionLevel,
      attachments: state.attachments
    });
    setDraft('');
    publishComposer(activeChatTabIdRef.current, '', []);
  };

  const newConversation = (): void => {
    setHistoryOpen(false);
    setHistoryQuery('');
    const text = draft;
    const attachments = state.attachments.map((attachment) => ({ ...attachment }));
    if (text.trim().length > 0 || attachments.length > 0) {
      composerCarryRef.current = { text, attachments };
      composerCarryFromRef.current = activeChatTabIdRef.current;
    }
    bridge.post({ type: 'newChat', text, attachments });
    for (const attachment of attachments) {
      if (attachment.dataUrl) {
        composerSentBytesRef.current.add(attachment.id);
      }
    }
  };

  const triggerLabel =
    active?.status === 'available' && selectedModelLabel
      ? selectedModelLabel
      : switcherProviders.length === 0
        ? 'No models yet'
        : 'Choose a model';

  // The inline per-model settings panel reads the host-resolved capability
  // snapshot for the selected model. Nothing here writes to `globalState`; a
  // change is posted to the host, which clamps and echoes it back as a fresh
  // snapshot, so the panel always shows the value that will be sent.
  const modelSettings = state.modelCapability ? modelSettingsView(state.modelCapability) : undefined;
  const thinkingLabel =
    modelSettings?.thinking.available && modelSettings.thinking.value ? modelSettings.thinking.value : undefined;
  const contextMax = resolveContextMax({
    settingsWindow: state.modelCapability?.settings.contextWindow,
    capabilityMax: state.modelCapability?.capabilities?.contextWindow.max,
    capabilityDefault: state.modelCapability?.capabilities?.contextWindow.default,
    reportedWindow: state.contextWindowTokens
  });

  const conversationTokens = useMemo(
    () => estimateConversationTokens(state.transcript),
    [state.transcript]
  );
  const transcriptEntries = useMemo(() => groupTranscript(state.transcript), [state.transcript]);
  const visibleTurns = useMemo(
    () =>
      state.turnChanges.filter((turn) => (turn.review ? turn.review.files.length > 0 : turn.entries.length > 0)),
    [state.turnChanges]
  );
  const placedTurns = useMemo(
    () => placeTurnChanges(state.transcript, visibleTurns, state.checkpoints ?? []),
    [state.transcript, visibleTurns, state.checkpoints]
  );
  const speakers = useMemo(
    () => speakerRows(transcriptEntries, !state.busy),
    [transcriptEntries, state.busy]
  );
  const elapsedNotes = useMemo(() => turnElapsedNotes(transcriptEntries), [transcriptEntries]);
  const backgroundBusy =
    state.busy || state.changeDeciding || state.loadingOlder || state.restoring || state.planRevising;

  const updateModelSetting = (field: ModelSettingField, value: number | string): void => {
    if (!state.selectedBackendId || !state.selectedModel) {
      return;
    }
    // The host clamps and echoes this back; the panel shows only what it returned.
    const settings: ModelSettingOverrides =
      field === 'contextWindow' ? { contextWindow: Number(value) } : { thinking: value as ThinkingLevel };
    bridge.post({
      type: 'setModelSettings',
      providerId: state.selectedBackendId,
      modelId: state.selectedModel,
      settings
    });
  };

  const resetModelSettingField = (field: ModelSettingField): void => {
    if (!state.selectedBackendId || !state.selectedModel) {
      return;
    }
    bridge.post({
      type: 'resetModelSettingField',
      providerId: state.selectedBackendId,
      modelId: state.selectedModel,
      field
    });
  };

  const resetAllModelSettings = (): void => {
    if (!state.selectedBackendId || !state.selectedModel) {
      return;
    }
    bridge.post({
      type: 'resetModelSettings',
      providerId: state.selectedBackendId,
      modelId: state.selectedModel
    });
  };

  const setIncludeViewedFile = (included: boolean): void => {
    dispatch({ type: 'setIncludeViewedFile', included });
    bridge.post({ type: 'setIncludeViewedFile', included });
  };

  const openContextFile = (path: string): void => {
    if (path) {
      bridge.post({ type: 'openContextFile', path });
    }
  };

  const retryModelCapability = (): void => {
    if (state.selectedBackendId && state.selectedModel) {
      dispatch({ type: 'modelCapabilityLoading' });
      bridge.post({
        type: 'getModelCapability',
        providerId: state.selectedBackendId,
        modelId: state.selectedModel
      });
    }
  };

  // ---- Plan surface -------------------------------------------------------
  // The plan is a single artifact owned by the host: build, reject and revise
  // are all posted there, and the host echoes the resulting plan back. Nothing
  // here mutates the plan locally, so the displayed plan can never drift from
  // the persisted one.
  const openPlan = (): void => {
    bridge.post({ type: 'openPlanFile' });
  };

  const buildPlan = (): void => {
    bridge.post({ type: 'buildPlan' });
  };

  const rejectPlan = (): void => {
    dispatch({ type: 'cancelRejectConfirmation' });
    bridge.post({ type: 'rejectPlan' });
  };

  // ---- Checkpoints --------------------------------------------------------
  // Restoring is destructive and never implicit. The click asks the host what
  // would be rewound, and only an explicit confirm posts the restore.
  const restoreCheckpoint = (messageId: string): void => {
    const threadId = activeThreadIdRef.current;
    const backendId = selectedBackendIdRef.current;
    if (!threadId || !backendId) {
      return;
    }
    if ((hostFlightsRef.current.restorePreview?.length ?? 0) > 0) {
      return;
    }
    runHostClick('restorePreview', () => {
      bridge.post({ type: 'changes/previewRestore', backendId, threadId, messageId });
    });
  };

  const answerModeSwitch = (accept: boolean): void => {
    const requestId = modeSwitchRequestRef.current ?? state.modeSwitch?.requestId;
    modeSwitchRequestRef.current = undefined;
    dispatch({ type: 'clearModeSwitch' });
    if (requestId) {
      bridge.post({ type: 'modeSwitchChoice', requestId, accept });
    }
  };

  const confirmRestore = (): void => {
    const confirmation = state.restoreConfirmation;
    if (!confirmation) {
      return;
    }
    const threadId = activeThreadIdRef.current;
    const backendId = selectedBackendIdRef.current;
    if (!threadId || !backendId) {
      dispatch({ type: 'cancelRestoreConfirmation' });
      return;
    }
    if ((hostFlightsRef.current.restore?.length ?? 0) > 0) {
      return;
    }
    const messageId = confirmation.messageId;
    runHostClick('restore', () => {
      startTransition(() => dispatch({ type: 'cancelRestoreConfirmation' }));
      bridge.post({
        type: 'changes/restoreCheckpoint',
        backendId,
        threadId,
        messageId
      });
    });
  };

  // Undo a restore by restoring the snapshot captured just before it, including
  // the messages and plans the restore removed.
  const undoRestore = (restorePointId?: string): void => {
    const threadId = activeThreadIdRef.current;
    const backendId = selectedBackendIdRef.current;
    if (!restorePointId || !threadId || !backendId) {
      return;
    }
    if ((hostFlightsRef.current.restore?.length ?? 0) > 0) {
      return;
    }
    runHostClick('restore', () => {
      bridge.post({
        type: 'changes/restoreCheckpoint',
        backendId,
        threadId,
        restorePointId
      });
    });
  };

  // A revision is a normal message attached to the plan card: it goes out as a
  // turn, and the card shows the in-flight state until the host returns the
  // updated plan. The composer is not used, so there is no second place to
  // start a turn.
  const revisePlan = (text: string): void => {
    if (state.busy || !state.plan) {
      return;
    }
    followSentMessage();
    setHistoryStale(true);
    const backendId = state.selectedBackendId;
    const model = state.selectedModel;
    const permissionLevel = state.permissionLevel;
    startTransition(() => {
      dispatch({ type: 'planRevising' });
      dispatch({ type: 'localUserMessage', text });
    });
    bridge.post({
      type: 'sendTurn',
      text,
      backendId,
      model,
      permissionLevel,
      updatePlan: true
    });
  };

  // ---- Change review ------------------------------------------------------
  // The review surface reflects the host's snapshot and posts every decision to
  // the host; nothing is decided locally. Accept writes nothing, reject is
  // destructive and only posts after the confirmation names its paths.
  const openChangeFile = (absPath: string): void => {
    bridge.post({ type: 'openContextFile', path: absPath });
  };

  // The full-fidelity review paths. The workbench owns the diff and changes
  // views; the host serves the pre-turn side from the journal, so nothing is
  // computed or written here. Each falls back to a notice, never a throw.
  const openChangeDiff = (turnId: string, path: string): void => {
    const threadId = activeThreadIdRef.current;
    const backendId = selectedBackendIdRef.current;
    if (!threadId || !backendId) {
      return;
    }
    bridge.post({ type: 'changes/openDiff', backendId, threadId, turnId, path });
  };

  const openChangeView = (turnId: string): void => {
    const threadId = activeThreadIdRef.current;
    const backendId = selectedBackendIdRef.current;
    if (!threadId || !backendId) {
      return;
    }
    bridge.post({ type: 'changes/openView', backendId, threadId, turnId });
  };

  const revealChangeInSourceControl = (absPath?: string): void => {
    bridge.post({ type: 'changes/reveal', ...(absPath ? { path: absPath } : {}) });
  };

  /**
   * Post a decision for one file or the whole turn. A conflict resolution, when
   * given, is the user's explicit answer to a conflict the host reported: the
   * host never overwrites silently, so this is the only way one is sent.
   */
  const postChangeDecision = (
    turnId: string,
    target: { kind: 'file'; path: string } | { kind: 'all' },
    decision: 'accepted' | 'rejected',
    conflictResolution?: ConflictResolution,
    overrideChecks?: boolean
  ): void => {
    const threadId = activeThreadIdRef.current;
    const backendId = selectedBackendIdRef.current;
    if (!threadId || !backendId) {
      return;
    }
    if ((hostFlightsRef.current.decide?.length ?? 0) > 0) {
      return;
    }
    const message =
      target.kind === 'all'
        ? {
            type: 'changes/decideAll' as const,
            backendId,
            threadId,
            turnId,
            decision,
            ...(conflictResolution !== undefined ? { conflictResolution } : {}),
            ...(overrideChecks !== undefined ? { overrideChecks } : {})
          }
        : {
            type: 'changes/decide' as const,
            backendId,
            threadId,
            turnId,
            path: target.path,
            decision,
            ...(conflictResolution !== undefined ? { conflictResolution } : {}),
            ...(overrideChecks !== undefined ? { overrideChecks } : {})
          };
    runHostClick('decide', () => {
      startTransition(() => dispatch({ type: 'changeDeciding', value: true }));
      bridge.post(message);
    });
  };

  const keepChange = (turnId: string, path: string, overrideChecks?: boolean): void => {
    postChangeDecision(turnId, { kind: 'file', path }, 'accepted', undefined, overrideChecks);
  };

  const resolveConflict = (turnId: string, path: string, resolution: ConflictResolution): void => {
    // Any explicit choice is a reject against the file: keep-current records the
    // decision and writes nothing, overwrite-pre-turn restores the pre-turn bytes.
    postChangeDecision(turnId, { kind: 'file', path }, 'rejected', resolution);
  };

  const keepAll = (turnId: string, overrideChecks?: boolean): void => {
    postChangeDecision(turnId, { kind: 'all' }, 'accepted', undefined, overrideChecks);
  };

  const loadChangeHunks = (turnId: string, path: string): void => {
    const backendId = state.selectedBackendId;
    const threadId = state.activeThreadId;
    if (!backendId || !threadId) {
      return;
    }
    bridge.post({ type: 'changes/hunks', backendId, threadId, turnId, path });
  };

  /**
   * Confirm the pending destructive reject. The scope was captured when the
   * confirmation opened, so the action matches exactly what the user confirmed.
   */
  const confirmChangeReject = (): void => {
    const confirmation = state.changeRejectConfirm;
    if (!confirmation) {
      return;
    }
    if (confirmation.scope === 'all') {
      postChangeDecision(confirmation.turnId, { kind: 'all' }, 'rejected');
    } else {
      const path = confirmation.paths[0];
      if (path) {
        postChangeDecision(confirmation.turnId, { kind: 'file', path }, 'rejected');
      }
    }
  };


  onQueueRejectedRef.current = (): void => {
    queueAwaitRef.current = undefined;
    if (queueTimerRef.current !== undefined) {
      window.clearTimeout(queueTimerRef.current);
      queueTimerRef.current = undefined;
    }
    setQueuePending(false);
  };

  onQueuedTurnsRef.current = (entries): void => {
    dispatch({ type: 'queuedTurns', entries });
    const queued = queueAwaitRef.current;
    if (!queued || !queuedEntryMatches(entries, queued.text, queued.attachments.length)) {
      return;
    }
    // The host accepted the message. Clear the composer only if it still holds
    // exactly what was queued; text typed in the meantime must survive.
    if (
      draftMirrorRef.current.trim() === queued.text &&
      sameAttachmentIds(attachmentsMirrorRef.current, queued.attachments)
    ) {
      setDraft('');
      dispatch({ type: 'setAttachments', attachments: [] });
      publishComposer(activeChatTabIdRef.current, '', []);
    }
    queueAwaitRef.current = undefined;
    if (queueTimerRef.current !== undefined) {
      window.clearTimeout(queueTimerRef.current);
      queueTimerRef.current = undefined;
    }
    setQueuePending(false);
  };

  // A `queue:true` send can race the end of the host turn: the host dispatches it
  // normally and posts its stored row instead of a queue echo. The same draft
  // rules apply, so the composer clears (and its timeout is cancelled) rather
  // than later claiming the message was never queued.
  onUserMessageSentRef.current = (message): void => {
    // An injected orchestration row never owns the composer draft.
    if (message.orchestration) {
      return;
    }
    const queued = queueAwaitRef.current;
    if (!queued) {
      return;
    }
    if (message.backendId !== selectedBackendIdRef.current) {
      return;
    }
    if (activeThreadIdRef.current && message.threadId !== activeThreadIdRef.current) {
      return;
    }
    if (message.text.trim() !== queued.text) {
      return;
    }
    if ((message.attachments?.length ?? 0) !== queued.attachments.length) {
      return;
    }
    if (
      draftMirrorRef.current.trim() === queued.text &&
      sameAttachmentIds(attachmentsMirrorRef.current, queued.attachments)
    ) {
      setDraft('');
      dispatch({ type: 'setAttachments', attachments: [] });
      publishComposer(activeChatTabIdRef.current, '', []);
    }
    queueAwaitRef.current = undefined;
    if (queueTimerRef.current !== undefined) {
      window.clearTimeout(queueTimerRef.current);
      queueTimerRef.current = undefined;
    }
    setQueuePending(false);
  };

  const previousChatTabRef = useRef(activeChatTabId);
  onComposerDraftRef.current = (message) => {
    if (
      composerCarryRef.current &&
      message.tabId === composerCarryFromRef.current &&
      message.tabId === activeChatTabIdRef.current
    ) {
      composerCarryRef.current = undefined;
      composerCarryFromRef.current = undefined;
    }
    const incoming = { text: message.text, attachments: message.attachments };
    const editingThisTab = message.tabId === activeChatTabIdRef.current && composerDirtyRef.current;
    if (!acceptComposerRestore(composerMemoryRef.current, message.tabId, editingThisTab, incoming)) {
      return;
    }
    const restored: ComposerDraft = {
      text: message.text,
      attachments: message.attachments.map((attachment) => ({ ...attachment }))
    };
    composerMemoryRef.current[message.tabId] = restored;
    for (const attachment of restored.attachments) {
      if (attachment.dataUrl || attachment.path) {
        composerSentBytesRef.current.add(attachment.id);
      }
    }
    composerSkipPublishRef.current = false;
    if (message.tabId === activeChatTabIdRef.current) {
      setDraft(restored.text);
      dispatch({ type: 'setAttachments', attachments: restored.attachments });
    }
  };
  useEffect(() => {
    const previous = previousChatTabRef.current;
    const nextId = activeChatTabId;
    if (previous !== nextId) {
      // A queue echo belongs to the chat that was visible when it was posted.
      // The host republishes this tab's queue after the switch.
      queueAwaitRef.current = undefined;
      if (queueTimerRef.current !== undefined) {
        window.clearTimeout(queueTimerRef.current);
        queueTimerRef.current = undefined;
      }
      setQueuePending(false);
    }
    if (!nextId) {
      previousChatTabRef.current = nextId;
      return;
    }
    // The composer can be typed in before the first tab id exists. Keep that
    // text on the tab instead of replacing it with a host restore.
    if (
      !previous &&
      (composerDirtyRef.current ||
        draftMirrorRef.current.length > 0 ||
        attachmentsMirrorRef.current.length > 0)
    ) {
      composerMemoryRef.current[nextId] = {
        text: draftMirrorRef.current,
        attachments: attachmentsMirrorRef.current.map((attachment) => ({ ...attachment }))
      };
      previousChatTabRef.current = nextId;
      composerSkipPublishRef.current = false;
      return;
    }
    const carry = composerCarryRef.current;
    const switched = switchComposerDraft(
      composerMemoryRef.current,
      previous,
      nextId,
      { text: draftMirrorRef.current, attachments: attachmentsMirrorRef.current },
      previous !== nextId ? carry : undefined
    );
    composerMemoryRef.current = switched.remembered;
    if (switched.carried) {
      composerCarryRef.current = undefined;
      composerCarryFromRef.current = undefined;
    }
    previousChatTabRef.current = nextId;
    if (previous === nextId) {
      return;
    }
    composerDirtyRef.current = false;
    composerSkipPublishRef.current = switched.waitForHost;
    if (previous) {
      const saved = switched.remembered[previous];
      if (saved) {
        bridge.post({
          type: 'composerDraft',
          tabId: previous,
          text: saved.text,
          attachments: hostAttachments(saved.attachments, composerSentBytesRef.current)
        });
      }
    }
    setDraft(switched.next.text);
    dispatch({ type: 'setAttachments', attachments: switched.next.attachments });
  }, [activeChatTabId]);
  useEffect(() => {
    if (composerSkipPublishRef.current) {
      return;
    }
    const tabId = activeChatTabId;
    const text = draft;
    const attachments = state.attachments;
    const handle = window.setTimeout(() => {
      publishComposer(tabId, text, attachments);
    }, 80);
    return () => window.clearTimeout(handle);
  }, [draft, state.attachments, activeChatTabId]);
  useEffect(() => {
    const flush = (): void => {
      if (composerSkipPublishRef.current) {
        return;
      }
      publishComposer(activeChatTabIdRef.current, draftMirrorRef.current, attachmentsMirrorRef.current);
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  const tabStrip = (
    <ChatTabStrip
      tabs={state.chatTabs}
      activity={state.threadActivity}
      actions={
        <span className="chat-tabs__actions">
          <div className="history-anchor" ref={historyRef}>
            <button
              className="icon-btn"
              type="button"
              aria-label="Conversation history"
              title="Conversation history"
              aria-expanded={historyOpen}
              aria-controls="history-panel"
              disabled={state.availability.length === 0}
              onClick={toggleHistory}
            >
              <HistoryIcon />
            </button>
            {historyOpen ? (
              <HistoryPanel
                threads={history}
                loading={historyPending}
                activeThreadId={state.activeThreadId}
                selectedBackendId={state.selectedBackendId}
                threadActivity={state.threadActivity}
                query={historyQuery}
                onQueryChange={setHistoryQuery}
                onSelect={resumeThread}
              />
            ) : null}
          </div>
          <button
            className="icon-btn icon-btn--primary"
            type="button"
            aria-label="New chat"
            title="New chat"
            onClick={newConversation}
          >
            <PlusIcon />
          </button>
        </span>
      }
    />
  );

  // The settings and rules screens replace the chat surface inside the same
  // view; the model and composer panels float over the chat without replacing
  // it. The rules screen is the one-click destination of the revocation
  // route from an `always` decision.
  if (state.settingsOpen) {
    return (
      <main className="app">
      <div className="chat-tab-body">
      <SettingsScreen
        settings={state.settings}
        settingsSave={state.settingsSave}
        connectionTest={state.connectionTest}
        settingsProvider={state.settingsProvider}
        codexVersionCheck={state.codexVersionCheck}
        onBack={closeSettings}
        onSave={saveSettings}
        onSaveToken={saveOllamaToken}
        onClearToken={clearOllamaToken}
        onSaveZenToken={saveOpencodeZenToken}
        onClearZenToken={clearOpencodeZenToken}
        onTestConnection={testConnection}
        onValidateCodexVersion={validateCodexVersion}
        opencodeUpgrade={state.opencodeUpgrade}
        onUpgradeOpencode={upgradeOpencode}
        opencodeInstall={state.opencodeInstall}
        onInstallOpencode={installOpencode}
        zvecGrep={state.zvecGrep}
        onSetZvecGrep={setZvecGrep}
        astGrep={state.astGrep}
        onSetAstGrep={setAstGrep}
        astGrepInstall={state.astGrepInstall}
        onInstallAstGrep={installAstGrep}
        onUpgradeAstGrep={upgradeAstGrep}
        zvecGrepInstall={state.zvecGrepInstall}
        onInstallZvecGrep={installZvecGrep}
        skillAction={state.skillAction}
        onSkillAction={runSkillAction}
      />
      </div>
      </main>
    );
  }

  if (state.rulesOpen) {
    return (
      <main className="app">
        {tabStrip}
        <div className="chat-tab-body">
          <RulesScreen
            rules={storedRules}
            onBack={() => dispatch({ type: 'closeRules' })}
            onRevoke={revokeRule}
          />
        </div>
        <BusyCorner busy={backgroundBusy} overlay />
      </main>
    );
  }

  const chatEmpty = state.transcript.length === 0 && !state.restoring;
  const renderTurnCard = (turn: TurnChange): JSX.Element => {
    const review = turn.review;
    if (!review || review.files.length === 0) {
      return (
        <div className="turn-changes" key={turn.turnId}>
          <ChangedFilesStrip entries={turn.entries} onOpenFile={openChangeFile} />
        </div>
      );
    }
    return (
      <div className="turn-changes" key={turn.turnId}>
        <ChangesReview
          review={review}
          busy={state.busy}
          deciding={state.changeDeciding}
          hideFix={state.busy || hasAutomaticCorrection(state.transcript, turn.messageId)}
          fixDisabled={state.startingTurn || state.restoring || Boolean(pending) || asking || Boolean(state.modeSwitch) || active?.status !== 'available'}
          onFix={(text) => {
            if (state.busy || state.startingTurn || state.changeDeciding || state.restoring || pending || asking || state.modeSwitch || active?.status !== 'available') return;
            followSentMessage();
            setHistoryStale(true);
            dispatch({ type: 'localUserMessage', text });
            dispatch({ type: 'setAttachments', attachments: state.attachments });
            dispatch({ type: 'dismissNotice' });
            bridge.post({
              type: 'sendTurn', text,
              backendId: state.selectedBackendId,
              model: state.selectedModel,
              permissionLevel: state.permissionLevel
            });
          }}
          decisionResults={state.changeDecision?.results}
          rejectConfirm={state.changeRejectConfirm?.turnId === review.turnId ? state.changeRejectConfirm : undefined}
          onOpenFile={openChangeFile}
          onOpenDiff={(path) => openChangeDiff(review.turnId, path)}
          onOpenAllInEditor={() => openChangeView(review.turnId)}
          onRevealInSourceControl={revealChangeInSourceControl}
          onKeep={(path, overrideChecks) => keepChange(review.turnId, path, overrideChecks)}
          onRequestReject={(scope, paths) =>
            dispatch({ type: 'requestChangeRejectConfirmation', turnId: review.turnId, scope, paths })
          }
          onCancelReject={() => dispatch({ type: 'cancelChangeRejectConfirmation' })}
          onConfirmReject={confirmChangeReject}
          onKeepAll={(overrideChecks) => keepAll(review.turnId, overrideChecks)}
          onResolveConflict={(path, resolution) => resolveConflict(review.turnId, path, resolution)}
          onLoadHunks={(path) => loadChangeHunks(review.turnId, path)}
        />
      </div>
    );
  };
  const cardsAfter = (entry: TranscriptEntry): JSX.Element[] => {
    const cards: JSX.Element[] = [];
    for (const [afterId, turns] of placedTurns.afterItem) {
      if (!entryContains(entry, afterId)) {
        continue;
      }
      for (const turn of turns) {
        cards.push(renderTurnCard(turn));
      }
    }
    return cards;
  };
  const pinnedItem = pinnedUserId
    ? state.transcript.find((item) => item.id === pinnedUserId && item.kind === 'message' && item.role === 'user')
    : undefined;
  const pinnedPreview = pinnedItem
    ? userMessagePinText(pinnedItem.text, pinnedItem.attachments?.map((attachment) => attachment.name) ?? [])
    : undefined;

  return (
    <main className={chatEmpty ? 'app app--chat-empty' : 'app'}>
      {tabStrip}
      <ReasoningAnnouncements items={state.transcript} />
      <div className="chat-main">
        <div
          className="transcript"
          ref={transcriptRef}
          role="log"
          aria-label="Conversation transcript"
        >
          <div className="user-pin-anchor">
            {pinnedPreview && pinnedUserId ? (
              <button
                key={pinnedUserId}
                type="button"
                className="user-pin"
                aria-label="Show this message"
                title="Show this message"
                onClick={() => jumpToUserMessage(pinnedUserId)}
              >
                <span className={pinnedPreview.length > 140 ? 'user-pin__text user-pin__text--fade' : 'user-pin__text'}>
                  {pinnedPreview}
                </span>
              </button>
            ) : null}
          </div>
          {!state.restoring && state.hasOlderHistory ? (
            <div className="history-more">
              <button type="button" onClick={() => requestOlder(true)} disabled={state.loadingOlder}>
                {state.loadingOlder ? 'Loading earlier messagesâ€¦' : 'Load earlier messages'}
              </button>
            </div>
          ) : null}
          {state.restoring ? (
            <div className="restoring" role="status">
              <span className="spinner" aria-hidden="true" />
              Restoring conversation...
            </div>
          ) : state.transcript.length === 0 && !state.startingTurn && !state.notice ? (
            <EmptyState state={state} dispatch={dispatch} hasAvailable={available.length > 0} />
          ) : (
            transcriptEntries.map((entry) => {
              const entryId = entry.kind === 'item' ? entry.item.id : entry.id;
              const elapsed = elapsedNotes.get(entryId);
              return (
                <Fragment key={entryId}>
                  {entry.kind === 'group' ? (
                    <ActivityGroup family={entry.family} items={entry.items} />
                  ) : entry.kind === 'narration' ? (
                    <NarrationRow
                      message={entry.message}
                      items={entry.items}
                      showSpeaker={speakers.has(entry.id)}
                      providerId={entry.message.backendId ?? active?.id ?? 'ollama'}
                    />
                  ) : (
                    <TranscriptRow
                      item={entry.item}
                      showSpeaker={speakers.has(entry.item.id)}
                      providerId={entry.item.backendId ?? active?.id ?? 'ollama'}
                      pendingId={pending?.id}
                      checkpoint={state.checkpoints?.find((checkpoint) => checkpoint.messageId === entry.item.id)}
                      onDecide={decide}
                      onOpenRules={() => dispatch({ type: 'openRules' })}
                      onRestore={restoreCheckpoint}
                      onViewImage={(images, index) => setImageViewer({ images, index })}
                      onNoticeAction={runNoticeAction}
                    />
                  )}
                  {elapsed != null ? <p className="turn-elapsed">{formatWorked(elapsed)}</p> : null}
                  {cardsAfter(entry)}
                </Fragment>
              );
            })
          )}

          {state.plan && !state.plan.built ? (
            <PlanSurface
              plan={state.plan}
              revising={state.planRevising}
              rejectConfirmationOpen={state.rejectConfirmationOpen}
              busy={state.busy}
              onOpenPlan={openPlan}
              onBuild={buildPlan}
              onOpenReject={() => dispatch({ type: 'requestRejectConfirmation' })}
              onCancelReject={() => dispatch({ type: 'cancelRejectConfirmation' })}
              onReject={rejectPlan}
              onRevise={revisePlan}
            />
          ) : null}

          {state.busy && state.startingTurn ? (
            <div className="turn turn--agent">
              <div className="turn-meta">
                <span className={`provider-dot provider-dot--${active?.id ?? 'ollama'}`} aria-hidden="true" />
                <span className="meta-strong">sideCode</span>
                <span className="stream-status" role="status">
                  <span className="spinner" aria-hidden="true" />
                  Starting
                </span>
              </div>
            </div>
          ) : null}

          {state.restoreResult?.undoPointId && !state.restoreResult.aborted ? (
            <RestoreResultStrip
              result={state.restoreResult}
              onUndo={() => undoRestore(state.restoreResult?.undoPointId)}
            />
          ) : null}

          {state.busy ? (
            <div className="typing-dots" role="status" aria-label="sideCode is working">
              <span />
              <span />
              <span />
            </div>
          ) : null}
          <div className="transcript-end" aria-hidden="true" />
        </div>
        <BusyCorner busy={backgroundBusy} overlay />
      </div>

      <footer className={chatEmpty ? 'composer composer--expanded' : 'composer'}>
        {showBuiltPlanDock(state.plan) ? (
          <div className="todo-dock">
            <PlanSurface
              plan={state.plan}
              revising={state.planRevising}
              rejectConfirmationOpen={state.rejectConfirmationOpen}
              busy={state.busy}
              onOpenPlan={openPlan}
              onBuild={buildPlan}
              onOpenReject={() => dispatch({ type: 'requestRejectConfirmation' })}
              onCancelReject={() => dispatch({ type: 'cancelRejectConfirmation' })}
              onReject={rejectPlan}
              onRevise={revisePlan}
            />
          </div>
        ) : null}
        {state.permissionConfirmationOpen ? (
          <UnrestrictedConfirmation
            onConfirm={confirmPermissionChange}
            onCancel={() => dispatch({ type: 'cancelPermissionConfirmation' })}
          />
        ) : null}
        {pending ? (
          <p className="composer-wait" role="status">
            <span className="spinner" aria-hidden="true" />
            The agent is paused until you answer above.
          </p>
        ) : null}
        <ContextStrip
          view={state.contextView}
          settingsEnabled={state.contextSettingsEnabled}
          exclusions={state.contextExclusions}
          onOpenFile={openContextFile}
          includeViewedFile={state.includeViewedFile}
          onSetIncludeViewedFile={setIncludeViewedFile}
        />
        {state.pendingQuestion ? (
          <QuestionCard
            key={state.pendingQuestion.id}
            request={state.pendingQuestion}
            onSubmit={(answers) => {
              const request = state.pendingQuestion;
              if (!request) {
                return;
              }
              dispatch({ type: 'questionCleared' });
              followSentMessage();
              dispatch({
                type: 'localUserMessage',
                text: formatQuestionAnswers(request.questions, answers),
                opensTurn: false
              });
              bridge.post({ type: 'answerQuestion', requestId: request.id, answers });
            }}
          />
        ) : null}
        <div className="composer-box">
          {state.queuedTurns.length > 0 ? (
            <QueuedTurns
              entries={state.queuedTurns}
              onCancel={cancelQueuedTurn}
              onEscalate={active?.id === 'codex' || active?.id === 'opencode'
                ? (id) => bridge.post({ type: 'escalateQueuedTurn', id })
                : undefined}
              canEscalate={state.busy && active?.status === 'available' && !state.restoring && !pending && !asking && !state.modeSwitch}
            />
          ) : null}
          {state.attachments.length > 0 ? (
            <AttachmentList
              attachments={state.attachments}
              onRemove={removeAttachment}
              onView={(images, index) => setImageViewer({ images, index })}
            />
          ) : null}
          <p className="sr-only" role="status" aria-live="polite">
            {dictationStatus ?? ''}
          </p>
          {state.attachmentError ? (
            <p className="composer-error" role="alert">
              <AlertIcon className="ico ico--xs" />
              <span>{state.attachmentError}</span>
            </p>
          ) : null}
          <label className="sr-only" htmlFor="prompt">
            Message the agent
          </label>
          <textarea
            id="prompt"
            ref={composerInputRef}
            className="composer-input"
            value={draft}
            placeholder={
              state.restoring
                ? 'Restoring conversation...'
                : pending || asking
                  ? 'Waiting for your decision above...'
                  : active?.status === 'available'
                    ? 'Build, Plan or Ask sideCode anything...'
                    : 'No backend available'
            }
            disabled={active?.status !== 'available' || state.restoring || Boolean(pending) || asking}
            rows={1}
            onChange={(event) => {
              markComposerEdited();
              setDraft(event.target.value);
            }}
            onPaste={onComposerPaste}
            onKeyDown={(event) => {
              if (isSubmitEnter(event)) {
                event.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-row">
            {modeSnapshot ? (
              <div className="mode-menu" ref={modeMenuRef}>
                <ModeTrigger
                  snapshot={modeSnapshot}
                  open={modePanelOpen}
                  disabled={Boolean(pending) || asking || controlsLocked}
                  title={controlsLocked ? controlsLockedReason : undefined}
                  onToggle={() => {
                    setModePanelOpen((value) => !value);
                    setPermissionPanelOpen(false);
                    setModelPanelOpen(false);
                    setModelSettingsOpen(false);
                  }}
                />
                {modePanelOpen ? (
                  <ModeMenu
                    snapshot={modeSnapshot}
                    disabled={controlsLocked}
                    onSelect={(mode) => {
                      setModePanelOpen(false);
                      dispatch({ type: 'selectMode', mode });
                      if (state.selectedBackendId) {
                        bridge.post({ type: 'selectMode', mode, backendId: state.selectedBackendId });
                      }
                    }}
                    onClose={() => setModePanelOpen(false)}
                  />
                ) : null}
              </div>
            ) : null}
            {hasApprovalChannel && permissionOptions.length > 0 ? (
              <div className={permissionPopup.className} ref={permissionPopup.ref}>
                <PermissionTrigger
                  options={permissionOptions}
                  selected={state.permissionLevel}
                  open={permissionPanelOpen}
                  disabled={Boolean(pending) || asking || controlsLocked}
                  title={controlsLocked ? controlsLockedReason : undefined}
                  onToggle={() => {
                    setPermissionPanelOpen((value) => !value);
                    setModePanelOpen(false);
                    setModelPanelOpen(false);
                    setModelSettingsOpen(false);
                  }}
                />
                {permissionPanelOpen ? (
                  <PermissionPanel
                    options={permissionOptions}
                    selected={state.permissionLevel}
                    onSelect={(option) => {
                      setPermissionPanelOpen(false);
                      selectPermission(option);
                    }}
                    onOpenRules={() => dispatch({ type: 'openRules' })}
                    onClose={() => setPermissionPanelOpen(false)}
                  />
                ) : null}
              </div>
            ) : null}
            <div className={modelPopup.className} ref={modelPopup.ref}>
              <button
                className="control-trigger model-trigger"
                type="button"
                aria-haspopup="dialog"
                aria-expanded={modelPanelOpen}
                aria-controls="model-panel"
                aria-label={`Model: ${triggerLabel}`}
                title={controlsLocked ? controlsLockedReason : triggerLabel}
                disabled={Boolean(pending) || controlsLocked}
                onClick={() => {
                  setModePanelOpen(false);
                  setPermissionPanelOpen(false);
                  setModelSettingsOpen(false);
                  toggleModelPanel();
                }}
              >
                {active?.status === 'available' && selectedModelLabel ? null : (
                  <span className="trigger-label">Model</span>
                )}
                {active?.status === 'available' ? (
                  <span className={`provider-dot provider-dot--${active.id}`} aria-hidden="true" />
                ) : null}
                <span className="trigger-model">{triggerLabel}</span>
                <ChevronDownIcon className="control-chevron" />
              </button>
              {modelPanelOpen ? (
                <ModelPanel
                  providers={switcherProviders}
                  models={state.models}
                  modelErrors={state.modelErrors}
                  selectedBackendId={state.selectedBackendId}
                  selectedModel={state.selectedModel}
                  filter={modelFilter}
                  onFilterChange={setModelFilter}
                  onClose={() => {
                    setModelPanelOpen(false);
                    setModelFilter('');
                  }}
                  onSetToken={(backendId) => bridge.post({ type: 'setToken', backendId })}
                  onRetry={(backendId) => dispatch({ type: 'clearModels', backendId })}
                  dispatch={dispatch}
                />
              ) : null}
            </div>
            {state.selectedBackendId && state.selectedModel ? (
              <div className={modelSettingsPopup.className} ref={modelSettingsPopup.ref}>
                <button
                  className="control-trigger"
                  type="button"
                  aria-haspopup="dialog"
                  aria-expanded={modelSettingsOpen}
                  aria-controls="model-settings-panel"
                  aria-label={thinkingLabel ? `Model settings, thinking ${thinkingLabel}` : 'Model settings'}
                  title={
                    controlsLocked
                      ? controlsLockedReason
                      : thinkingLabel
                        ? `Model settings · ${thinkingLabel}`
                        : 'Model settings'
                  }
                  disabled={Boolean(pending) || asking || controlsLocked}
                  onClick={() => {
                    setModelSettingsOpen((value) => !value);
                    setModePanelOpen(false);
                    setPermissionPanelOpen(false);
                    setModelPanelOpen(false);
                  }}
                >
                  <SlidersIcon className="ico ico--sm" />
                  {thinkingLabel ? <span className="control-label">{thinkingLabel}</span> : null}
                </button>
                {modelSettingsOpen ? (
                  <ModelSettingsPanel
                    view={modelSettings}
                    modelId={state.selectedModel}
                    status={state.modelCapabilityStatus}
                    error={state.modelCapabilityError}
                    conversationTokens={conversationTokens}
                    onContextChange={(value) => updateModelSetting('contextWindow', value)}
                    onThinkingChange={(value) => updateModelSetting('thinking', value)}
                    onResetField={resetModelSettingField}
                    onResetAll={resetAllModelSettings}
                    onRetry={retryModelCapability}
                    onClose={() => setModelSettingsOpen(false)}
                  />
                ) : null}
              </div>
            ) : null}
            <div className="composer-actions">
              <ContextMeter
                usedTokens={state.contextUsedTokens ?? 0}
                maxTokens={contextMax}
                busy={state.busy}
                onCompact={() => {
                  if (contextMax === undefined) {
                    return;
                  }
                  bridge.post({
                    type: 'compactContext',
                    usedTokens: state.contextUsedTokens ?? 0,
                    maxTokens: contextMax
                  });
                }}
              />
              <button
                className="icon-btn composer-attach"
                type="button"
                aria-label="Attach files"
                disabled={active?.status !== 'available' || state.restoring || Boolean(pending) || asking}
                onClick={openFilePicker}
              >
                <PaperclipIcon />
              </button>
              {showMic ? (
                <button
                  className={
                    micPhase === 'idle'
                      ? `icon-btn icon-btn--primary composer-action ${composerModeClass}`
                      : `icon-btn composer-action composer-action--mic-${micPhase} ${composerModeClass}`
                  }
                  type="button"
                  aria-label={listening ? 'Stop dictation' : micPhase === 'idle' ? 'Dictate a message' : micTitle}
                  aria-pressed={listening}
                  aria-busy={micPhase === 'starting' || micPhase === 'downloading' || micPhase === 'working' || undefined}
                  title={micTitle}
                  disabled={micDisabled}
                  onPointerDown={onMicPointerDown}
                  onPointerUp={onMicPointerUp}
                  onPointerCancel={onMicPointerCancel}
                  onClick={(event) => {
                    if (event.detail !== 0) {
                      return;
                    }
                    latchDictation();
                  }}
                  onContextMenu={(event) => event.preventDefault()}
                >
                  <MicSolidIcon />
                </button>
              ) : null}
              {state.busy ? (
                !hasComposerContent ? (
                  <button
                    className={`icon-btn composer-action composer-action--stop ${composerModeClass}`}
                    type="button"
                    aria-label="Stop"
                    title="Stop"
                    onClick={cancel}
                  >
                    <StopSolidIcon />
                  </button>
                ) : (
                  <button
                    className={`icon-btn icon-btn--primary composer-action ${composerModeClass}`}
                    type="button"
                    aria-label={busyActionLabel}
                    title={
                      queuePending
                        ? 'Queueing this messageâ€¦'
                        : busyActionLabel === 'Queue message'
                          ? 'Sends when this turn finishes'
                          : 'Send to this turn'
                    }
                    aria-busy={queuePending || undefined}
                    disabled={!canSend}
                    onClick={() => send()}
                  >
                    <SendSolidIcon />
                  </button>
                )
              ) : showMic ? null : (
                <SendButton
                  className={`icon-btn icon-btn--primary composer-action ${composerModeClass}`}
                  disabled={!canSend}
                  allowQuick={state.mode === 'agent' && Boolean(draft.trim())}
                  resetKey={JSON.stringify([
                    draft, state.attachments.map((item) => item.id), activeChatTabId,
                    state.activeThreadId, state.selectedBackendId, state.selectedModel,
                    state.permissionLevel, state.mode
                  ])}
                  onSend={send}
                />
              )}
            </div>
          </div>
        </div>
      </footer>
      {state.restoreConfirmation ? (
        <RestoreConfirmation
          preview={state.restoreConfirmation}
          onConfirm={confirmRestore}
          onCancel={() => dispatch({ type: 'cancelRestoreConfirmation' })}
        />
      ) : null}
      {state.modeSwitch ? (
        <ModeSwitchModal
          from={state.modeSwitch.from}
          to={state.modeSwitch.to}
          onAccept={() => answerModeSwitch(true)}
          onDecline={() => answerModeSwitch(false)}
        />
      ) : null}
      {imageViewer ? (
        <ImageViewer
          images={imageViewer.images}
          index={imageViewer.index}
          onIndex={(index) => setImageViewer({ images: imageViewer.images, index })}
          onClose={() => setImageViewer(undefined)}
        />
      ) : null}
    </main>
  );
}

