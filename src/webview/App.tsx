import { Fragment, memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type Dispatch, type JSX, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRule,
  BackendAvailability,
  BackendModel,
  FileChange
} from '../backends/types';
import logoUrl from '../../media/melink-logo.png';
import { Markdown } from './Markdown';
import { splitReplyClose } from './replyClose';
import { plainRowText } from './plainRowText';
import { visibleTranscriptText } from './visibleTranscript';
import { historyEntries, historyLoading, type HistoryEntry } from './historyEntries';
import { pinnedUserMessage, userMessagePinText, type UserMessageFrame } from './pinnedUserMessage';
import { defaultProviderTab, sortModels } from './modelList';
import { acceptComposerRestore, hostAttachments, switchComposerDraft, type ComposerDraft } from './composerDraft';
import {
  AlertIcon,
  BackIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  CrossIcon,
  FileIcon,
  HistoryIcon,
  InfoIcon,
  MicSolidIcon,
  PaperclipIcon,
  PersonIcon,
  PlusIcon,
  RefreshIcon,
  RestoreIcon,
  SearchIcon,
  ShieldIcon,
  SlidersIcon,
  SparkIcon,
  SendSolidIcon,
  StopIcon,
  StopSolidIcon,
  TerminalIcon
} from './Icons';
import { SettingsScreen } from './SettingsScreen';
import { TabList, type TabItem } from './Tabs';
import { ContextMeter, ContextStrip } from './ContextStrip';
import { ChangesReview } from './ChangesReview';
import { ChangedFilesStrip } from './ChangedFilesStrip';
import { showBuiltPlanDock } from '../backends/plan';
import { continueAfterStopInstruction } from '../backends/threadRecovery';
import { PlanSurface } from './PlanSurface';
import { backendStatusView, incompatibleBackends, authMismatchBackends } from './backendStatus';
import {
  MODEL_SETTING_LABELS,
  dropsEarlierTurns,
  estimateConversationTokens,
  formatContextTokens,
  formatExactTokens,
  modelSettingsView,
  type ContextControl,
  type ModelSettingsView,
  type ThinkingControl
} from './modelControls';
import {
  createHostBridge,
  decisionLabel,
  decisionMessage,
  decisionScope,
  initialState,
  pendingApproval,
  reduce,
  requestMessage,
  visibleModeSnapshot,
  type Action,
  type AppState,
  type HostBridge,
  type ItemStatus,
  type TranscriptItemView,
  type TurnChange
} from './state';
import { friendlyToolTitle, isRawToolName, isStatusText, toolCardPresentation } from '../backends/toolLabel.ts';
import { prettyPath, setPrettyPathRoots } from './prettyPath.ts';
import { activitySections, activitySummary, groupTranscript, speakerRows, toolBursts, turnElapsedNotes, type ActivityFamily, type TranscriptEntry } from './activityGroups.ts';
import { placeTurnChanges } from './turnChanges.ts';
import { formatWorked } from '../backends/turnTiming.ts';
import { resolveContextMax } from '../backends/contextUsage.ts';
import { DEFAULT_TAB_TITLE, tabTitle } from '../chatTabs.ts';
import type {
  CheckpointView,
  ConflictResolution,
  HostToWebviewMessage,
  ModeSnapshot,
  ModelSettingField,
  ModelSettingOverrides,
  PermissionOption,
  RestoreCheckpointResult,
  RestorePreview,
  SettingsPatch,
  ThinkingLevel
} from '../protocol';
import { deferHostClick, setHostBacklog, useHostActivity } from './hostActivity';
import { createMessagePump, isUrgentHostMessage } from './messagePump';
import type { Attachment, DefaultMode, PermissionLevel } from '../backends/types';
import { modeDescriptor } from '../backends/modes.ts';
import { formatQuestionAnswers } from '../questions';
import { QuestionCard } from './QuestionCard';

/** How the mic button should look while a dictation status is current. */
type DictationVisual = 'idle' | 'starting' | 'listening' | 'downloading' | 'working';

function dictationVisual(status: string | undefined, listening: boolean, cleaning: boolean): DictationVisual {
  const text = status ?? '';
  if (/download/i.test(text)) {
    return 'downloading';
  }
  if (cleaning || /transcrib|prepar|clean|finish|speech model|recording limit/i.test(text)) {
    return 'working';
  }
  if (listening && /listen/i.test(text)) {
    return 'listening';
  }
  if (listening || /start/i.test(text)) {
    return 'starting';
  }
  return 'idle';
}

/** Append a cleaned or raw dictation line without dropping text already in the draft. */
function appendDraft(current: string, addition: string): string {
  const extra = addition.trim();
  if (!extra) {
    return current;
  }
  const base = current.trimEnd();
  return base ? `${base}\n${extra}` : extra;
}

const bridge: HostBridge = createHostBridge();

/** Codex steers in place. Ollama and its opencode runtime continue the same turn. */
function acceptsSteer(backendId: string | undefined): boolean {
  return backendId === 'codex' || backendId === 'ollama';
}

/** Small corner spinner. It subscribes on its own so a click does not repaint the chat. */
function BusyCorner({ busy, overlay = false }: { busy: boolean; overlay?: boolean }): JSX.Element {
  const hostBusy = useHostActivity();
  const active = busy || hostBusy;
  return (
    <div className={overlay ? 'busy-corner-slot busy-corner-slot--overlay' : 'busy-corner-slot'}>
      {active ? (
        <div className="busy-corner" role="status" aria-label="Working">
          <span className="spinner" aria-hidden="true" />
        </div>
      ) : null}
    </div>
  );
}

const POPUP_PREFERRED_WIDTH = 440;

/**
 * Place a composer popup on the side of its trigger that has room.
 * A trigger near the right edge opens the card to the left.
 */
function usePopupSide(open: boolean): { ref: RefObject<HTMLDivElement>; className: string } {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const root = ref.current;
    if (!root) {
      return;
    }
    const place = (): void => {
      const anchor = root.getBoundingClientRect();
      const margin = 8;
      const spaceRight = window.innerWidth - anchor.left - margin;
      const spaceLeft = anchor.right - margin;
      const alignEnd = spaceRight < POPUP_PREFERRED_WIDTH && spaceLeft > spaceRight;
      const available = Math.max(160, alignEnd ? spaceLeft : spaceRight);
      root.style.setProperty('--popup-left', alignEnd ? 'auto' : '0');
      root.style.setProperty('--popup-right', alignEnd ? '0' : 'auto');
      root.style.setProperty('--popup-max', `${available}px`);
    };
    place();
    const frame = requestAnimationFrame(place);
    const observer = new ResizeObserver(place);
    observer.observe(document.documentElement);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [open]);
  return { ref, className: 'mode-menu' };
}

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(reduce, initialState);
  setPrettyPathRoots(state.workspaceRoots);
  const [draft, setDraft] = useState('');
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
          dispatch({
            type: 'zvecGrep',
            pending: message.pending,
            requested: message.requested,
            ok: message.ok,
            message: message.message
          });
          break;
        case 'astGrep':
          dispatch({
            type: 'astGrep',
            pending: message.pending,
            requested: message.requested,
            ok: message.ok,
            message: message.message
          });
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
          dispatch({ type: 'attachmentError', message: message.message });
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

  // Providers the switcher may show: those reporting `available` or
  // `unauthenticated`. A provider with no usable integration (Codex CLI not
  // installed) is omitted entirely rather than shown as broken.
  const providers = useMemo(
    () => state.availability.filter((backend) => backend.status !== 'unavailable'),
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
  // fetch — it is represented by an actionable entry instead.
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
    const firstUser = state.transcript.find((item) => item.kind === 'message' && item.role === 'user' && item.text?.trim());
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
    dispatch({ type: 'closeSettings' });
  };

  const saveSettings = (patch: SettingsPatch, target?: 'global' | 'workspace'): void => {
    bridge.post({ type: 'saveSettings', patch, ...(target ? { target } : {}) });
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

  const send = (): void => {
    const text = draft.trim();
    if (
      (!text && state.attachments.length === 0) ||
      state.restoring ||
      pending ||
      state.pendingQuestion ||
      state.modeSwitch
    ) {
      return;
    }
    if (state.busy) {
      if (!text || state.attachments.length > 0 || !acceptsSteer(active?.id)) return;
      followSentMessage();
      const attachments = state.attachments;
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
    const attachments = state.attachments;
    const backendId = state.selectedBackendId;
    const model = state.selectedModel;
    const permissionLevel = state.permissionLevel;
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
      attachments
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

  const runNoticeAction = (action: 'setToken' | 'clearToken' | 'refresh' | 'retry', noticeText?: string): void => {
    if (action === 'retry') {
      retryLastTurn(noticeText ?? '');
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
  const canSteer =
    state.busy &&
    acceptsSteer(active?.id) &&
    active?.status === 'available' &&
    Boolean(draft.trim()) &&
    state.attachments.length === 0 &&
    !state.restoring &&
    !pending &&
    !asking &&
    !state.modeSwitch;
  const canSend =
    (Boolean(draft.trim()) || state.attachments.length > 0) &&
    !state.restoring &&
    !pending &&
    !asking &&
    !state.modeSwitch &&
    active?.status === 'available' &&
    (!state.busy || canSteer);

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
        ? `${dictationStatus} — ${micGestureHint}`
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
    setDictationStatus('Finishing the recording…');
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
    setDictationStatus('Starting the microphone…');
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
    conflictResolution?: ConflictResolution
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
            ...(conflictResolution !== undefined ? { conflictResolution } : {})
          }
        : {
            type: 'changes/decide' as const,
            backendId,
            threadId,
            turnId,
            path: target.path,
            decision,
            ...(conflictResolution !== undefined ? { conflictResolution } : {})
          };
    runHostClick('decide', () => {
      startTransition(() => dispatch({ type: 'changeDeciding', value: true }));
      bridge.post(message);
    });
  };

  const keepChange = (turnId: string, path: string): void => {
    postChangeDecision(turnId, { kind: 'file', path }, 'accepted');
  };

  const resolveConflict = (turnId: string, path: string, resolution: ConflictResolution): void => {
    // Any explicit choice is a reject against the file: keep-current records the
    // decision and writes nothing, overwrite-pre-turn restores the pre-turn bytes.
    postChangeDecision(turnId, { kind: 'file', path }, 'rejected', resolution);
  };

  const keepAll = (turnId: string): void => {
    postChangeDecision(turnId, { kind: 'all' }, 'accepted');
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
      />
      </div>
      <BusyCorner busy={backgroundBusy} overlay />
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
          decisionResults={state.changeDecision?.results}
          rejectConfirm={state.changeRejectConfirm?.turnId === review.turnId ? state.changeRejectConfirm : undefined}
          onOpenFile={openChangeFile}
          onOpenDiff={(path) => openChangeDiff(review.turnId, path)}
          onOpenAllInEditor={() => openChangeView(review.turnId)}
          onRevealInSourceControl={revealChangeInSourceControl}
          onKeep={(path) => keepChange(review.turnId, path)}
          onRequestReject={(scope, paths) =>
            dispatch({ type: 'requestChangeRejectConfirmation', turnId: review.turnId, scope, paths })
          }
          onCancelReject={() => dispatch({ type: 'cancelChangeRejectConfirmation' })}
          onConfirmReject={confirmChangeReject}
          onKeepAll={() => keepAll(review.turnId)}
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
              {state.loadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}
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
                    hideQuestions={state.mode !== 'ask'}
                  />
                ) : (
                  <TranscriptRow
                    item={entry.item}
                    showSpeaker={speakers.has(entry.item.id)}
                    hideQuestions={state.mode !== 'ask'}
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
              <span className="meta-strong">SideCode</span>
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
          <div className="typing-dots" role="status" aria-label="SideCode is working">
            <span />
            <span />
            <span />
          </div>
        ) : null}
        <div className="transcript-end" aria-hidden="true" />
        <BusyCorner busy={backgroundBusy} />
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
                    ? 'Build, Plan or Ask SideCode anything...'
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
              if (event.key === 'Enter' && !event.shiftKey) {
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
                  disabled={Boolean(pending) || asking || state.busy}
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
                    disabled={state.busy}
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
                  disabled={Boolean(pending) || asking}
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
                title={triggerLabel}
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
                  title={thinkingLabel ? `Model settings · ${thinkingLabel}` : 'Model settings'}
                  disabled={Boolean(pending) || asking}
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
              {state.busy && !canSteer ? (
                <button
                  className={`icon-btn composer-action composer-action--stop ${composerModeClass}`}
                  type="button"
                  aria-label="Stop"
                  title="Stop"
                  onClick={cancel}
                >
                  <StopSolidIcon />
                </button>
              ) : showMic ? null : (
                <button
                  className={`icon-btn icon-btn--primary composer-action ${composerModeClass}`}
                  type="button"
                  aria-label="Send"
                  title="Send"
                  disabled={!canSend}
                  onClick={send}
                >
                  <SendSolidIcon />
                </button>
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

function ModelPanel({
  providers,
  models,
  modelErrors,
  selectedBackendId,
  selectedModel,
  filter,
  onFilterChange,
  onClose,
  onSetToken,
  onRetry,
  dispatch
}: {
  providers: BackendAvailability[];
  models: Record<string, BackendModel[]>;
  modelErrors: Record<string, string>;
  selectedBackendId?: string;
  selectedModel?: string;
  filter: string;
  onFilterChange: (value: string) => void;
  onClose: () => void;
  onSetToken: (backendId: string) => void;
  onRetry: (backendId: string) => void;
  dispatch: Dispatch<Action>;
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const query = filter.trim().toLowerCase();

  // Move focus into the panel on open so arrow keys and typing land here.
  // Focus returns to the trigger only for Escape; an outside click should
  // leave focus on whatever was pressed.
  useEffect(() => {
    const target =
      filterRef.current ??
      listRef.current?.querySelector<HTMLButtonElement>('.model-option') ??
      document.querySelector<HTMLButtonElement>('#model-panel .btn');
    target?.focus();
  }, []);

  const groups = providers.map((backend) => {
    const list = models[backend.id];
    const matches = sortModels(list ?? []).filter(
      (model) => !query || `${model.label} ${model.id}`.toLowerCase().includes(query)
    );
    return {
      backend,
      matches,
      loaded: list !== undefined,
      error: modelErrors[backend.id]
    };
  });

  // A filter can only be "no matches" once the available lists have loaded;
  // while rows are still arriving the skeletons, not the empty note, show.
  const hasAvailable = providers.some((backend) => backend.status === 'available');

  // Providers are the panel's major sections. Exactly one is visible at a time,
  // so a long provider list scrolls inside its own tab body instead of stacking
  // every provider vertically. Open on the provider of the model already in
  // use (Codex stays on Codex). If that provider drops out, fall back.
  const [activeProvider, setActiveProvider] = useState(() =>
    defaultProviderTab(
      providers.map((backend) => backend.id),
      selectedBackendId
    )
  );
  const providerIds = groups.map((group) => group.backend.id);
  const visibleProvider = providerIds.includes(activeProvider)
    ? activeProvider
    : defaultProviderTab(providerIds, selectedBackendId);
  const activeGroup = groups.find((group) => group.backend.id === visibleProvider) ?? groups[0];
  const activeMatches = activeGroup?.matches ?? [];
  const noMatches =
    query.length > 0 &&
    activeMatches.length === 0 &&
    Boolean(activeGroup?.loaded) &&
    !activeGroup?.error;
  const providerTabs: TabItem[] = groups.map((group) => ({
    id: group.backend.id,
    label: group.backend.label,
    meta: group.error
      ? 'Unavailable'
      : !group.loaded
        ? 'Loading'
        : `${query.length > 0 ? group.matches.length : (models[group.backend.id]?.length ?? 0)}`
  }));

  const focusOption = (delta: number): void => {
    const options = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[data-model-option]') ?? []
    );
    if (options.length === 0) {
      return;
    }
    const index = options.findIndex((option) => option === document.activeElement);
    const next = Math.min(Math.max(index + delta, 0), options.length - 1);
    options[next === -1 ? options.length - 1 : next]?.focus();
  };

  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      document.querySelector<HTMLButtonElement>('.model-trigger')?.focus();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusOption(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const options = Array.from(
        listRef.current?.querySelectorAll<HTMLButtonElement>('[data-model-option]') ?? []
      );
      (event.key === 'Home' ? options[0] : options[options.length - 1])?.focus();
    }
  };

  const select = (backendId: string, model: string): void => {
    const backendChanged = backendId !== selectedBackendId;
    const modelChanged = model !== selectedModel;
    if (backendChanged) {
      dispatch({ type: 'selectBackend', backendId });
    }
    if (backendChanged || modelChanged) {
      dispatch({ type: 'selectModel', model });
      bridge.post({ type: 'selectModel', backendId, modelId: model });
    }
    onClose();
  };

  // Nothing is available: show one explanatory state with a route forward. Any
  // unauthenticated provider becomes a disabled entry inside it, never an error
  // and never an empty list.
  if (!hasAvailable) {
    return (
      <div className="model-panel" id="model-panel" role="dialog" aria-label="Choose a model" onKeyDown={onPanelKeyDown}>
        <div className="model-panel__head">
          <span id="model-panel-title">Choose a model</span>
          <span className="spacer" />
          <button
            className="icon-btn"
            type="button"
            aria-label="Refresh model list"
            onClick={() => {
              dispatch({ type: 'refresh' });
              bridge.post({ type: 'refresh' });
            }}
          >
            <RefreshIcon />
          </button>
        </div>

        <div className="model-panel__body">
          <div className="model-empty" role="status">
            <span className="empty-icon" aria-hidden="true">
              <SparkIcon />
            </span>
            <p className="empty-title">
              {providers.length > 0 ? 'No provider is ready' : 'No provider is installed'}
            </p>
            <p className="empty-text">
              {providers.length > 0
                ? 'Set up a provider below to list the models on your account.'
                : 'Set an Ollama Cloud token, install the OpenCode CLI under Settings → CLI, or install the Codex CLI and sign in.'}
            </p>
            {providers.length === 0 ? (
              <div className="model-empty__actions">
                <button className="btn" type="button" onClick={() => bridge.post({ type: 'openSettings' })}>
                  Set up provider
                </button>
              </div>
            ) : null}
          </div>

          {providers.map((backend) => {
            const view = backendStatusView(backend);
            return (
              <div className="model-group" role="group" aria-label={`${backend.label} - ${view.label.toLowerCase()}`} key={backend.id}>
                <div className="model-group__head">
                  <ProviderBadge backend={backend} />
                  <span className="provider-count">{view.label}</span>
                </div>
                <div className="model-group-notice" role="note">
                  <AlertIcon className="notice-icon" />
                  <div className="notice-body">
                    <div className="notice-title">
                      {view.tone === 'incompatible'
                        ? `${backend.label} speaks a different protocol`
                        : view.tone === 'auth-mismatch'
                          ? `${backend.label} is signed in with the wrong method`
                          : `${backend.label} needs a token`}
                    </div>
                    <div className="notice-text">{view.detail}</div>
                    <div className="notice-actions">
                      {view.tone === 'incompatible' ? (
                        <>
                          {view.version ? (
                            <span className="status-chip status-chip--warning">v{view.version}</span>
                          ) : null}
                          <button className="btn" type="button" onClick={() => bridge.post({ type: 'showAppSettings', section: 'codex' })}>
                            Open settings
                          </button>
                        </>
                      ) : view.tone === 'auth-mismatch' ? (
                        <>
                          {view.authMode ? (
                            <span className="status-chip status-chip--warning">{view.authMode}</span>
                          ) : null}
                          <button className="btn" type="button" onClick={() => bridge.post({ type: 'openSettings' })}>
                            Open settings
                          </button>
                        </>
                      ) : (
                        <button className="btn" type="button" onClick={() => onSetToken(backend.id)}>
                          Set token
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="model-panel__foot">
          <InfoIcon />
          <span>
            {providers.length > 0
              ? 'Providers without a usable integration are hidden until they are installed.'
              : 'Set up provider opens the SideCode settings.'}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="model-panel" id="model-panel" role="dialog" aria-label="Choose a model" onKeyDown={onPanelKeyDown}>
      <div className="model-panel__head">
        <span id="model-panel-title">Choose a model</span>
        <span className="spacer" />
        <button
          className="icon-btn"
          type="button"
          aria-label="Refresh model list"
          onClick={() => {
            for (const backend of providers) {
              if (backend.status === 'available') {
                onRetry(backend.id);
              }
            }
          }}
        >
          <RefreshIcon />
        </button>
      </div>

      <div className="model-filter-row">
        <SearchIcon className="filter-ico" />
        <input
          className="model-filter"
          type="text"
          ref={filterRef}
          value={filter}
          placeholder="Filter models"
          aria-label="Filter models"
          aria-controls="model-list"
          onChange={(event) => onFilterChange(event.target.value)}
        />
      </div>

      {groups.length > 1 ? (
        <TabList
          className="model-panel__tabs"
          label="Providers"
          tabs={providerTabs}
          active={visibleProvider}
          onChange={setActiveProvider}
        />
      ) : null}

      <div className="model-panel__body">
        {activeGroup ? (
          <div
            className="model-list"
            id="model-list"
            ref={listRef}
            role="listbox"
            aria-labelledby="model-panel-title"
          >
            <div className="model-group" role="group" aria-label={activeGroup.backend.label}>
              <div className="model-group__head">
                <ProviderBadge backend={activeGroup.backend} />
                <span className="provider-count">
                  {activeGroup.error
                    ? 'Unavailable'
                    : !activeGroup.loaded
                      ? 'Loading'
                      : `${activeGroup.matches.length} models`}
                </span>
              </div>

              {activeGroup.error ? (
                <div className="model-group-error" role="alert">
                  <AlertIcon className="error-icon" />
                  <div className="error-body">
                    <div className="error-title">Could not load {activeGroup.backend.label} models</div>
                    <div className="error-text">{activeGroup.error}</div>
                    <div className="error-actions">
                      <button className="btn" type="button" onClick={() => onRetry(activeGroup.backend.id)}>
                        <RefreshIcon />
                        Retry
                      </button>
                    </div>
                  </div>
                </div>
              ) : !activeGroup.loaded ? (
                <div aria-hidden="true">
                  <div className="skeleton-row">
                    <span className="skeleton-bar skeleton-bar--60" />
                  </div>
                  <div className="skeleton-row">
                    <span className="skeleton-bar skeleton-bar--40" />
                  </div>
                </div>
              ) : noMatches ? null : (
                activeGroup.matches.map((model) => {
                  const selected =
                    activeGroup.backend.id === selectedBackendId && model.id === selectedModel;
                  return (
                    <button
                      className="model-option"
                      type="button"
                      role="option"
                      data-model-option
                      aria-selected={selected}
                      key={`${activeGroup.backend.id}-${model.id}`}
                      onClick={() => select(activeGroup.backend.id, model.id)}
                    >
                      <span className="model-option-name">
                        {model.label}
                        {model.free ? (
                          <span className="model-free-chip" title="Free on OpenCode Zen">
                            Free
                          </span>
                        ) : null}
                      </span>
                      {selected ? <CheckIcon className="model-check" /> : null}
                    </button>
                  );
                })
              )}
            </div>

            {noMatches ? (
              <div className="model-empty" role="status">
                <p className="empty-title">No models match</p>
                <p className="empty-text">Try a different filter, or clear it to see every model.</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ProviderBadge({ backend }: { backend: BackendAvailability }): JSX.Element {
  return (
    <span className={`provider-badge provider-badge--${backend.id}`}>
      <span className={`provider-dot provider-dot--${backend.id}`} aria-hidden="true" />
      <span className="provider-name">{backend.label}</span>
    </span>
  );
}

function dropIndex(ids: readonly string[], dragId: string, overId: string, before: boolean): number {
  const from = ids.indexOf(dragId);
  let to = ids.indexOf(overId);
  if (from < 0 || to < 0) {
    return -1;
  }
  if (!before) {
    to += 1;
  }
  if (from < to) {
    to -= 1;
  }
  return to;
}

/** Keep a tab fully inside the horizontal strip without scrolling the page. */
function revealChatTab(list: HTMLElement, tab: HTMLElement): boolean {
  if (list.clientWidth === 0) {
    return false;
  }
  const pad = 4;
  const listRect = list.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  if (tabRect.left < listRect.left + pad) {
    list.scrollLeft -= listRect.left + pad - tabRect.left;
  } else if (tabRect.right > listRect.right - pad) {
    list.scrollLeft += tabRect.right - (listRect.right - pad);
  }
  return true;
}

function ChatTabStrip({
  tabs,
  activity,
  actions
}: {
  tabs: AppState['chatTabs'];
  activity: AppState['threadActivity'];
  actions: JSX.Element;
}): JSX.Element | null {
  const stripRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; before: boolean } | null>(null);
  const activeId = tabs.find((tab) => tab.active)?.id ?? '';
  const activeIndex = tabs.findIndex((tab) => tab.active);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !activeId) {
      return;
    }
    const tab = list.querySelector<HTMLElement>(`[data-chat-tab-id="${CSS.escape(activeId)}"]`);
    if (!tab) {
      return;
    }
    let frame = 0;
    let attempts = 0;
    const reveal = (): void => {
      if (revealChatTab(list, tab) || attempts >= 8) {
        return;
      }
      attempts += 1;
      frame = requestAnimationFrame(reveal);
    };
    reveal();
    const observer = new ResizeObserver(() => {
      revealChatTab(list, tab);
    });
    observer.observe(list);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeId, activeIndex, tabs.length]);

  useEffect(() => {
    const strip = stripRef.current;
    const list = listRef.current;
    if (!strip || !list) {
      return;
    }
    const onWheel = (event: WheelEvent): void => {
      if (list.scrollWidth <= list.clientWidth) {
        return;
      }
      const axis = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (axis === 0) {
        return;
      }
      const delta =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? axis * 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? axis * list.clientWidth
            : axis;
      event.preventDefault();
      list.scrollLeft += delta;
    };
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, [tabs.length]);

  if (tabs.length === 0) {
    return null;
  }
  const finishDrag = (): void => {
    setDragId(null);
    setOver(null);
  };
  return (
    <div className="chat-tabs" ref={stripRef}>
      <div className="chat-tabs__list" role="tablist" aria-label="Open chats" ref={listRef}>
        {tabs.map((tab) => {
          const key = tab.backendId && tab.threadId ? `${tab.backendId}:${tab.threadId}` : undefined;
          const live = key ? activity[key] : undefined;
          const drop =
            over?.id === tab.id ? (over.before ? ' chat-tab--drop-before' : ' chat-tab--drop-after') : '';
          const dragging = dragId === tab.id ? ' chat-tab--dragging' : '';
          return (
            <div
              className={`chat-tab${tab.active ? ' chat-tab--active' : ''}${drop}${dragging}`}
              key={tab.id}
              data-chat-tab-id={tab.id}
              draggable
              onMouseDown={(event) => {
                if (event.button !== 1) {
                  return;
                }
                event.preventDefault();
                bridge.post({ type: 'closeChatTab', tabId: tab.id });
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                }
              }}
              onDragStart={(event) => {
                if ((event.target as HTMLElement).closest('.chat-tab__close')) {
                  event.preventDefault();
                  return;
                }
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', tab.id);
                setDragId(tab.id);
              }}
              onDragEnd={finishDrag}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                const rect = event.currentTarget.getBoundingClientRect();
                const before = event.clientX < rect.left + rect.width / 2;
                setOver((current) =>
                  current?.id === tab.id && current.before === before ? current : { id: tab.id, before }
                );
              }}
              onDrop={(event) => {
                event.preventDefault();
                const source = event.dataTransfer.getData('text/plain') || dragId;
                const rect = event.currentTarget.getBoundingClientRect();
                const before = event.clientX < rect.left + rect.width / 2;
                if (source) {
                  const to = dropIndex(
                    tabs.map((item) => item.id),
                    source,
                    tab.id,
                    before
                  );
                  if (to >= 0) {
                    bridge.post({ type: 'reorderChatTab', tabId: source, toIndex: to });
                  }
                }
                finishDrag();
              }}
            >
              <button
                className="chat-tab__label"
                type="button"
                role="tab"
                aria-selected={tab.active}
                title={tab.title}
                onClick={() => bridge.post({ type: 'selectChatTab', tabId: tab.id })}
              >
                <span className="chat-tab__text">{tab.title}</span>
                {live?.busy ? (
                  <span className="chat-tab__mark" role="status" title="Busy" aria-label="Busy">
                    <span className="spinner" aria-hidden="true" />
                  </span>
                ) : null}
                {!tab.active && live?.unread ? <span className="chat-tab__unread" title="Unread" aria-label="Unread" /> : null}
              </button>
              <button
                className="chat-tab__close"
                type="button"
                aria-label={`Close ${tab.title}`}
                draggable={false}
                onMouseDown={(event) => {
                  event.stopPropagation();
                  if (event.button === 1) {
                    event.preventDefault();
                    bridge.post({ type: 'closeChatTab', tabId: tab.id });
                  }
                }}
                onClick={() => bridge.post({ type: 'closeChatTab', tabId: tab.id })}
              >
                <CrossIcon />
              </button>
            </div>
          );
        })}
      </div>
      {actions}
    </div>
  );
}

function HistoryPanel({
  threads,
  loading,
  activeThreadId,
  selectedBackendId,
  threadActivity,
  query,
  onQueryChange,
  onSelect
}: {
  threads: HistoryEntry[];
  loading: boolean;
  activeThreadId?: string;
  selectedBackendId?: string;
  threadActivity: AppState['threadActivity'];
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (backendId: string, threadId: string) => void;
}): JSX.Element {
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? threads.filter((thread) => (thread.title ?? 'Untitled conversation').toLowerCase().includes(needle))
    : threads;
  return (
    <div className="history-menu" id="history-panel">
      <div className="history-menu__search">
        <SearchIcon />
        <input
          className="model-filter"
          type="search"
          placeholder="Search conversations"
          aria-label="Search conversations"
          value={query}
          autoFocus
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && visible[0]) {
              event.preventDefault();
              onSelect(visible[0].backendId, visible[0].threadId);
            }
          }}
        />
      </div>
      {loading && threads.length === 0 ? (
        <div className="history-loading" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          Loading conversations...
        </div>
      ) : threads.length === 0 ? (
        <ul className="model-list">
          <li className="model-option model-option--empty">No earlier conversations yet.</li>
        </ul>
      ) : visible.length === 0 ? (
        <ul className="model-list">
          <li className="model-option model-option--empty">No conversations match.</li>
        </ul>
      ) : (
        <ul className="model-list" role="listbox" aria-label="Conversations">
          {visible.map((thread) => {
            const selected = thread.backendId === selectedBackendId && thread.threadId === activeThreadId;
            const activity = threadActivity?.[`${thread.backendId}:${thread.threadId}`];
            const title = thread.title ?? 'Untitled conversation';
            return (
              <li
                className="model-option"
                role="option"
                aria-selected={selected}
                key={`${thread.backendId}:${thread.threadId}`}
                tabIndex={0}
                onClick={() => onSelect(thread.backendId, thread.threadId)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(thread.backendId, thread.threadId);
                  }
                }}
              >
                <span className="thread-title" title={title}>
                  {title}
                </span>
                {activity?.busy ? (
                  <span className="chat-tab__mark" role="status" title="Busy" aria-label="Busy">
                    <span className="spinner" aria-hidden="true" />
                  </span>
                ) : null}
                {!selected && activity?.unread ? (
                  <span className="chat-tab__unread" title="Unread" role="img" aria-label="Unread" />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function EmptyState({
  state,
  dispatch,
  hasAvailable
}: {
  state: AppState;
  dispatch: Dispatch<Action>;
  hasAvailable: boolean;
}): JSX.Element {
  const needsToken = state.availability.find((backend) => backend.status === 'unauthenticated');
  const incompatible = incompatibleBackends(state.availability)[0];
  const authMismatch = authMismatchBackends(state.availability)[0];
  const unavailable = state.availability.filter((backend) => backend.status === 'unavailable');

  if (!hasAvailable) {
    // The most specific failure headlines: a protocol mismatch is diagnosable
    // and must not be masked by a generic "no backend is ready". The same is
    // true of an API-key-vs-ChatGPT mismatch. A missing binary is never
    // mentioned, so an Ollama-only sidebar stays quiet.
    const headline = incompatible
      ? 'Codex protocol mismatch'
      : authMismatch
        ? 'Codex is signed in with the wrong method'
        : 'No backend is ready';
    const message = incompatible
      ? incompatible.detail
      : authMismatch
        ? authMismatch.detail
        : needsToken
          ? `${needsToken.label} needs a token before you can chat.`
          : 'Set an Ollama Cloud token, or install the Codex CLI and sign in.';
    return (
      <div className="empty-state">
        <span className="empty-icon" aria-hidden="true">
          <SparkIcon />
        </span>
        <p className="empty-title">{headline}</p>
        <p className="empty-text">{message}</p>
        {incompatible ? (
          <div className="banner-actions">
            {incompatible.version ? (
              <span className="status-chip status-chip--warning">v{incompatible.version}</span>
            ) : null}
            <button className="btn" type="button" onClick={() => bridge.post({ type: 'showAppSettings', section: 'codex' })}>
              Open settings
            </button>
            <button className="btn" type="button" onClick={() => bridge.post({ type: 'refresh' })}>
              Retry
            </button>
          </div>
        ) : authMismatch ? (
          <div className="banner-actions">
            {authMismatch.authMode ? (
              <span className="status-chip status-chip--warning">{authMismatch.authMode}</span>
            ) : null}
            <button className="btn" type="button" onClick={() => bridge.post({ type: 'openSettings' })}>
              Open settings
            </button>
            <button className="btn" type="button" onClick={() => bridge.post({ type: 'refresh' })}>
              Retry
            </button>
          </div>
        ) : needsToken ? (
          <div className="banner-actions">
            <button className="btn btn--primary" type="button" onClick={() => runTokenAction(dispatch, state)}>
              Set token
            </button>
            <button className="btn" type="button" onClick={() => bridge.post({ type: 'refresh' })}>
              Retry
            </button>
          </div>
        ) : unavailable.length > 0 ? (
          <div className="banner-actions">
            <button className="btn" type="button" onClick={() => bridge.post({ type: 'refresh' })}>
              Retry
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="empty-state empty-state--welcome">
      <img className="empty-logo" src={logoUrl} alt="" />
      <p className="empty-title empty-title--brand">SideCode</p>
      <p className="empty-text">
        On your side. Plan, Edit, or Ask anything.
      </p>
      <p className="empty-slogan">You've got this</p>
    </div>
  );
}

function runTokenAction(dispatch: Dispatch<Action>, state: AppState): void {
  const needsToken = state.availability.find((backend) => backend.status === 'unauthenticated');
  dispatch({
    type: 'notice',
    level: 'warning',
    message: needsToken?.detail ?? 'Enter a token to continue.',
    action: 'setToken'
  });
}

/**
 * The result strip for a checkpoint restore, so a partial outcome is never
 * hidden and the restore can be undone. It states plainly that only files were
 * reverted, and lists the paths that failed or were left as conflicts.
 */
function RestoreResultStrip({
  result,
  onUndo
}: {
  result: RestoreCheckpointResult;
  onUndo: () => void;
}): JSX.Element {
  const failed = result.results.filter((entry) => entry.outcome === 'failed');
  const conflicts = result.results.filter((entry) => entry.outcome === 'conflict');
  const skipped = result.results.filter((entry) => entry.outcome === 'skipped');
  const problems = [...failed, ...conflicts, ...skipped];
  return (
    <div className={`banner banner--${result.partial ? 'interrupted' : 'status'}`} role="status">
      <span className="banner-icon" aria-hidden="true">
        <RestoreIcon />
      </span>
      <div>
        <p className="banner-title">{result.partial ? 'Restore was partial' : 'Files restored'}</p>
        <p className="banner-text">{result.message}</p>
        {problems.length > 0 ? (
          <ul className="restore-problems">
            {problems.slice(0, 8).map((entry) => (
              <li key={entry.relPath}>
                <span className="restore-problems__path">{entry.relPath}</span>
                {entry.reason ? <span className="restore-problems__reason"> {entry.reason}</span> : null}
              </li>
            ))}
            {problems.length > 8 ? <li>and {problems.length - 8} more</li> : null}
          </ul>
        ) : null}
        <div className="banner-actions">
          <button className="btn btn--quiet" type="button" onClick={onUndo}>
            Undo restore
          </button>
        </div>
      </div>
    </div>
  );
}

function noticeActionLabel(action: 'setToken' | 'clearToken' | 'refresh' | 'retry'): string {
  switch (action) {
    case 'setToken':
      return 'Set token';
    case 'clearToken':
      return 'Clear token';
    case 'refresh':
      return 'Refresh backends';
    case 'retry':
      return 'Retry';
  }
}

function entryContains(entry: TranscriptEntry, itemId: string): boolean {
  if (entry.kind === 'item') {
    return entry.item.id === itemId;
  }
  if (entry.kind === 'group') {
    return entry.items.some((item) => item.id === itemId);
  }
  return entry.id === itemId || entry.message.id === itemId || entry.items.some((item) => item.id === itemId);
}

function sameItems(left: readonly TranscriptItemView[], right: readonly TranscriptItemView[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

const TranscriptRow = memo(function TranscriptRow({
  item,
  providerId,
  showSpeaker,
  hideQuestions,
  pendingId,
  checkpoint,
  onDecide,
  onOpenRules,
  onRestore,
  onViewImage,
  onNoticeAction
}: {
  item: TranscriptItemView;
  providerId: string;
  /** The opening reply of a turn, and the closing one once that turn has settled. */
  showSpeaker?: boolean;
  /** Plan and Agent hide a sidecode-question fence. Ask leaves it as text. */
  hideQuestions?: boolean;
  pendingId?: string;
  /** The send-time snapshot for this message, when one was stored. */
  checkpoint?: CheckpointView;
  onDecide: (decision: ApprovalDecision) => void;
  onOpenRules: () => void;
  onRestore: (messageId: string) => void;
  onViewImage: (images: ViewableImage[], index: number) => void;
  onNoticeAction: (action: 'setToken' | 'clearToken' | 'refresh' | 'retry', noticeText?: string) => void;
}): JSX.Element | null {
  if (item.kind === 'message' && item.role === 'user') {
    const text = visibleTranscriptText(item.text);
    if (!text && !(item.attachments && item.attachments.length > 0)) {
      return null;
    }
    return (
      <article className="turn turn--user" data-user-message={item.id}>
        <div className="turn-meta">
          <PersonIcon />
          <span className="meta-strong">You</span>
        </div>
        <div className="turn-user-box">
          <div className="turn-body">
            {item.attachments && item.attachments.length > 0 ? (
              <AttachmentList attachments={item.attachments} sent onView={onViewImage} />
            ) : null}
            {text ? <Markdown text={text} /> : null}
          </div>
          {checkpoint ? (
            <div className="turn-actions">
              <button
                type="button"
                className="checkpoint-restore"
                aria-label="Restore to before this message"
                title="Restore this chat to before this message. This stays available after you keep a turn's files."
                onClick={() => onRestore(checkpoint.messageId)}
              >
                <RestoreIcon />
              </button>
            </div>
          ) : null}
        </div>
      </article>
    );
  }

  if (item.kind === 'tool') {
    return <ToolCard item={item} />;
  }

  if (item.kind === 'file-change') {
    return <FileChangeCard item={item} />;
  }

  if (item.kind === 'approval-requested') {
    // The live request renders the decision card; a settled one renders the
    // compact resolved marker. This is what keeps exactly one prompt visible.
    return item.id === pendingId ? (
      <ApprovalPrompt item={item} onDecide={onDecide} />
    ) : (
      <ApprovalResolvedCard item={item} onOpenRules={onOpenRules} />
    );
  }

  if (item.kind === 'approval-decided') {
    return <ApprovalResolvedCard item={item} approved onOpenRules={onOpenRules} />;
  }

  if (item.kind === 'approval-denied') {
    return <ApprovalResolvedCard item={item} approved={false} onOpenRules={onOpenRules} />;
  }

  if (item.kind === 'notice' && item.detail === 'status') {
    const tone = item.noticeLevel === 'error' ? 'error' : 'interrupted';
    return (
      <div className={`banner banner--${tone} banner--status`} role={tone === 'error' ? 'alert' : 'status'}>
        <span className="banner-icon" aria-hidden="true">
          <AlertIcon />
        </span>
        <p className="banner-text">{item.text}</p>
        {item.noticeAction ? (
          <div className="banner-actions">
            <button
              className="btn btn--primary"
              type="button"
              onClick={() => onNoticeAction(item.noticeAction ?? 'refresh', item.text)}
            >
              {noticeActionLabel(item.noticeAction)}
            </button>
            {item.noticeAction === 'refresh' ? null : (
              <button className="btn btn--quiet" type="button" onClick={() => onNoticeAction('refresh')}>
                Refresh backends
              </button>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  if (item.kind === 'notice') {
    return (
      <article className="turn turn--agent">
        {item.title ? <div className="turn-meta">{item.title}</div> : null}
        <div className="turn-body">
          <p>{item.text}</p>
        </div>
      </article>
    );
  }

  if (item.kind === 'reasoning') {
    return <ReasoningCard item={item} />;
  }

  // Assistant message: markdown output with a streaming caret.
  const assistantText = visibleTranscriptText(item.text, { hideQuestions });
  if (!assistantText && item.status !== 'failed') {
    return null;
  }
  const statusChip =
    item.status === 'streaming' ? (
      <StatusMark tone="running" label="Generating" />
    ) : item.status === 'canceled' ? (
      <StatusMark label="Stopped" icon={<StopIcon />} />
    ) : null;
  return (
    <article className="turn turn--agent" aria-live="polite">
      {showSpeaker || statusChip ? (
        <div className="turn-meta">
          {showSpeaker ? (
            <>
              <span className={`provider-dot provider-dot--${providerId}`} aria-hidden="true" />
              <span className="meta-strong">SideCode</span>
              {item.title ? (
                <>
                  <span className="meta-sep" aria-hidden="true">
                    -
                  </span>
                  <span>{item.title}</span>
                </>
              ) : null}
            </>
          ) : null}
          {statusChip}
        </div>
      ) : null}
      <div className="turn-body">
        {assistantText ? (
          <AssistantReply
            text={assistantText}
            settled={item.status !== 'streaming' && item.status !== 'pending'}
          />
        ) : null}
        {item.status === 'streaming' ? <span className="caret" aria-hidden="true" /> : null}
        {item.status === 'failed' ? (
          <div className="banner banner--error" role="alert">
            <span className="banner-icon" aria-hidden="true">
              <AlertIcon />
            </span>
            <div>
              <p className="banner-title">Response incomplete</p>
              <p className="banner-text">The agent stopped before finishing this reply.</p>
              <div className="banner-actions">
                <button className="btn btn--primary" type="button" onClick={() => bridge.post({ type: 'refresh' })}>
                  Retry
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}, (prev, next) =>
  prev.item === next.item &&
  prev.providerId === next.providerId &&
  prev.showSpeaker === next.showSpeaker &&
  prev.hideQuestions === next.hideQuestions &&
  prev.pendingId === next.pendingId &&
  prev.checkpoint === next.checkpoint
);

function AssistantReply({ text, settled }: { text: string; settled: boolean }): JSX.Element {
  const parts = settled ? splitReplyClose(text) : { body: text };
  const copyHeader = (_language: string, code: string): JSX.Element => (
    <button className="icon-btn" type="button" aria-label="Copy code" onClick={() => copyText(code)}>
      <CopyIcon />
    </button>
  );
  return (
    <>
      {parts.body ? <Markdown text={parts.body} renderCodeHeader={copyHeader} /> : null}
      {parts.close ? (
        <div className="reply-close">
          <Markdown text={parts.close} />
        </div>
      ) : null}
    </>
  );
}

function reasoningSnippet(text: string): string {
  return plainRowText(text);
}

/** One dot, then two, then three, then none, then it repeats. */
function ReasoningWaitDots(): JSX.Element {
  return (
    <span className="reasoning-wait" aria-hidden="true">
      <span>.</span>
      <span>.</span>
      <span>.</span>
    </span>
  );
}

function ReasoningCard({ item }: { item: TranscriptItemView }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const text = item.text.trim();
  const label = item.title || 'Reasoning';
  const incomplete = item.status === 'failed' || item.status === 'canceled' || item.status === 'warning';
  const snippet = reasoningSnippet(text);
  const waiting = item.status === 'streaming' && !snippet;
  const preview = waiting
    ? ''
    : snippet || (incomplete ? 'Thinking stopped early; this section may be incomplete.' : '');
  const showEllipsis = !expanded && !waiting && Boolean(preview || !text);
  const toggle = (): void => setExpanded((value) => !value);

  return (
    <article className={`turn turn--reasoning${expanded ? '' : ' turn--reasoning--collapsed'}`} aria-live="polite">
      <button
        type="button"
        className="reasoning-toggle"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Hide' : 'Show'} ${label}`}
        onClick={toggle}
      >
        <span className="reasoning-lead">
          <span className="meta-strong">{label}</span>
          {waiting && !expanded ? <ReasoningWaitDots /> : null}
          {showEllipsis ? (
            <span className="reasoning-snippet__sep" aria-hidden="true">
              ...
            </span>
          ) : null}
        </span>
        {!expanded && preview ? (
          <span className="reasoning-snippet__text" title={preview}>
            {preview}
          </span>
        ) : null}
        <span className="status-slot">
          {item.status === 'streaming' ? <StatusMark tone="running" label="Thinking" /> : null}
        </span>
        <span
          className={`reasoning-toggle__chevron${expanded ? ' reasoning-toggle__chevron--open' : ''}`}
          aria-hidden="true"
        >
          <ChevronDownIcon />
        </span>
      </button>
      {expanded && (text || item.status === 'streaming' || incomplete) ? (
        <div className="turn-body md" onClick={toggle}>
          {text ? (
            <Markdown text={item.text} />
          ) : item.status === 'streaming' ? (
            <ReasoningWaitDots />
          ) : null}
          {item.status === 'streaming' && text ? <span className="caret" aria-hidden="true" /> : null}
          {incomplete ? (
            <p className="reasoning-incomplete" role="status">
              Thinking stopped early; this section may be incomplete.
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

const NarrationRow = memo(function NarrationRow({
  message,
  items,
  showSpeaker,
  providerId,
  hideQuestions
}: {
  message: TranscriptItemView;
  items: TranscriptItemView[];
  showSpeaker: boolean;
  providerId: string;
  hideQuestions?: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const text = plainRowText(visibleTranscriptText(message.text, { hideQuestions }));
  const running = items.some((item) => item.status === 'streaming' || item.status === 'pending') || message.status === 'streaming';
  return (
    <article className={`narration${expanded ? ' narration--open' : ''}`}>
      {showSpeaker ? (
        <div className="turn-meta">
          <span className={`provider-dot provider-dot--${providerId}`} aria-hidden="true" />
          <span className="meta-strong">SideCode</span>
        </div>
      ) : null}
      <button
        type="button"
        className="narration__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={`activity-group__chevron${expanded ? ' activity-group__chevron--open' : ''}`} aria-hidden="true">
          <ChevronDownIcon />
        </span>
        <span className="narration__text">
          {text}
          {message.status === 'streaming' ? <span className="caret" aria-hidden="true" /> : null}
        </span>
        <span className="status-slot">
          {running ? <StatusMark tone="running" label="Working" /> : null}
        </span>
      </button>
      {expanded ? (
        <div className="narration__details">
          {groupTranscript(items).map((entry) =>
            entry.kind === 'group' ? (
              <ActivityGroup key={entry.id} family={entry.family} items={entry.items} />
            ) : entry.kind === 'item' ? (
              entry.item.kind === 'reasoning' ? (
                <ReasoningCard key={entry.item.id} item={entry.item} />
              ) : (
                <GroupChild key={entry.item.id} item={entry.item} />
              )
            ) : null
          )}
        </div>
      ) : null}
    </article>
  );
}, (prev, next) =>
  prev.message === next.message &&
  prev.showSpeaker === next.showSpeaker &&
  prev.providerId === next.providerId &&
  prev.hideQuestions === next.hideQuestions &&
  sameItems(prev.items, next.items)
);

const ActivityGroup = memo(function ActivityGroup({ family, items }: { family: ActivityFamily; items: TranscriptItemView[] }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const summary = activitySummary(items);
  const Icon = family === 'command' ? TerminalIcon : family === 'change' ? FileIcon : family === 'work' ? SparkIcon : SearchIcon;
  const nested = family === 'work' || items.some((item) => item.kind === 'reasoning');
  const label = summary.detail ? `${summary.label} ${summary.detail}` : summary.label;
  return (
    <div className={`item-card activity-group${expanded ? ' activity-group--open' : ''}`}>
      <button
        type="button"
        className="activity-group__toggle item-head"
        aria-expanded={expanded}
        aria-label={label}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={`activity-group__chevron${expanded ? ' activity-group__chevron--open' : ''}`} aria-hidden="true">
          <ChevronDownIcon />
        </span>
        <span className="item-icon" aria-hidden="true">
          <Icon />
        </span>
        <CardLines title={summary.label} detail={summary.detail} />
        <StatusChip status={summary.status} doneLabel={family === 'change' ? 'Applied' : 'Passed'} />
      </button>
      {expanded ? (
        <div className="activity-group__items">
          {nested ? (
            activitySections(items).map((section) => (
              <div className="activity-section" key={section.id}>
                {section.reasoning ? <ReasoningCard item={section.reasoning} /> : null}
                {toolBursts(section.tools).map((burst) =>
                  burst.items.length === 1 ? (
                    <GroupChild key={burst.id} item={burst.items[0]} />
                  ) : (
                    <NestedBurst key={burst.id} family={burst.family} items={burst.items} />
                  )
                )}
              </div>
            ))
          ) : (
            items.map((item) => <GroupChild key={item.id} item={item} />)
          )}
        </div>
      ) : null}
    </div>
  );
}, (prev, next) => prev.family === next.family && sameItems(prev.items, next.items));

function NestedBurst({ family, items }: { family: ActivityFamily; items: TranscriptItemView[] }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const summary = activitySummary(items);
  const Icon = family === 'command' ? TerminalIcon : family === 'change' ? FileIcon : SearchIcon;
  return (
    <div className={`item-card activity-group activity-group--nested${expanded ? ' activity-group--open' : ''}`}>
      <button
        type="button"
        className="activity-group__toggle item-head"
        aria-expanded={expanded}
        aria-label={summary.label}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={`activity-group__chevron${expanded ? ' activity-group__chevron--open' : ''}`} aria-hidden="true">
          <ChevronDownIcon />
        </span>
        <span className="item-icon" aria-hidden="true">
          <Icon />
        </span>
        <CardLines title={summary.label} detail={summary.detail} />
        <StatusChip status={summary.status} doneLabel="Passed" />
      </button>
      {expanded ? (
        <div className="activity-group__items">
          {items.map((item) => (
            <GroupChild key={item.id} item={item} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function GroupChild({ item }: { item: TranscriptItemView }): JSX.Element {
  if (item.kind === 'file-change') {
    return <FileChangeCard item={item} />;
  }
  if (item.kind === 'tool') {
    return <ToolCard item={item} />;
  }
  return (
    <div className="item-card" aria-label="Web search item">
      <div className="item-head">
        <span className="item-icon" aria-hidden="true">
          <SearchIcon />
        </span>
        <CardLines title={item.title || 'Web search'} detail={item.text || undefined} />
        <StatusChip status={item.status} doneLabel="Passed" />
      </div>
    </div>
  );
}

function ToolCard({ item }: { item: TranscriptItemView }): JSX.Element {
  const presentation = toolCardPresentation(item);
  const output = toolOutput(item, presentation.detail);
  return (
    <details className="item-card item-card--command">
      <summary className="item-head" aria-label="Command item">
        <span className="item-icon" aria-hidden="true">
          <TerminalIcon />
        </span>
        <CardLines title={presentation.title} detail={presentation.detail} />
        <StatusChip status={item.status} doneLabel="Passed" />
      </summary>
      {output ? (
        <div className="item-body">
          <code>{output}</code>
        </div>
      ) : null}
    </details>
  );
}

/** Expanded tool output. Status words and the summary target are not output. */
function toolOutput(item: TranscriptItemView, summary?: string): string | undefined {
  const text = item.text.trim();
  if (text && !isStatusText(text) && text !== summary) {
    return text;
  }
  const detail = item.detail?.trim();
  if (detail && !isStatusText(detail) && detail !== summary) {
    return detail;
  }
  return undefined;
}

/**
 * A pending approval, rendered inline in the transcript flow (never a floating
 * dialog) so the user keeps the surrounding context. It shows what is actually
 * asked: the command and/or the affected files with a compact diff summary,
 * never a raw protocol payload. `allow once` is the single primary action and
 * `always` is never focused by default.
 */
function ApprovalPrompt({
  item,
  onDecide
}: {
  item: TranscriptItemView;
  onDecide: (decision: ApprovalDecision) => void;
}): JSX.Element {
  const request = item.approval;
  const promptRef = useRef<HTMLElement>(null);

  // Focus lands on the prompt when it appears, so the decision is reachable by
  // keyboard at once. The primary action keeps focus; `always` is never focused.
  useEffect(() => {
    promptRef.current?.focus();
  }, []);

  const files = request?.kind === 'file-change' ? item.files ?? [] : [];
  const paths =
    request?.kind === 'file-change' && files.length === 0 ? request.paths ?? [] : [];
  const reason = request?.reason;

  return (
    <section
      className="prompt prompt--pending"
      ref={promptRef}
      role="group"
      aria-label="Approval needed"
      tabIndex={-1}
    >
      <header className="prompt-head">
        <span className="prompt-head__icon" aria-hidden="true">
          <ShieldIcon />
        </span>
        <span className="prompt-title">Approval needed</span>
        <span className="spacer" />
        <span className="chip chip--waiting">Waiting on you</span>
      </header>
      <div className="prompt-body">
        <p className="ask">{item.text || (request ? requestMessage(request) : 'The agent is asking for a decision.')}</p>

        {request?.command ? (
          <pre className="codeblock" aria-label="Command the agent wants to run">
            {request.command}
          </pre>
        ) : null}

        {files.length > 0 ? (
          <div className="affected">
            <p className="affected-label">Changes it would touch</p>
            {files.map((file) => (
              <div className="file-row" key={file.path}>
                <span className="file-name" title={prettyPath(file.path)}>
                  {prettyPath(file.path)}
                </span>
                <span className="diffstat" aria-label={diffStatsLabel([file])}>
                  <span className="add">+{file.additions ?? 0}</span>
                  <span className="del">-{file.deletions ?? 0}</span>
                </span>
              </div>
            ))}
          </div>
        ) : paths.length > 0 ? (
          <div className="affected">
            <p className="affected-label">Files it would touch</p>
            {paths.map((path) => (
              <div className="file-row" key={path}>
                <span className="file-name" title={prettyPath(path)}>
                  {prettyPath(path)}
                </span>
              </div>
            ))}
          </div>
        ) : request?.kind === 'permissions' && request.network ? (
          <div className="file-row">
            <span className="file-name">{request.network}</span>
          </div>
        ) : null}

        {reason ? <p className="prompt-reason">{reason}</p> : null}

        <div className="decisions" role="group" aria-label="Decide on this request">
          <button className="decision decision--primary" type="button" onClick={() => onDecide('allow-once')}>
            Allow once
          </button>
          <button className="decision" type="button" onClick={() => onDecide('allow-always')}>
            Always allow
          </button>
          <button className="decision" type="button" onClick={() => onDecide('allow-session')}>
            Allow for this session
          </button>
          <button className="decision decision--reject" type="button" onClick={() => onDecide('reject')}>
            Reject
          </button>
        </div>

        <p className="scope-note">
          <InfoIcon className="ico ico--xs" />
          <span>
            “Always allow” saves a lasting rule for this request that outlives this task. The other choices
            last one run or one session.
          </span>
        </p>
      </div>
    </section>
  );
}

/**
 * A settled approval, collapsed to a compact marker naming the decision and the
 * scope it applied at. A denial is informational, not an error. An `always`
 * marker carries the one-click route to review and revoke the stored rules.
 */
function ApprovalResolvedCard({
  item,
  approved,
  onOpenRules
}: {
  item: TranscriptItemView;
  approved?: boolean;
  onOpenRules: () => void;
}): JSX.Element {
  const decision = item.approvalDecision;
  const isReject = approved === false || decision === 'reject';
  const label = decision ? decisionLabel(decision) : approved ? 'Approved' : 'Rejected';
  const scope = decision ? decisionScope(decision) : '';
  const subject = item.approval ? describeApprovalSubject(item.approval) : '';
  const variant = isReject ? 'reject' : decision === 'allow-always' ? 'always' : decision === 'allow-session' ? 'session' : 'allow';

  return (
    <div className={`marker marker--${variant}`} role="note">
      <span className="marker-icon" aria-hidden="true">
        {isReject ? <InfoIcon className="ico ico--sm" /> : <CheckIcon className="ico ico--sm" />}
      </span>
      <div className="marker-body">
        <p className="marker-title">
          {label}
          {subject ? (
            <>
              {' - '}
              <span className="marker-subject">{subject}</span>
            </>
          ) : null}
        </p>
        <p className="marker-sub">
          {isReject
            ? 'The agent was told and can continue differently. Nothing was changed.'
            : scope || item.text || decisionMessage(decision ?? 'allow-once')}
        </p>
        {decision === 'allow-always' ? (
          <p className="marker-actions">
            <button className="btn btn--link" type="button" onClick={onOpenRules}>
              Review and remove rules
            </button>
          </p>
        ) : null}
      </div>
    </div>
  );
}

function FileChangeCard({ item }: { item: TranscriptItemView }): JSX.Element {
  const files = item.files ?? [];
  const diffs = files.filter((file) => file.lines && file.lines.length > 0);
  const rawTitle = item.title?.trim();
  const title =
    rawTitle && isRawToolName(rawTitle)
      ? friendlyToolTitle(rawTitle, files[0]?.path)
      : rawTitle || 'Edited';
  return (
    <details className="item-card item-card--change">
      <summary className="item-head" aria-label="File change item">
        <span className="item-icon" aria-hidden="true">
          <FileIcon />
        </span>
        <CardLines title={title} detail={filePathLabel(files)} />
        {totals(files) ? (
          <span className="diff-stats" aria-label={diffStatsLabel(files)}>
            {totals(files)?.additions ? <span className="add">+{totals(files)?.additions}</span> : null}
            {totals(files)?.deletions ? <span className="del">-{totals(files)?.deletions}</span> : null}
          </span>
        ) : null}
        <StatusChip status={item.status} doneLabel="Applied" />
      </summary>
      {diffs.length > 0 ? (
        <div className="diff-body" role="figure" aria-label={`Diff for ${diffs.length} changed ${diffs.length === 1 ? 'file' : 'files'}`}>
          {diffs.map((file) => (
            <section className="diff-file" key={file.path}>
              {diffs.length > 1 ? (
                <div className="diff-file__path" title={prettyPath(file.path)}>
                  {prettyPath(file.path)}
                </div>
              ) : null}
              {file.lines?.map((line, index) => (
                <div className={`diff-line diff-line--${line.kind === 'add' ? 'add' : line.kind === 'del' ? 'del' : 'ctx'}`} key={`${index}-${line.kind}`}>
                  <span className="sign" aria-hidden="true">
                    {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                  </span>
                  <span>{line.text}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      ) : item.text ? (
        <div className="item-body">
          <code>{item.text}</code>
        </div>
      ) : null}
    </details>
  );
}

function StatusChip({ status, doneLabel = 'Passed' }: { status: ItemStatus; doneLabel?: string }): JSX.Element {
  switch (status) {
    case 'streaming':
      return <StatusMark tone="running" label="Running" />;
    case 'completed':
      return <StatusMark tone="done" label={doneLabel} icon={<CheckIcon />} />;
    case 'failed':
      return <StatusMark tone="failed" label="Failed" icon={<CrossIcon />} />;
    case 'warning':
      return <StatusMark tone="warning" label="Check" icon={<AlertIcon />} />;
    case 'canceled':
      return <StatusMark label="Stopped" icon={<StopIcon />} />;
    default:
      return <span className="status-slot" aria-hidden="true" />;
  }
}

/** Icon-only status. The word stays in the tooltip and the accessible name. */
function StatusMark({
  label,
  tone,
  icon
}: {
  label: string;
  tone?: 'running' | 'done' | 'failed' | 'warning';
  icon?: JSX.Element;
}): JSX.Element {
  const toneClass = tone ? ` status-chip--${tone}` : '';
  return (
    <span
      className={`status-chip status-chip--icon${toneClass}`}
      title={label}
      role={tone === 'running' ? 'status' : 'img'}
      aria-label={label}
    >
      {tone === 'running' ? <span className="spinner" aria-hidden="true" /> : icon}
    </span>
  );
}

/** A short, honest label for what a settled approval concerned. */
function describeApprovalSubject(request: ApprovalRequest): string {
  switch (request.kind) {
    case 'command':
      return request.command ? prettyPath(request.command) : 'a command';
    case 'file-change': {
      const paths = request.paths ?? [];
      if (paths.length === 0) {
        return 'file changes';
      }
      if (paths.length === 1) {
        return prettyPath(paths[0]);
      }
      return `${prettyPath(paths[0])} +${paths.length - 1} more`;
    }
    case 'permissions':
      return request.network ? `network access to ${request.network}` : 'extra permissions';
    default:
      return '';
  }
}

function filePathLabel(files: FileChange[]): string {
  if (files.length === 0) {
    return '';
  }
  if (files.length === 1) {
    return prettyPath(files[0].path);
  }
  return `${prettyPath(files[0].path)} +${files.length - 1} more`;
}

/** Title and optional path, each one line. The tooltip is the full visual text. */
function CardLines({ title, detail }: { title: string; detail?: string }): JSX.Element {
  const heading = prettyPath(title);
  const sub = detail ? prettyPath(detail) : '';
  return (
    <span className="item-main">
      <span className="item-kind" title={heading}>
        {heading}
      </span>
      {sub ? (
        <span className="item-path" title={sub}>
          {sub}
        </span>
      ) : null}
    </span>
  );
}

function totals(files: FileChange[]): { additions: number; deletions: number } | undefined {
  if (files.length === 0) {
    return undefined;
  }
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  if (additions === 0 && deletions === 0) {
    return undefined;
  }
  return { additions, deletions };
}

function diffStatsLabel(files: FileChange[]): string {
  const sum = totals(files);
  return sum ? `${sum.additions} additions, ${sum.deletions} deletions` : '';
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text);
}

/** Largest pasted/attached file accepted client-side, matching the host cap. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Turn one clipboard `File` into an attachment. Images are read to a data URL
 * so the chip can show a preview; anything else is carried by name and type.
 * Returns `undefined` for an oversized or unreadable file so the caller can
 * report it and add nothing.
 */
function readClipboardFile(file: File): Promise<Attachment | undefined> {
  const name = file.name && file.name.trim().length > 0 ? file.name : defaultPastedName(file.type);
  const mimeType = file.type || 'application/octet-stream';
  const base = {
    id: `paste_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    mimeType,
    size: file.size,
    kind: kindForMime(mimeType)
  } satisfies Attachment;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return Promise.resolve(undefined);
  }
  if (base.kind !== 'image') {
    return Promise.resolve(base);
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : undefined;
      resolve(result ? { ...base, dataUrl: result } : base);
    };
    reader.onerror = () => resolve(base);
    reader.readAsDataURL(file);
  });
}

/** A readable fallback name for a clipboard file the browser left unnamed. */
function defaultPastedName(mimeType: string): string {
  if (mimeType.startsWith('image/')) {
    return `pasted-image.${mimeType.slice('image/'.length) || 'png'}`;
  }
  if (mimeType.startsWith('audio/')) {
    return `pasted-audio.${mimeType.slice('audio/'.length) || 'bin'}`;
  }
  return 'pasted-file';
}

/** The broad class a chip uses, mirroring the host's mapping. */
function kindForMime(mimeType: string): Attachment['kind'] {
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

/** An image the viewer can show. `src` is a data URL already held in the webview. */
type ViewableImage = { id: string; src: string; name: string };

function viewableImages(attachments: Attachment[]): ViewableImage[] {
  return attachments.flatMap((attachment) =>
    attachment.kind === 'image' && attachment.dataUrl
      ? [{ id: attachment.id, src: attachment.dataUrl, name: attachment.name }]
      : []
  );
}

function AttachmentList({
  attachments,
  sent,
  onRemove,
  onView
}: {
  attachments: Attachment[];
  sent?: boolean;
  onRemove?: (id: string) => void;
  onView: (images: ViewableImage[], index: number) => void;
}): JSX.Element {
  const images = viewableImages(attachments);
  return (
    <ul className={sent ? 'attachments attachments--sent' : 'attachments'} aria-label="Attachments">
      {attachments.map((attachment) => {
        const imageIndex = images.findIndex((image) => image.id === attachment.id);
        const preview = imageIndex >= 0 ? images[imageIndex] : undefined;
        return (
          <li className="attachment" key={attachment.id}>
            {preview ? (
              <button
                className="attachment-open"
                type="button"
                aria-label={`View ${attachment.name}`}
                onClick={() => onView(images, imageIndex)}
              >
                <img className="attachment-thumb" src={preview.src} alt="" />
              </button>
            ) : (
              <span className="attachment-fallback" title={attachment.name} aria-label={attachment.name}>
                <PaperclipIcon />
              </span>
            )}
            {onRemove ? (
              <button
                className="attachment-remove"
                type="button"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => onRemove(attachment.id)}
              >
                <CrossIcon />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function ImageViewer({
  images,
  index,
  onIndex,
  onClose
}: {
  images: ViewableImage[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  const current = images[Math.min(Math.max(index, 0), images.length - 1)];
  const several = images.length > 1;

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'ArrowLeft' && several) {
        event.preventDefault();
        onIndex((index - 1 + images.length) % images.length);
      } else if (event.key === 'ArrowRight' && several) {
        event.preventDefault();
        onIndex((index + 1) % images.length);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [images.length, index, onClose, onIndex, several]);

  return (
    <div className="image-viewer" role="presentation" onClick={onClose}>
      <div
        className="image-viewer__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={current?.name ?? 'Image'}
        onClick={(event) => event.stopPropagation()}
      >
        {several ? (
          <button
            className="image-viewer__nav image-viewer__nav--prev"
            type="button"
            aria-label="Previous image"
            onClick={() => onIndex((index - 1 + images.length) % images.length)}
          >
            <ChevronRightIcon />
          </button>
        ) : null}
        {current ? <img className="image-viewer__image" src={current.src} alt={current.name} /> : null}
        {several ? (
          <button
            className="image-viewer__nav image-viewer__nav--next"
            type="button"
            aria-label="Next image"
            onClick={() => onIndex((index + 1) % images.length)}
          >
            <ChevronRightIcon />
          </button>
        ) : null}
        <button className="image-viewer__close" type="button" aria-label="Close image" ref={closeRef} onClick={onClose}>
          <CrossIcon />
        </button>
      </div>
    </div>
  );
}

/**
 * The always-allow rules surface: the one-click destination of the revocation
 * route from an `always` decision. It names exactly what each rule allows and
 * removes it in one action, with an empty state that explains how rules appear.
 */
function RulesScreen({
  rules,
  onBack,
  onRevoke
}: {
  rules: ApprovalRule[];
  onBack: () => void;
  onRevoke: (rule: ApprovalRule) => void;
}): JSX.Element {
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    backRef.current?.focus();
  }, []);

  return (
    <main className="app">
      <header className="view-title">
        <button className="icon-btn" type="button" aria-label="Back to chat" ref={backRef} onClick={onBack}>
          <BackIcon />
        </button>
        <span className="view-title__name">Always-allow rules</span>
      </header>

      {rules.length === 0 ? (
        <div className="empty-state" role="status">
          <span className="empty-icon" aria-hidden="true">
            <ShieldIcon />
          </span>
          <p className="empty-title">No always-allow rules</p>
          <p className="empty-text">
            When you choose “always allow” at an approval prompt, the rule appears here so you can remove it
            later.
          </p>
        </div>
      ) : (
        <div className="rules" aria-label="Always-allow rules">
          <p className="rules-intro">
            Rules you added from an “always allow” decision. Removing one brings the approval prompt back for
            that request.
          </p>
          <ul className="rules-list">
            {rules.map((rule) => (
              <li className="rule" key={rule.id}>
                <div className="rule-head">
                  <span className="rule-what" title={rule.scope}>
                    {rule.scope}
                  </span>
                  <span className="rule-scope">Lasting rule</span>
                </div>
                <div className="rule-foot">
                  <span className="rule-meta">{rule.kind}</span>
                  <span className="spacer" />
                  <button
                    className="btn btn--quiet"
                    type="button"
                    aria-label={`Remove rule allowing ${rule.scope}`}
                    onClick={() => onRevoke(rule)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}

/**
 * The compact permission trigger that sits with the model and mode in the
 * composer. The button is the shield icon; the current level is its tooltip.
 * The options open in a floating panel above the composer.
 */
function PermissionTrigger({
  options,
  selected,
  open,
  disabled,
  onToggle
}: {
  options: PermissionOption[];
  selected: PermissionLevel;
  open: boolean;
  disabled: boolean;
  onToggle: () => void;
}): JSX.Element {
  const current = options.find((option) => option.level === selected) ?? options[0];
  return (
    <button
      className="control-trigger control-trigger--permission"
      type="button"
      data-level={current?.level}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls="permission-panel"
      aria-label={`Permission level: ${current?.label ?? selected}`}
      title={current?.label ?? selected}
      disabled={disabled}
      onClick={onToggle}
    >
      <ShieldIcon className="ico ico--sm" />
    </button>
  );
}

/**
 * The permission level panel, listing each level with one plain sentence.
 * `unrestricted` is visually distinct and its row only opens the labelled
 * confirmation, so it can never be applied directly.
 */
function PermissionPanel({
  options,
  selected,
  onSelect,
  onOpenRules,
  onClose
}: {
  options: PermissionOption[];
  selected: PermissionLevel;
  onSelect: (option: PermissionOption) => void;
  onOpenRules: () => void;
  onClose: () => void;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.querySelector<HTMLButtonElement>('.control-option')?.focus();
  }, []);
  return (
    <div
      className="control-panel"
      id="permission-panel"
      ref={panelRef}
      role="listbox"
      aria-label="Permission level"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="control-panel__head">
        <span>Permission level</span>
        <span className="spacer" />
        <span className="control-panel__note">Applies to this conversation</span>
      </div>
      {options.map((option) => (
        <button
          className={`control-option${option.requiresConfirmation ? ' control-option--danger' : ''}`}
          type="button"
          role="option"
          aria-selected={option.level === selected}
          key={option.level}
          onClick={() => onSelect(option)}
        >
          <span className="control-option__body">
            <span className="control-option__name">
              {option.requiresConfirmation ? (
                <AlertIcon className="ico ico--xs control-option__warn" />
              ) : null}
              {option.label}
              {option.requiresConfirmation ? <span className="chip chip--scope">Needs confirmation</span> : null}
            </span>
            <span className="control-option__desc">{option.description}</span>
          </span>
          {option.level === selected ? <CheckIcon className="control-check" /> : null}
        </button>
      ))}
      <div className="control-panel__foot">
        <button className="btn btn--link" type="button" onClick={onOpenRules}>
          Review and remove always-allow rules
        </button>
      </div>
    </div>
  );
}

/** Compact mode trigger. The menu opens upward from this button. */
function ModeTrigger({
  snapshot,
  open,
  disabled,
  onToggle
}: {
  snapshot: ModeSnapshot;
  open: boolean;
  disabled: boolean;
  onToggle: () => void;
}): JSX.Element {
  const current = snapshot.options.find((option) => option.mode === snapshot.selected) ?? snapshot.options[0];
  const mode = current?.mode ?? snapshot.selected;
  return (
    <button
      className={`control-trigger control-trigger--mode control-trigger--${mode}`}
      type="button"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls="mode-menu"
      aria-label={`Mode: ${current?.label ?? snapshot.selected}`}
      disabled={disabled}
      onClick={onToggle}
    >
      <span className="control-label">{current?.label ?? snapshot.selected}</span>
      <ChevronDownIcon className="control-chevron" />
    </button>
  );
}

/** Short mode list anchored above the trigger. Names only, colored by mode. */
function ModeMenu({
  snapshot,
  disabled,
  onSelect,
  onClose
}: {
  snapshot: ModeSnapshot;
  disabled: boolean;
  onSelect: (mode: DefaultMode) => void;
  onClose: () => void;
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('.mode-menu__option')?.focus();
  }, []);
  return (
    <div
      className="mode-menu__list"
      id="mode-menu"
      ref={menuRef}
      role="listbox"
      aria-label="Mode"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {snapshot.options.map((option) => (
        <button
          className={`mode-menu__option mode-menu__option--${option.mode}`}
          type="button"
          role="option"
          aria-selected={option.mode === snapshot.selected}
          disabled={disabled}
          key={option.mode}
          onClick={() => onSelect(option.mode)}
        >
          <span>{option.label}</span>
          {option.mode === snapshot.selected ? <CheckIcon className="control-check" /> : null}
        </button>
      ))}
    </div>
  );
}

/**
 * The floating per-model settings panel above the composer. It renders the host-resolved
 * capability snapshot for the selected model and posts each change back to the
 * host, which clamps and persists it. Nothing here mutates the transcript.
 */
function ModelSettingsPanel({
  view,
  modelId,
  status,
  error,
  conversationTokens,
  onContextChange,
  onThinkingChange,
  onResetField,
  onResetAll,
  onRetry,
  onClose
}: {
  view?: ModelSettingsView;
  modelId: string;
  status: AppState['modelCapabilityStatus'];
  error?: string;
  conversationTokens: number;
  onContextChange: (value: number) => void;
  onThinkingChange: (value: string) => void;
  onResetField: (field: ModelSettingField) => void;
  onResetAll: () => void;
  onRetry: () => void;
  onClose: () => void;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, []);

  const ready = status === 'ready' && view !== undefined;
  return (
    <div
      className="control-panel model-settings-panel"
      id="model-settings-panel"
      ref={panelRef}
      role="dialog"
      aria-label="Model settings"
      aria-busy={status === 'loading'}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="control-panel__head">
        <SlidersIcon className="ico ico--sm" />
        <span>Model settings</span>
        {view?.isOverridden ? <span className="chip chip--scope">Modified</span> : null}
        <span className="spacer" />
        <span className="control-panel__note">{modelId}</span>
        <button className="icon-btn" type="button" aria-label="Close model settings" onClick={onClose}>
          <CrossIcon />
        </button>
      </div>

      {status === 'error' || status === 'loading' || (ready && view) ? (
        <div className="model-settings-panel__body">
          {status === 'error' ? (
            <div className="model-settings-error" role="alert">
              <AlertIcon className="ico ico--xs" />
              <div className="model-settings-error__body">
                <p className="model-settings-error__title">Could not load this model's limits</p>
                <p className="model-settings-error__text">
                  {error ?? 'The capability read did not complete, so no value is shown.'}
                </p>
                <button className="btn" type="button" onClick={onRetry}>
                  <RefreshIcon />
                  Retry
                </button>
              </div>
            </div>
          ) : null}

          {status === 'loading' ? (
            <div className="model-settings-loading" role="status" aria-live="polite">
              <span>Reading this model's limits…</span>
              <span className="skeleton-bar model-settings-loading__bar" aria-hidden="true" />
            </div>
          ) : null}

          {ready && view ? (
            <>
              <ContextField
                control={view.context}
                conversationTokens={conversationTokens}
                onChange={onContextChange}
                onReset={() => onResetField('contextWindow')}
              />
              <ThinkingField
                control={view.thinking}
                onChange={onThinkingChange}
                onReset={() => onResetField('thinking')}
              />
            </>
          ) : null}
        </div>
      ) : null}

      <div className="control-panel__foot model-settings-foot">
        <button className="btn btn--link" type="button" disabled={!view?.isOverridden} onClick={onResetAll}>
          Reset all to defaults
        </button>
        <span className="spacer" />
        <span className="model-settings-apply">Changes apply to the next turn</span>
      </div>
    </div>
  );
}

/** The bounded max-context control: a stepped slider with a readable readout. */
function ContextField({
  control,
  conversationTokens,
  onChange,
  onReset
}: {
  control: ContextControl;
  conversationTokens: number;
  onChange: (value: number) => void;
  onReset: () => void;
}): JSX.Element {
  if (!control.available || control.value === undefined || control.ceiling === undefined) {
    return (
      <div className="model-settings-field">
        <div className="model-settings-field__head">
          <span className="model-settings-field__label">{MODEL_SETTING_LABELS.contextWindow}</span>
        </div>
        <p className="model-settings-unavailable">
          <InfoIcon className="ico ico--xs" />
          <span>{control.unavailableReason}</span>
        </p>
      </div>
    );
  }

  const { floor, ceiling, step, value, defaultValue, reportedMin } = control;
  const percent = ceiling > floor ? ((value - floor) / (ceiling - floor)) * 100 : 0;
  const defaultPercent =
    defaultValue !== undefined && ceiling > floor
      ? ((defaultValue - floor) / (ceiling - floor)) * 100
      : undefined;
  const drops = dropsEarlierTurns(value, conversationTokens);

  return (
    <div className="model-settings-field">
      <div className="model-settings-field__head">
        <label className="model-settings-field__label" htmlFor="model-context-range">
          {MODEL_SETTING_LABELS.contextWindow}
        </label>
        <span className="spacer" />
        <span className="model-settings-readout">
          <strong>{formatContextTokens(value)}</strong>{' '}
          <span className="model-settings-exact">{formatExactTokens(value)} tokens</span>
        </span>
      </div>

      <div className="model-settings-range-wrap">
        <input
          className="model-settings-range"
          id="model-context-range"
          type="range"
          data-autofocus
          min={floor}
          max={ceiling}
          step={step}
          value={value}
          aria-valuetext={`${formatContextTokens(value)}, ${formatExactTokens(value)} tokens`}
          aria-describedby="model-context-hint"
          onChange={(event) => onChange(Number(event.target.value))}
        />
        {defaultPercent !== undefined ? (
          <span
            className="model-settings-range__tick"
            style={{ ['--at' as string]: String(defaultPercent / 100) }}
            title={`Model default ${formatContextTokens(defaultValue ?? value)}`}
            aria-hidden="true"
          />
        ) : null}
      </div>
      <div className="model-settings-scale">
        <span>{formatContextTokens(floor)}</span>
        {percent > 0 && percent < 100 ? <span>{formatContextTokens(value)}</span> : null}
        <span>{formatContextTokens(ceiling)}</span>
      </div>

      <div className="model-settings-sub">
        <span>
          {defaultValue !== undefined
            ? `Default ${formatContextTokens(defaultValue)} · `
            : 'No reported default · '}
          range {formatContextTokens(floor)} to {formatContextTokens(ceiling)}
          {reportedMin === undefined ? ' (minimum not reported)' : ''}
        </span>
        <span className="spacer" />
        <button className="btn btn--link" type="button" disabled={!control.overridden} onClick={onReset}>
          Reset to default
        </button>
      </div>

      <p className={drops ? 'model-settings-warning' : 'model-settings-hint'} id="model-context-hint">
        {drops ? (
          <>
            <AlertIcon className="ico ico--xs" />
            <span>
              Below the ~{formatExactTokens(conversationTokens)} tokens already in this conversation. Earlier
              turns will be dropped from the next request.
            </span>
          </>
        ) : (
          <span>
            {conversationTokens > 0
              ? `The conversation uses about ${formatExactTokens(conversationTokens)} tokens.`
              : 'Applies to the whole conversation sent on the next turn.'}
          </span>
        )}
      </p>
    </div>
  );
}

/** The thinking selector: only the model's supported levels are offered. */
function ThinkingField({
  control,
  onChange,
  onReset
}: {
  control: ThinkingControl;
  onChange: (value: string) => void;
  onReset: () => void;
}): JSX.Element {
  if (!control.available || control.value === undefined) {
    return (
      <div className="model-settings-field">
        <div className="model-settings-field__head">
          <span className="model-settings-field__label">{MODEL_SETTING_LABELS.thinking}</span>
        </div>
        <p className="model-settings-unavailable">
          <InfoIcon className="ico ico--xs" />
          <span>{control.unavailableReason}</span>
        </p>
      </div>
    );
  }

  return (
    <div className="model-settings-field">
      <div className="model-settings-field__head">
        <span className="model-settings-field__label" id="model-thinking-label">
          {MODEL_SETTING_LABELS.thinking}
        </span>
      </div>
      <div
        className="model-settings-segmented"
        role="radiogroup"
        aria-labelledby="model-thinking-label"
        style={{ ['--segments' as string]: String(control.offered.length) }}
      >
        {control.offered.map((level) => (
          <button
            className="model-settings-segment"
            type="button"
            role="radio"
            aria-checked={level === control.value}
            key={level}
            onClick={() => onChange(level)}
          >
            {level}
          </button>
        ))}
      </div>
      <div className="model-settings-sub">
        <span>
          {control.defaultValue !== undefined
            ? `Default ${control.defaultValue} · `
            : 'No reported default · '}
          supports {control.offered.join(', ')}
        </span>
        <span className="spacer" />
        <button className="btn btn--link" type="button" disabled={!control.overridden} onClick={onReset}>
          Reset to default
        </button>
      </div>
    </div>
  );
}

/** The labelled confirmation before the unrestricted level can be applied. */
function UnrestrictedConfirmation({
  onConfirm,
  onCancel
}: {
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div className="confirm-gate" role="alertdialog" aria-label="Confirm unrestricted permission">
      <div className="confirm-gate__head">
        <span className="confirm-gate__icon" aria-hidden="true">
          <AlertIcon />
        </span>
        <div>
          <p className="confirm-gate__title">Turn off the safety net?</p>
          <p className="confirm-gate__text">
            Unrestricted removes the sandbox and stops asking before commands and edits. The agent acts
            without approval. Choose this only for a task you trust.
          </p>
        </div>
      </div>
      <div className="confirm-gate__actions">
        <button className="btn" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn--danger" type="button" onClick={onConfirm}>
          Enable unrestricted
        </button>
      </div>
    </div>
  );
}

/**
 * Confirmation before a turn moves into a mode that can do more than the one
 * already selected. Dismissing it keeps the current mode and still sends.
 */
function ModeSwitchModal({
  from,
  to,
  onAccept,
  onDecline
}: {
  from: DefaultMode;
  to: DefaultMode;
  onAccept: () => void;
  onDecline: () => void;
}): JSX.Element {
  const fromLabel = modeDescriptor(from).label;
  const toLabel = modeDescriptor(to).label;
  const declineRef = useRef(onDecline);
  const acceptRef = useRef(onAccept);
  declineRef.current = onDecline;
  acceptRef.current = onAccept;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        declineRef.current();
        return;
      }
      // Enter on a dialog button activates that button. Enter from the composer
      // would otherwise insert a newline under the dialog, so it confirms instead.
      if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        event.stopPropagation();
        acceptRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      // The chat surface can be replaced (settings, for example) while the
      // host is still waiting. Treat that as a dismiss so the turn continues.
      declineRef.current();
    };
  }, []);

  return (
    <div className="mode-modal" role="presentation" onClick={() => declineRef.current()}>
      <div
        className="mode-modal__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mode-switch-title"
        aria-describedby="mode-switch-text"
        onClick={(event) => event.stopPropagation()}
      >
        <p id="mode-switch-title" className="mode-modal__title">
          Switch to {toLabel} mode?
        </p>
        <p id="mode-switch-text" className="mode-modal__text">
          This request sounds like it needs {toLabel} mode. Switch from {fromLabel} and continue?
        </p>
        <div className="mode-modal__actions">
          <button className="btn btn--secondary" type="button" onClick={() => declineRef.current()}>
            Stay in {fromLabel}
          </button>
          <button className="btn btn--primary" type="button" autoFocus onClick={() => acceptRef.current()}>
            Switch and continue
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The confirmation before a checkpoint restore. This chat's later messages are
 * removed. When other chats would lose file, todo, or plan work, they are
 * listed before anything is written. Their messages stay.
 */
function RestoreConfirmation({
  preview,
  onConfirm,
  onCancel
}: {
  preview: RestorePreview;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const messageCount = preview.thisChat.messages.length;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="restore-modal" role="presentation" onClick={onCancel}>
      <div
        className="restore-modal__dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm checkpoint restore"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="restore-modal__title">Restore to before this message?</p>
        <p className="restore-modal__text">
          This chat goes back to the moment before the message was sent.
          {messageCount > 0
            ? ` ${messageCount} message${messageCount === 1 ? '' : 's'} in this chat will be removed.`
            : ''}{' '}
          Files, todos, and plans return to that point. You can undo the restore afterwards.
        </p>
        <PreviewList messages={preview.thisChat.messages} paths={preview.thisChat.paths} planChanges={preview.thisChat.planChanges} />
        {preview.otherChats.length > 0 ? (
          <div className="restore-modal__warn">
            <p className="restore-modal__warn-title">Other chats will also lose work</p>
            <p className="restore-modal__text">
              These chats keep their messages, but the file, todo, and plan changes below will be undone.
            </p>
            <ul className="restore-modal__chats">
              {preview.otherChats.map((chat) => (
                <li key={`${chat.backendId}:${chat.threadId}`}>
                  <p className="restore-modal__chat-title">{chat.title}</p>
                  <PreviewList messages={chat.messages} paths={chat.paths} planChanges={chat.planChanges} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="restore-modal__actions">
          <button className="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn--danger" type="button" onClick={onConfirm}>
            Restore
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewList({
  messages,
  paths,
  planChanges
}: {
  messages: RestorePreview['thisChat']['messages'];
  paths: string[];
  planChanges: boolean;
}): JSX.Element | null {
  const shownMessages = messages.slice(0, 6);
  const shownPaths = paths.slice(0, 8);
  if (shownMessages.length === 0 && shownPaths.length === 0 && !planChanges) {
    return null;
  }
  return (
    <div className="restore-modal__detail">
      {shownMessages.length > 0 ? (
        <ul className="restore-modal__messages">
          {shownMessages.map((message) => (
            <li key={message.id}>{message.preview}</li>
          ))}
          {messages.length > shownMessages.length ? <li>and {messages.length - shownMessages.length} more</li> : null}
        </ul>
      ) : null}
      {shownPaths.length > 0 ? (
        <ul className="restore-modal__paths">
          {shownPaths.map((path) => (
            <li key={path}>{path}</li>
          ))}
          {paths.length > shownPaths.length ? <li>and {paths.length - shownPaths.length} more</li> : null}
        </ul>
      ) : null}
      {planChanges ? <p className="restore-modal__text">The plan and todos will change.</p> : null}
    </div>
  );
}
