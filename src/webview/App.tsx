import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type Dispatch, type JSX } from 'react';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRule,
  BackendAvailability,
  BackendModel,
  FileChange,
  ThreadSummary
} from '../backends/types';
import logoUrl from '../../media/melink-logo.png';
import { Markdown } from './Markdown';
import {
  AlertIcon,
  ArrowIcon,
  BackIcon,
  CheckIcon,
  ChevronDownIcon,
  ContextIcon,
  CopyIcon,
  CrossIcon,
  FileIcon,
  HistoryIcon,
  InfoIcon,
  PaperclipIcon,
  PlusIcon,
  RefreshIcon,
  RestoreIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  SlidersIcon,
  SparkIcon,
  StopIcon,
  TerminalIcon
} from './Icons';
import { SettingsScreen } from './SettingsScreen';
import { TabList, type TabItem } from './Tabs';
import { ContextStrip } from './ContextStrip';
import { ChangesReview } from './ChangesReview';
import { ChangedFilesStrip } from './ChangedFilesStrip';
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
  type TranscriptItemView
} from './state';
import { friendlyToolTitle, isRawToolName, isStatusText, toolCardPresentation } from '../backends/toolLabel.ts';
import { resolveContextMax } from '../backends/contextUsage.ts';
import type {
  CheckpointView,
  ConflictResolution,
  ModeSnapshot,
  ModelSettingField,
  ModelSettingOverrides,
  PermissionOption,
  RestoreCheckpointResult,
  SettingsPatch,
  ThinkingLevel
} from '../protocol';
import type { Attachment, DefaultMode, PermissionLevel } from '../backends/types';

const bridge: HostBridge = createHostBridge();

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [draft, setDraft] = useState('');
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const [modelFilter, setModelFilter] = useState('');
  const [modePanelOpen, setModePanelOpen] = useState(false);
  const [permissionPanelOpen, setPermissionPanelOpen] = useState(false);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  /** Follow new transcript content only while the reader is already at the bottom. */
  const stickToBottomRef = useRef(true);
  /**
   * The in-flight attach request. A late `attachmentsPicked` from a superseded
   * pick is ignored, so an old response cannot repopulate cleared chips.
   */
  const attachRequestRef = useRef<string | undefined>(undefined);
  const attachCounterRef = useRef(0);

  useEffect(() => {
    const unsubscribe = bridge.subscribe((message) => {
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
        case 'agentEvent':
          dispatch({ type: 'agentEvent', event: message.event });
          break;
        case 'conversation':
          dispatch({
            type: 'conversation',
            backendId: message.backendId,
            threadId: message.threadId,
            model: message.model,
            permissionLevel: message.permissionLevel,
            mode: message.mode,
            replay: message.replay,
            pendingApproval: message.pendingApproval,
            plan: message.plan,
            keepPendingUserMessage: message.keepPendingUserMessage
          });
          break;
        case 'restoring':
          dispatch({ type: 'restoring', value: message.value });
          break;
        case 'busy':
          dispatch({ type: 'busy', value: message.value, backendId: message.backendId, threadId: message.threadId });
          break;
        case 'notice':
          dispatch({ type: 'notice', level: message.level, message: message.message, action: message.action });
          break;
        case 'settings':
          dispatch({ type: 'settings', settings: message.settings });
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
        case 'context':
          dispatch({
            type: 'context',
            view: message.view,
            settingsEnabled: message.settingsEnabled,
            exclusions: message.exclusions,
            includeViewedFile: message.includeViewedFile
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
          dispatch({ type: 'changeDecision', results: message.results, message: message.message });
          break;
        case 'changes/checkpoints':
          dispatch({ type: 'checkpoints', checkpoints: message.checkpoints });
          break;
        case 'changes/restoreResult':
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
          dispatch({ type: 'addAttachments', attachments: message.attachments });
          break;
        case 'attachmentError':
          dispatch({ type: 'attachmentError', message: message.message });
          break;
      }
    });
    bridge.post({ type: 'ready' });
    return unsubscribe;
  }, []);

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
  useEffect(() => {
    if (state.selectedBackendId && state.selectedModel) {
      dispatch({ type: 'modelCapabilityLoading' });
      bridge.post({
        type: 'getModelCapability',
        providerId: state.selectedBackendId,
        modelId: state.selectedModel
      });
    }
  }, [state.selectedBackendId, state.selectedModel]);

  const onTranscriptScroll = (): void => {
    const el = transcriptRef.current;
    if (!el) {
      return;
    }
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance <= 48;
  };

  useLayoutEffect(() => {
    const el = transcriptRef.current;
    if (!el || !stickToBottomRef.current) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [
    state.transcript,
    state.notice,
    state.startingTurn,
    state.busy,
    state.plan,
    state.restoreResult,
    state.settingsOpen,
    state.rulesOpen
  ]);

  // Read the review snapshot for a turn the host recorded. The host pushes the
  // authoritative change set (and reposts the latest one on reload); the review
  // — paths, diffs and decisions — is read through `changes/list`, the same path
  // a decision repaint uses, so the panel never disagrees with the host. Keyed on
  // the turn id so a new finished turn always re-reads, and a repaint of the same
  // turn does not.
  useEffect(() => {
    if (!state.activeThreadId || !state.selectedBackendId || !state.changesTurnId) {
      return;
    }
    bridge.post({
      type: 'changes/list',
      backendId: state.selectedBackendId,
      threadId: state.activeThreadId,
      turnId: state.changesTurnId
    });
  }, [state.activeThreadId, state.selectedBackendId, state.changesTurnId]);

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

  const toggleHistory = (): void => {
    const open = !historyOpen;
    setHistoryOpen(open);
    if (open && active) {
      dispatch({ type: 'threadsLoading', backendId: active.id, value: true });
      bridge.post({ type: 'listThreads', backendId: active.id });
    }
  };

  const resumeThread = (threadId: string): void => {
    if (!active || threadId === state.activeThreadId) {
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(false);
    dispatch({ type: 'dismissNotice' });
    bridge.post({ type: 'resumeThread', backendId: active.id, threadId });
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

  const openSettings = (): void => {
    dispatch({ type: 'openSettings' });
    bridge.post({ type: 'getSettings' });
  };

  const closeSettings = (): void => {
    dispatch({ type: 'closeSettings' });
  };

  const saveSettings = (patch: SettingsPatch): void => {
    bridge.post({ type: 'saveSettings', patch });
  };

  const saveOllamaToken = (value: string): void => {
    bridge.post({ type: 'setOllamaToken', value });
  };

  const clearOllamaToken = (): void => {
    bridge.post({ type: 'clearOllamaToken' });
  };

  const upgradeOpencode = (): void => {
    dispatch({ type: 'opencodeUpgrade', pending: true });
    bridge.post({ type: 'upgradeOpencode' });
  };

  const installOpencode = (): void => {
    dispatch({ type: 'opencodeInstall', pending: true });
    bridge.post({ type: 'installOpencode' });
  };

  const testConnection = (backendId: string): void => {
    dispatch({ type: 'connectionTestPending', backendId });
    bridge.post({ type: 'testConnection', backendId });
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

  const selectPermission = (option: PermissionOption): void => {
    // A widening level is never applied as a side effect: it opens the labelled
    // confirmation and only an explicit confirm dispatches the change.
    if (option.requiresConfirmation) {
      dispatch({ type: 'requestPermissionConfirmation' });
      return;
    }
    dispatch({ type: 'selectPermission', level: option.level });
  };

  const confirmPermissionChange = (): void => {
    const target = permissionOptions.find((option) => option.requiresConfirmation);
    if (target) {
      dispatch({ type: 'selectPermission', level: target.level });
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
    bridge.post({
      type: 'decideApproval',
      backendId: pending.backendId ?? state.selectedBackendId ?? '',
      threadId: pending.threadId ?? state.activeThreadId ?? '',
      requestId: pending.approval.id,
      decision
    });
  };

  const send = (): void => {
    const text = draft.trim();
    if ((!text && state.attachments.length === 0) || state.restoring || pending) {
      return;
    }
    if (state.busy) {
      if (!text || state.attachments.length > 0 || active?.id !== 'codex') return;
      dispatch({ type: 'localUserMessage', text });
      bridge.post({ type: 'steerTurn', text });
      dispatch({ type: 'dismissNotice' });
      setDraft('');
      return;
    }
    dispatch({ type: 'localUserMessage', text, attachments: state.attachments });
    dispatch({ type: 'dismissNotice' });
    bridge.post({
      type: 'sendTurn',
      text,
      backendId: state.selectedBackendId,
      model: state.selectedModel,
      permissionLevel: state.permissionLevel,
      attachments: state.attachments
    });
    setDraft('');
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

  const runNoticeAction = (action: 'setToken' | 'clearToken' | 'refresh'): void => {
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
  const canSend =
    (Boolean(draft.trim()) || state.attachments.length > 0) &&
    !state.restoring &&
    !pending &&
    active?.status === 'available' &&
    (!state.busy || (active.id === 'codex' && Boolean(draft.trim()) && state.attachments.length === 0));

  const newConversation = (): void => {
    if (!active) {
      return;
    }
    setHistoryOpen(false);
    dispatch({ type: 'dismissNotice' });
    setDraft('');
    bridge.post({
      type: 'startThread',
      backendId: active.id,
      model: state.selectedModel,
      permissionLevel: state.permissionLevel
    });
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
  // Restoring a checkpoint reverts files only; the transcript is never touched.
  // It is destructive and never implicit: the confirmation names the affected
  // file count and paths first, and only an explicit confirm posts the restore.
  const restoreCheckpoint = (messageId: string, fileCount: number, paths: string[]): void => {
    dispatch({ type: 'requestRestoreConfirmation', messageId, fileCount, paths });
  };

  const confirmRestore = (): void => {
    const confirmation = state.restoreConfirmation;
    if (!confirmation) {
      return;
    }
    const threadId = state.activeThreadId;
    const backendId = state.selectedBackendId;
    if (!threadId || !backendId) {
      dispatch({ type: 'cancelRestoreConfirmation' });
      return;
    }
    dispatch({ type: 'cancelRestoreConfirmation' });
    bridge.post({
      type: 'changes/restoreCheckpoint',
      backendId,
      threadId,
      messageId: confirmation.messageId
    });
  };

  // Undo a restore by restoring the pre-restore snapshot it captured. The undo
  // is a restore like any other: it reverts files only and never adds or removes
  // a message.
  const undoRestore = (restorePointId?: string): void => {
    const threadId = state.activeThreadId;
    const backendId = state.selectedBackendId;
    if (!restorePointId || !threadId || !backendId) {
      return;
    }
    bridge.post({
      type: 'changes/restoreCheckpoint',
      backendId,
      threadId,
      restorePointId
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
    dispatch({ type: 'planRevising' });
    dispatch({ type: 'localUserMessage', text });
    bridge.post({
      type: 'sendTurn',
      text,
      backendId: state.selectedBackendId,
      model: state.selectedModel,
      permissionLevel: state.permissionLevel,
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
  const openChangeDiff = (path: string): void => {
    const review = state.changeReview;
    const threadId = state.activeThreadId;
    const backendId = state.selectedBackendId;
    if (!review || !threadId || !backendId) {
      return;
    }
    bridge.post({ type: 'changes/openDiff', backendId, threadId, turnId: review.turnId, path });
  };

  const openChangeView = (): void => {
    const review = state.changeReview;
    const threadId = state.activeThreadId;
    const backendId = state.selectedBackendId;
    if (!review || !threadId || !backendId) {
      return;
    }
    bridge.post({ type: 'changes/openView', backendId, threadId, turnId: review.turnId });
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
    target: { kind: 'file'; path: string } | { kind: 'all' },
    decision: 'accepted' | 'rejected',
    conflictResolution?: ConflictResolution
  ): void => {
    const review = state.changeReview;
    const threadId = state.activeThreadId;
    const backendId = state.selectedBackendId;
    if (!review || !threadId || !backendId) {
      return;
    }
    dispatch({ type: 'changeDeciding', value: true });
    if (target.kind === 'all') {
      bridge.post({
        type: 'changes/decideAll',
        backendId,
        threadId,
        turnId: review.turnId,
        decision,
        ...(conflictResolution !== undefined ? { conflictResolution } : {})
      });
      return;
    }
    bridge.post({
      type: 'changes/decide',
      backendId,
      threadId,
      turnId: review.turnId,
      path: target.path,
      decision,
      ...(conflictResolution !== undefined ? { conflictResolution } : {})
    });
  };

  const keepChange = (path: string): void => {
    postChangeDecision({ kind: 'file', path }, 'accepted');
  };

  const resolveConflict = (path: string, resolution: ConflictResolution): void => {
    // Any explicit choice is a reject against the file: keep-current records the
    // decision and writes nothing, overwrite-pre-turn restores the pre-turn bytes.
    postChangeDecision({ kind: 'file', path }, 'rejected', resolution);
  };

  const keepAll = (): void => {
    postChangeDecision({ kind: 'all' }, 'accepted');
  };

  const loadChangeHunks = (path: string): void => {
    const backendId = state.selectedBackendId;
    const threadId = state.activeThreadId;
    const turnId = state.changeReview?.turnId ?? state.changesTurnId;
    if (!backendId || !threadId || !turnId) {
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
      postChangeDecision({ kind: 'all' }, 'rejected');
    } else {
      const path = confirmation.paths[0];
      if (path) {
        postChangeDecision({ kind: 'file', path }, 'rejected');
      }
    }
  };


  // The settings and rules screens replace the chat surface inside the same
  // view; the model and composer panels float over the chat without replacing
  // it. The rules screen is the one-click destination of the revocation
  // route from an `always` decision.
  if (state.settingsOpen) {
    return (
      <SettingsScreen
        settings={state.settings}
        connectionTest={state.connectionTest}
        onBack={closeSettings}
        onSave={saveSettings}
        onSaveToken={saveOllamaToken}
        onClearToken={clearOllamaToken}
        onTestConnection={testConnection}
        opencodeUpgrade={state.opencodeUpgrade}
        onUpgradeOpencode={upgradeOpencode}
        opencodeInstall={state.opencodeInstall}
        onInstallOpencode={installOpencode}
      />
    );
  }

  if (state.rulesOpen) {
    return (
      <RulesScreen
        rules={storedRules}
        onBack={() => dispatch({ type: 'closeRules' })}
        onRevoke={revokeRule}
      />
    );
  }

  const chatEmpty = state.transcript.length === 0 && !state.restoring;

  return (
    <main className={chatEmpty ? 'app app--chat-empty' : 'app'}>
      <header className="view-title">
        <button
          className="model-trigger"
          type="button"
          aria-haspopup="listbox"
          aria-expanded={modelPanelOpen}
          aria-controls="model-panel"
          onClick={toggleModelPanel}
        >
          <span className="trigger-label">Model</span>
          {active?.status === 'available' ? (
            <span className={`provider-dot provider-dot--${active.id}`} aria-hidden="true" />
          ) : null}
          <span className="trigger-model">{triggerLabel}</span>
          <ChevronDownIcon className="trigger-chevron" />
        </button>
        <span className="view-title__actions">
          <button
            className="icon-btn icon-btn--new-chat"
            type="button"
            aria-label="New conversation"
            title="New conversation"
            disabled={!active}
            onClick={newConversation}
          >
            <PlusIcon />
          </button>
          <span className="view-title__sep" aria-hidden="true" />
          <button
            className="icon-btn"
            type="button"
            aria-label="Conversation history"
            title="Conversation history"
            aria-expanded={historyOpen}
            disabled={!active}
            onClick={toggleHistory}
          >
            <HistoryIcon />
          </button>
          <button
            className="icon-btn"
            type="button"
            aria-label="Refresh backend availability"
            title="Refresh backend availability"
            onClick={() => {
              dispatch({ type: 'refresh' });
              bridge.post({ type: 'refresh' });
            }}
          >
            <RefreshIcon />
          </button>
          <button
            className="icon-btn"
            type="button"
            aria-label="Refresh project context"
            title="Refresh project context"
            disabled={!active}
            onClick={() => bridge.post({ type: 'refreshContext' })}
          >
            <ContextIcon />
          </button>
          <button
            className="icon-btn"
            type="button"
            aria-label="Open settings"
            title="Open settings"
            onClick={openSettings}
          >
            <SettingsIcon />
          </button>
        </span>
      </header>

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

      {historyOpen && active ? (
        <HistoryPanel
          threads={state.threads[active.id] ?? []}
          loading={state.threadLoading[active.id] ?? false}
          activeThreadId={state.activeThreadId}
          backendId={active.id}
          threadActivity={state.threadActivity}
          onSelect={resumeThread}
        />
      ) : null}


      <div
        className="transcript"
        ref={transcriptRef}
        role="log"
        aria-label="Conversation transcript"
        onScroll={onTranscriptScroll}
      >
        {state.restoring ? (
          <div className="restoring" role="status">
            <span className="spinner" aria-hidden="true" />
            Restoring conversation...
          </div>
        ) : state.transcript.length === 0 && !state.startingTurn && !state.notice ? (
          <EmptyState state={state} dispatch={dispatch} hasAvailable={available.length > 0} />
        ) : (
          state.transcript.map((item) => (
            <TranscriptRow
              key={item.id}
              item={item}
              providerId={item.backendId ?? active?.id ?? 'ollama'}
              pendingId={pending?.id}
              checkpoint={state.checkpoints?.find((entry) => entry.messageId === item.id)}
              onDecide={decide}
              onOpenRules={() => dispatch({ type: 'openRules' })}
              onRestore={restoreCheckpoint}
            />
          ))
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
              <span className="meta-strong">Agent</span>
              <span className="stream-status" role="status">
                <span className="spinner" aria-hidden="true" />
                Starting
              </span>
            </div>
          </div>
        ) : null}

        {state.notice ? (
          <NoticeBanner notice={state.notice} onAction={runNoticeAction} />
        ) : null}

        {state.restoreResult?.undoPointId && !state.restoreResult.aborted ? (
          <RestoreResultStrip
            result={state.restoreResult}
            onUndo={() => undoRestore(state.restoreResult?.undoPointId)}
          />
        ) : null}

        {state.busy ? (
          <div className="typing-dots" role="status" aria-label="Agent is working">
            <span />
            <span />
            <span />
          </div>
        ) : null}
      </div>

      <footer className={chatEmpty ? 'composer composer--expanded' : 'composer'}>
        {state.plan?.built ? (
          <div className="todo-floating">
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
        {state.restoreConfirmation ? (
          <RestoreConfirmation
            fileCount={state.restoreConfirmation.fileCount}
            paths={state.restoreConfirmation.paths}
            onConfirm={confirmRestore}
            onCancel={() => dispatch({ type: 'cancelRestoreConfirmation' })}
          />
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
        {modelSettingsOpen && state.selectedBackendId && state.selectedModel ? (
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
        {state.changes && state.changes.length > 0 ? (
          <ChangedFilesStrip
            entries={state.changes}
            files={state.changeReview && state.changeReview.turnId === state.changesTurnId ? state.changeReview.files : []}
            onOpenFile={openChangeFile}
          >
            {state.changeReview && state.changeReview.files.length > 0 ? (
              <ChangesReview
                review={state.changeReview}
                busy={state.busy}
                deciding={state.changeDeciding}
                decisionResults={state.changeDecision?.results}
                rejectConfirm={state.changeRejectConfirm}
                checkpoint={state.checkpoints?.find((entry) => entry.turnId === state.changeReview?.turnId)}
                onOpenFile={openChangeFile}
                onOpenDiff={openChangeDiff}
                onOpenAllInEditor={openChangeView}
                onRevealInSourceControl={revealChangeInSourceControl}
                onKeep={keepChange}
                onRequestReject={(scope, paths) => dispatch({ type: 'requestChangeRejectConfirmation', scope, paths })}
                onCancelReject={() => dispatch({ type: 'cancelChangeRejectConfirmation' })}
                onConfirmReject={confirmChangeReject}
                onKeepAll={keepAll}
                onResolveConflict={resolveConflict}
                onRestoreCheckpoint={(entry) => restoreCheckpoint(entry.messageId, entry.fileCount, entry.paths)}
                onLoadHunks={loadChangeHunks}
              />
            ) : null}
          </ChangedFilesStrip>
        ) : null}
        <ContextStrip
          view={state.contextView}
          settingsEnabled={state.contextSettingsEnabled}
          exclusions={state.contextExclusions}
          busy={state.busy}
          onOpenFile={openContextFile}
          includeViewedFile={state.includeViewedFile}
          onSetIncludeViewedFile={setIncludeViewedFile}
          usedTokens={state.contextUsedTokens ?? 0}
          maxTokens={contextMax}
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
        <div className="composer-box">
          {state.attachments.length > 0 ? (
            <ul className="attachments" aria-label="Attachments">
              {state.attachments.map((attachment) => (
                <li className="attachment" key={attachment.id}>
                  {attachment.kind === 'image' && attachment.dataUrl ? (
                    <img className="attachment-thumb" src={attachment.dataUrl} alt="" />
                  ) : (
                    <span className="attachment-icon" aria-hidden="true">
                      <PaperclipIcon />
                    </span>
                  )}
                  <span className="attachment-name" title={attachment.name}>
                    {attachment.name}
                  </span>
                  {typeof attachment.size === 'number' ? (
                    <span className="attachment-size">{formatBytes(attachment.size)}</span>
                  ) : null}
                  <button
                    className="icon-btn attachment-remove"
                    type="button"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() => removeAttachment(attachment.id)}
                  >
                    <CrossIcon />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
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
            className="composer-input"
            value={draft}
            placeholder={
              state.restoring
                ? 'Restoring conversation...'
                : pending
                  ? 'Waiting for your decision above...'
                  : active?.status === 'available'
                    ? 'Ask the agent...'
                    : 'No backend available'
            }
            disabled={active?.status !== 'available' || state.restoring || Boolean(pending)}
            rows={1}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={onComposerPaste}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-row">
            <button
              className="icon-btn"
              type="button"
              aria-label="Attach files"
              disabled={active?.status !== 'available' || state.restoring || Boolean(pending)}
              onClick={openFilePicker}
            >
              <PaperclipIcon />
            </button>
            {modeSnapshot ? (
              <div className="mode-menu">
                <ModeTrigger
                  snapshot={modeSnapshot}
                  open={modePanelOpen}
                  disabled={Boolean(pending) || state.busy}
                  onToggle={() => {
                    setModePanelOpen((value) => !value);
                    setPermissionPanelOpen(false);
                    setModelPanelOpen(false);
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
              <PermissionTrigger
                options={permissionOptions}
                selected={state.permissionLevel}
                open={permissionPanelOpen}
                disabled={Boolean(pending)}
                onToggle={() => {
                  setPermissionPanelOpen((value) => !value);
                  setModePanelOpen(false);
                  setModelPanelOpen(false);
                  setModelSettingsOpen(false);
                }}
              />
            ) : null}
            {state.selectedBackendId && state.selectedModel ? (
              <button
                className="control-trigger"
                type="button"
                aria-haspopup="dialog"
                aria-expanded={modelSettingsOpen}
                aria-controls="model-settings-panel"
                aria-label="Model settings"
                disabled={Boolean(pending)}
                onClick={() => {
                  setModelSettingsOpen((value) => !value);
                  setModePanelOpen(false);
                  setPermissionPanelOpen(false);
                  setModelPanelOpen(false);
                }}
              >
                <SlidersIcon className="ico ico--sm" />
                <span className="control-label">Settings</span>
                <ChevronDownIcon className="control-chevron" />
              </button>
            ) : null}
            <span className="spacer" />
            {state.busy ? (
              <>
                {active?.id === 'codex' ? (
                  <button className="btn btn--primary" type="button" disabled={!canSend} onClick={send}>
                    Steer
                    <ArrowIcon />
                  </button>
                ) : null}
                <span className="busy-indicator" role="status" aria-label="Agent is busy"><span className="spinner" /></span>
                <button className="btn btn--secondary" type="button" onClick={cancel}>
                  <StopIcon />
                  Stop
                </button>
              </>
            ) : (
              <button className="btn btn--primary" type="button" disabled={!canSend} onClick={send}>
                Send
                <ArrowIcon />
              </button>
            )}
          </div>
        </div>
        <span className="composer-hint">Enter to send, Shift+Enter for a new line</span>
      </footer>
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

  // Move focus into the panel on open so arrow keys and typing land here, and
  // return focus to the trigger when it closes.
  useEffect(() => {
    const target =
      filterRef.current ??
      listRef.current?.querySelector<HTMLButtonElement>('.model-option') ??
      document.querySelector<HTMLButtonElement>('#model-panel .btn');
    target?.focus();
    return () => {
      document.querySelector<HTMLButtonElement>('.model-trigger')?.focus();
    };
  }, []);

  const groups = providers.map((backend) => {
    const list = models[backend.id];
    const matches = (list ?? []).filter(
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
  // every provider vertically. The selection falls back to the first provider
  // whenever the current one drops out (a refresh can remove a provider).
  const [activeProvider, setActiveProvider] = useState(providers[0]?.id ?? '');
  const activeGroup = groups.find((group) => group.backend.id === activeProvider) ?? groups[0];
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
    dispatch({ type: 'selectBackend', backendId });
    dispatch({ type: 'selectModel', model });
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
                : 'Set an Ollama Cloud token, or install the Codex CLI and sign in.'}
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
                          <button className="btn" type="button" onClick={() => bridge.post({ type: 'openSettings' })}>
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
          active={activeGroup?.backend.id ?? ''}
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
                      <span className="model-option-name">{model.label}</span>
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

      <div className="model-panel__foot">
        <InfoIcon />
        <span>Switching applies to your next message. This conversation is kept.</span>
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

function HistoryPanel({
  threads,
  loading,
  activeThreadId,
  backendId,
  threadActivity,
  onSelect
}: {
  threads: ThreadSummary[];
  loading: boolean;
  activeThreadId?: string;
  backendId: string;
  threadActivity: AppState['threadActivity'];
  onSelect: (threadId: string) => void;
}): JSX.Element {
  return (
    <div className="model-panel" id="history-panel">
      <div className="model-panel__head">Recent conversations</div>
      {loading ? (
        <div className="history-loading" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          Loading conversations...
        </div>
      ) : threads.length === 0 ? (
        <ul className="model-list">
          <li className="model-option model-option--empty">No earlier conversations yet.</li>
        </ul>
      ) : (
        <ul className="model-list" role="listbox" aria-label="Conversations">
          {threads.map((thread) => {
            const selected = thread.threadId === activeThreadId;
            const activity = threadActivity?.[`${backendId}:${thread.threadId}`];
            return (
              <li
                className="model-option"
                role="option"
                aria-selected={selected}
                key={thread.threadId}
                tabIndex={0}
                onClick={() => onSelect(thread.threadId)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(thread.threadId);
                  }
                }}
              >
                <span className="thread-title">{thread.title ?? 'Untitled conversation'}</span>
                <span className="history-status-slot">
                  {activity?.busy ? <span className="history-status" role="status">Busy</span> : null}
                </span>
                <span className="history-status-slot">
                  {activity?.unread ? <span className="history-status history-status--unread">Unread</span> : null}
                </span>
                <span className="history-model-slot">{thread.model ?? ''}</span>
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
            <button className="btn" type="button" onClick={() => bridge.post({ type: 'openSettings' })}>
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
      <p className="empty-title empty-title--brand">meLink SideCode</p>
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

function NoticeBanner({
  notice,
  onAction
}: {
  notice: NonNullable<AppState['notice']>;
  onAction: (action: 'setToken' | 'clearToken' | 'refresh') => void;
}): JSX.Element {
  const level = notice.level === 'error' ? 'error' : 'interrupted';
  const title =
    notice.level === 'error'
      ? 'Something went wrong'
      : notice.level === 'warning'
        ? 'Needs attention'
        : 'Response stopped';
  return (
    <div className={`banner banner--${level}`} role={notice.level === 'error' ? 'alert' : 'status'}>
      <span className="banner-icon" aria-hidden="true">
        <AlertIcon />
      </span>
      <div>
        <p className="banner-title">{title}</p>
        <p className="banner-text">{notice.message}</p>
        {notice.action ? (
          <div className="banner-actions">
            <button className="btn btn--primary" type="button" onClick={() => onAction(notice.action ?? 'refresh')}>
              {notice.action === 'setToken' ? 'Set token' : notice.action === 'clearToken' ? 'Clear token' : 'Retry'}
            </button>
            <button className="btn btn--quiet" type="button" onClick={() => onAction('refresh')}>
              Refresh backends
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
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

function TranscriptRow({
  item,
  providerId,
  pendingId,
  checkpoint,
  onDecide,
  onOpenRules,
  onRestore
}: {
  item: TranscriptItemView;
  providerId: string;
  pendingId?: string;
  /** The checkpoint this message opened, when its turn touched files. */
  checkpoint?: CheckpointView;
  onDecide: (decision: ApprovalDecision) => void;
  onOpenRules: () => void;
  onRestore: (messageId: string, fileCount: number, paths: string[]) => void;
}): JSX.Element | null {
  if (item.kind === 'message' && item.role === 'user') {
    return (
      <article className="turn turn--user">
        <div className="turn-meta">
          <span className="meta-strong">You</span>
          {checkpoint ? (
            <button
              type="button"
              className="checkpoint-restore"
              title={`Restore ${checkpoint.fileCount} file${checkpoint.fileCount === 1 ? '' : 's'} to before this message. Files only; this message and the rest of the conversation stay.`}
              onClick={() => onRestore(checkpoint.messageId, checkpoint.fileCount, checkpoint.paths)}
            >
              <RestoreIcon />
              <span>Restore checkpoint</span>
            </button>
          ) : null}
        </div>
        <div className="turn-body">
          {item.attachments && item.attachments.length > 0 ? (
            <ul className="attachments attachments--sent" aria-label="Attachments">
              {item.attachments.map((attachment) => (
                <li className="attachment" key={attachment.id}>
                  <span className="attachment-icon" aria-hidden="true">
                    <PaperclipIcon />
                  </span>
                  <span className="attachment-name" title={attachment.name}>
                    {attachment.name}
                  </span>
                  {typeof attachment.size === 'number' ? (
                    <span className="attachment-size">{formatBytes(attachment.size)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {item.text ? <p>{item.text}</p> : null}
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
    return (
      <article className="turn turn--reasoning" aria-live="polite">
        <div className="turn-meta">
          <span className="meta-strong">{item.title || 'Thinking'}</span>
          {item.status === 'streaming' ? (
            <span className="stream-status" role="status">
              <span className="spinner" aria-hidden="true" />
              Thinking
            </span>
          ) : null}
        </div>
        <div className="turn-body md">
          {item.text.trim() ? (
            <Markdown text={item.text} />
          ) : item.status === 'streaming' ? (
            <p className="reasoning-pending">Waiting for a reasoning summary…</p>
          ) : item.status === 'failed' || item.status === 'canceled' || item.status === 'warning' ? null : (
            <p className="reasoning-pending">No reasoning summary was provided for this step.</p>
          )}
          {item.status === 'streaming' ? <span className="caret" aria-hidden="true" /> : null}
          {item.status === 'failed' || item.status === 'canceled' || item.status === 'warning' ? (
            <p className="reasoning-incomplete" role="status">
              Thinking stopped early; this section may be incomplete.
            </p>
          ) : null}
        </div>
      </article>
    );
  }

  // Assistant message: markdown output with a streaming caret.
  return (
    <article className="turn turn--agent" aria-live="polite">
      <div className="turn-meta">
        <span className={`provider-dot provider-dot--${providerId}`} aria-hidden="true" />
        <span className="meta-strong">Agent</span>
        {item.title ? (
          <>
            <span className="meta-sep" aria-hidden="true">
              -
            </span>
            <span>{item.title}</span>
          </>
        ) : null}
        {item.status === 'streaming' ? (
          <span className="stream-status" role="status">
            <span className="spinner" aria-hidden="true" />
            Generating
          </span>
        ) : item.status === 'canceled' ? (
          <span className="stream-status stream-status--warning">
            <StopIcon />
            Stopped
          </span>
        ) : null}
      </div>
      <div className="turn-body md">
        <Markdown
          text={item.text}
          renderCodeHeader={(_language, code) => (
            <button className="icon-btn" type="button" aria-label="Copy code" onClick={() => copyText(code)}>
              <CopyIcon />
            </button>
          )}
        />
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
        <span className="item-main">
          <span className="item-kind">{presentation.title}</span>
          {presentation.detail ? (
            <span className="item-path" title={presentation.detail}>
              {presentation.detail}
            </span>
          ) : null}
        </span>
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
                <span className="file-name" title={file.path}>
                  {file.path}
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
                <span className="file-name" title={path}>
                  {path}
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
    <div className="item-card" aria-label="File change item">
      <div className="item-head">
        <span className="item-icon" aria-hidden="true">
          <FileIcon />
        </span>
        <span className="item-main">
          <span className="item-kind">{title}</span>
          <span className="item-path" title={filePathLabel(files)}>
            {filePathLabel(files)}
          </span>
        </span>
        {totals(files) ? (
          <span className="diff-stats" aria-label={diffStatsLabel(files)}>
            {totals(files)?.additions ? <span className="add">+{totals(files)?.additions}</span> : null}
            {totals(files)?.deletions ? <span className="del">-{totals(files)?.deletions}</span> : null}
          </span>
        ) : null}
        <StatusChip status={item.status} doneLabel="Applied" />
      </div>
      {diffs.length > 0 ? (
        <div className="diff-body" role="figure" aria-label={`Diff for ${diffs.length} changed ${diffs.length === 1 ? 'file' : 'files'}`}>
          {diffs.map((file) => (
            <section className="diff-file" key={file.path}>
              {diffs.length > 1 ? <div className="diff-file__path">{file.path}</div> : null}
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
    </div>
  );
}

function StatusChip({ status, doneLabel = 'Passed' }: { status: ItemStatus; doneLabel?: string }): JSX.Element | null {
  switch (status) {
    case 'streaming':
      return (
        <span className="status-chip status-chip--running">
          <span className="spinner" aria-hidden="true" />
          Running
        </span>
      );
    case 'completed':
      return (
        <span className="status-chip status-chip--done">
          <CheckIcon />
          {doneLabel}
        </span>
      );
    case 'failed':
      return (
        <span className="status-chip status-chip--failed">
          <CrossIcon />
          Failed
        </span>
      );
    case 'warning':
      return (
        <span className="status-chip status-chip--warning">
          <AlertIcon />
          Check
        </span>
      );
    case 'canceled':
      return (
        <span className="status-chip">
          <StopIcon />
          Stopped
        </span>
      );
    default:
      return null;
  }
}

/** A short, honest label for what a settled approval concerned. */
function describeApprovalSubject(request: ApprovalRequest): string {
  switch (request.kind) {
    case 'command':
      return request.command ?? 'a command';
    case 'file-change': {
      const paths = request.paths ?? [];
      if (paths.length === 0) {
        return 'file changes';
      }
      if (paths.length === 1) {
        return paths[0];
      }
      return `${paths[0]} +${paths.length - 1} more`;
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
    return files[0].path;
  }
  return `${files[0].path} +${files.length - 1} more`;
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
 * The compact permission level trigger that sits with the model and mode in the
 * composer. Collapsed it shows the current level; the options open in a
 * floating panel above the composer.
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
      disabled={disabled}
      onClick={onToggle}
    >
      <ShieldIcon className="ico ico--sm" />
      <span className="control-label">{current?.label ?? selected}</span>
      <ChevronDownIcon className="control-chevron" />
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
 * The confirmation before a checkpoint restore. Destructive and never implicit:
 * it names the affected file count and every path first. The copy is explicit
 * that files are reverted only; the message and the rest of the conversation are
 * left untouched.
 */
function RestoreConfirmation({
  fileCount,
  paths,
  onConfirm,
  onCancel
}: {
  fileCount: number;
  paths: string[];
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const shown = paths.slice(0, 8);
  const remaining = paths.length - shown.length;
  return (
    <div className="confirm-gate" role="alertdialog" aria-label="Confirm checkpoint restore">
      <div className="confirm-gate__head">
        <span className="confirm-gate__icon" aria-hidden="true">
          <RestoreIcon />
        </span>
        <div>
          <p className="confirm-gate__title">
            Restore {fileCount} file{fileCount === 1 ? '' : 's'} to before this message?
          </p>
          <p className="confirm-gate__text">
            The files below return to their checkpoint content. This message and the rest of the
            conversation are not removed. You can undo the restore afterwards.
          </p>
          {shown.length > 0 ? (
            <ul className="confirm-gate__paths">
              {shown.map((path) => (
                <li key={path}>{path}</li>
              ))}
              {remaining > 0 ? <li>and {remaining} more</li> : null}
            </ul>
          ) : null}
        </div>
      </div>
      <div className="confirm-gate__actions">
        <button className="btn" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn--danger" type="button" onClick={onConfirm}>
          Restore files
        </button>
      </div>
    </div>
  );
}
