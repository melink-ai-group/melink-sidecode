/**
 * The single seam every backend plugs into.
 *
 * Nothing in this module may import `vscode` or any provider SDK: the sidebar
 * UI depends on these types and on nothing else. A provider's wire protocol is
 * an implementation detail that is normalized into the event union below.
 */

import type { QuestionAnswer, QuestionRequest } from '../questions.ts';
import type { FrontendStack } from '../context/frontendStack.ts';

export type { ClarifyingQuestion, QuestionAnswer, QuestionRequest } from '../questions.ts';

/** Structural stand-in for `vscode.Disposable`, so this module stays host-free. */
export interface Disposable {
  dispose(): void | Promise<void>;
}

/**
 * Per-backend availability, as read by the UI.
 *
 * - `available` — usable now.
 * - `unauthenticated` — runs, but has no usable credential.
 * - `unavailable` — cannot run at all (the binary is missing); hidden entirely.
 * - `incompatible` — runs, but reports a protocol version outside the pinned
 *   range (or timed out on the handshake). Distinct from `unavailable` so a
 *   version drift is diagnosable rather than a silent dead backend.
 * - `auth-mismatch` — runs and has a credential, but it is an API key rather
 *   than the ChatGPT login the user chose. Distinct so the mismatch is named
 *   instead of being reported as a healthy `available`.
 */
export type BackendStatus = 'available' | 'unauthenticated' | 'unavailable' | 'incompatible' | 'auth-mismatch';

export interface BackendAvailability {
  id: string;
  label: string;
  badge: string;
  status: BackendStatus;
  /** Human-readable reason, usually the message of a caught failure. */
  detail?: string;
  /**
   * The server-reported version, carried only for `incompatible`. Lets the UI
   * name exactly which CLI version it saw instead of a generic failure.
   */
  version?: string;
  /**
   * The auth method a backend reported from its own status call (for example
   * Codex's `chatgpt` or `apikey`), when it reports one. Provider-neutral: the
   * UI renders it as text and never branches on the provider's enum.
   */
  authMode?: string;
}

/**
 * A backend's own auth report, richer than the boolean `isAuthenticated()`.
 * A backend that can name the active auth mode or flag a mismatch returns this;
 * one that cannot keeps using the boolean fallback.
 */
export interface AuthStatusReport {
  /** True when the backend has a usable credential. */
  authenticated: boolean;
  /** Overrides the default `available`/`unauthenticated` mapping when set. */
  status?: BackendStatus;
  /** Plain-language sentence; never a raw stack or a credential. */
  detail?: string;
  /** The reported auth method, so a mismatch can name what was in use. */
  authMode?: string;
}

/**
 * A value that may be genuinely unknowable. `unknown` is deliberately distinct
 * from a concrete `false`/empty value: a control backed by `unknown` is hidden,
 * whereas one backed by a reported value is shown. Never coalesce the two.
 */
export type CapabilityState<T> = T | 'unknown';

/**
 * Token sizes a model will accept. Every field is independently reportable; a
 * missing maximum is `unknown`, never a fabricated number.
 */
export interface ContextWindowCapability {
  min: CapabilityState<number>;
  max: CapabilityState<number>;
  /** The provider's own default when one is reported. */
  default: CapabilityState<number>;
}

/**
 * The fixed UI vocabulary for a reasoning/thinking control. These are the only
 * levels any surface may name; each adapter maps them to its native values.
 */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'extra high';

/** Every thinking level, in presentation order. The single source of truth. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'extra high'];

/**
 * What a model can do, in the provider-neutral vocabulary the UI renders.
 *
 * This is descriptor-only: it names no provider field. Adapters translate their
 * own wire data into this shape, and the UI never sees the provider's types.
 */
export interface ModelCapabilities {
  contextWindow: ContextWindowCapability;
  /**
   * Supported thinking levels in the UI vocabulary, and the model's default
   * level. Both `unknown` when the provider did not report reasoning support;
   * an empty list means the model is known not to reason.
   */
  thinking: {
    supported: CapabilityState<ThinkingLevel[]>;
    default: CapabilityState<ThinkingLevel>;
  };
  /** Whether the model can drive tool/command execution at all. */
  tools: CapabilityState<boolean>;
  /**
   * Collaboration modes meaningful for this model, in presentation order.
   * `unknown` when the provider reports no per-model mode data (the backend's
   * own `modes` list still governs which modes can be offered).
   */
  modes: CapabilityState<DefaultMode[]>;
}

/** Provider-neutral model descriptor. */
export interface BackendModel {
  id: string;
  label: string;
  description?: string;
  /**
   * True when the provider reports this model as zero-cost (for example OpenCode
   * Zen free models). Absent means the provider does not classify pricing.
   */
  free?: boolean;
  /**
   * What this specific model can do, populated from the provider. Absent means
   * the provider does not describe capabilities for this model, which the UI
   * treats as all-`unknown` rather than a plausible-but-wrong default.
   */
  capabilities?: ModelCapabilities;
}

/**
 * A user's persisted choice for one provider+model. Every field is optional;
 * an absent field means "use the provider default, then the app default".
 */
export interface ModelSettingOverrides {
  /** Requested context window (`num_ctx` for Ollama). */
  contextWindow?: number;
  /** Requested thinking level, in the UI vocabulary. */
  thinking?: ThinkingLevel;
}

/**
 * One overridable field, named once so a per-control reset can target exactly
 * one field without a second vocabulary. The UI's reset affordance and the
 * store's partial clear use these same keys.
 */
export type ModelSettingField = 'contextWindow' | 'thinking';

/**
 * The resolved, effective settings for one provider+model, after applying the
 * override > provider default > app default precedence.
 */
export interface ResolvedModelSettings {
  providerId: string;
  modelId: string;
  contextWindow: CapabilityState<number>;
  thinking: CapabilityState<ThinkingLevel>;
  /** True when at least one field was satisfied by a stored override. */
  isOverridden: boolean;
  /** Per-field override flags, so a reset affordance can be per-control. */
  overridden: { contextWindow: boolean; thinking: boolean };
}

export interface ThreadHandle {
  backendId: string;
  threadId: string;
  /** Model the thread is pinned to, when known. */
  model?: string;
  /**
   * True when this backend consumed the session snapshot as part of
   * `startThread`/`resumeThread` (a native instructions field). The host then
   * sends only a delta on the first turn rather than re-sending the snapshot;
   * false means the snapshot must be delivered on the first turn.
   */
  contextPrimed?: boolean;
}

/**
 * Project context handed to a backend for one thread, already rendered to text
 * by the shared `src/context/render.ts`.
 *
 * The host builds this; an adapter only forwards it in whatever native shape
 * its provider accepts. It is provider-neutral and text-only, so no provider
 * concept leaks into the UI and every adapter shares one wording and one budget.
 *
 * - `snapshot` is sent at session start (new or resumed).
 * - `delta` is sent on later turns only, and is never persisted as transcript
 *   content.
 * - `notice` is a plain-language line used when a snapshot could not be built,
 *   so a failure degrades instead of blocking the turn.
 */
export interface ContextPayload {
  /** The full rendered snapshot block, when one was built. */
  snapshot?: string;
  /** A rendered delta block for this turn, when the workspace changed. */
  delta?: string;
  /**
   * The bounded per-turn symbol/import map, or a one-line marker when the map
   * is off, unavailable, failed or over budget. Never provider-specific.
   */
  repoMap?: string;
  /**
   * The file the user is viewing, recomputed every turn. Present even when they
   * have not attached it, as a short notice, so a stale session prefix cannot
   * name a different file.
   */
  attachedFile?: string;
  /** A plain-language notice when context is unavailable. */
  notice?: string;
  /**
   * True when this turn opens a session (new or resumed), so an adapter that
   * primes once may send the snapshot. False means delta-only.
   */
  priming?: boolean;
  /**
   * The primary workspace root the snapshot was built for, so an adapter that
   * spawns a child process uses the snapshot service's own root rather than
   * re-reading `workspaceFolders` (a second source of truth). Absent when no
   * folder is open, in which case an adapter falls back to its own default.
   */
  workspaceRoot?: string;
  /**
   * The frontend stack detected from the raw snapshot, so acting modes can add
   * the matching checklist. `none` is a real answer for a non-frontend project;
   * absent means no snapshot was available at all.
   */
  frontendStack?: FrontendStack;
}

export interface StartThreadOptions {
  /** Internal delegated worker; never a sidebar conversation or persisted chat. */
  internalSubagent?: boolean;
  model?: string;
  /** Permission policy the thread runs under; falls back to the backend default. */
  permissionLevel?: PermissionLevel;
  /** Starting mode; falls back to the stored `melink.defaults.mode`. */
  mode?: DefaultMode;
  /**
   * Effective per-model settings for this thread, already resolved and clamped
   * by the host. An adapter maps them onto its native values; an absent field
   * means "leave the provider default alone".
   */
  modelSettings?: ModelSettingOverrides;
  /**
   * Rendered project context for the new session. An adapter that can prime at
   * start time (a native instructions field) consumes it here; an adapter that
   * can only prime per turn receives it on `SendTurnRequest.context` instead.
   */
  context?: ContextPayload;
  /**
   * Compacted summary of the chat this thread continues. An adapter that stores
   * instructions on the thread includes it once at start. The host also seeds
   * the stored transcript, which is what a stateless adapter sends.
   */
  handover?: string;
}

export interface SendTurnRequest {
  /** The user turn text. */
  text: string;
  /**
   * Files the user attached to this turn. Metadata plus, for clipboard images,
   * inline bytes; the adapter decides how to present them to its provider.
   */
  attachments?: Attachment[];
  /** Model override for this turn; falls back to the backend default. */
  model?: string;
  /**
   * Permission policy override for this turn and subsequent turns. The host
   * supplies the current selection, so a level change applies to the next turn.
   */
  permissionLevel?: PermissionLevel;
  /**
   * Mode the turn runs in. The host supplies the current selection, so a mode
   * change applies to the next turn. A mode that forces a read-only sandbox
   * overrides `permissionLevel` for the turn (see `modeForcesReadOnly`); the
   * mode is never allowed to widen permissions.
   */
  mode?: DefaultMode;
  /**
   * Effective per-model settings for this turn, already resolved and clamped by
   * the host. The adapter maps them onto its native request fields; an absent
   * field means the provider default applies.
   */
  modelSettings?: ModelSettingOverrides;
  /**
   * Rendered project context for this turn. The snapshot is present when this
   * turn opens a session (new or resumed); afterwards only a compact delta is
   * present. Sent as system-role/provider input only and never persisted as
   * transcript user content.
   */
  context?: ContextPayload;
}

/**
 * Options for reconnecting to a thread. Context is supplied again because the
 * upstream provider may have lost its own context across a resume, so a resumed
 * thread is re-primed rather than assumed primed.
 */
export interface ResumeThreadOptions {
  /**
   * Rendered project context for the resumed session. An adapter that primes at
   * start time (a native instructions field) consumes it here; an adapter that
   * can only prime per turn receives it on `SendTurnRequest.context` instead.
   */
  context?: ContextPayload;
  /**
   * Compacted summary this thread was started with. A resume replaces the
   * thread's instructions, so the summary has to be sent again or the model
   * loses the chat it continued.
   */
  handover?: string;
}

/** Role of a transcript message item. */
export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * Kinds of transcript item the renderer understands today.
 *
 * The three approval kinds carry the app-server's request-approval server
 * requests (`item/commandExecution/requestApproval`, `item/fileChange/...`) and
 * the decision made on one. They are distinct kinds so the transcript has one
 * provider-agnostic path for a pending request, a decided request and a denial,
 * and the renderer never branches on the provider.
 *
 * `tool` and `file-change` are the item-card kinds the Codex app-server's
 * `item/*` notifications normalize into; Ollama Cloud can emit them too, so the
 * renderer has exactly one card path and never branches on the provider.
 */
export type TranscriptItemKind =
  | 'message'
  | 'reasoning'
  | 'tool'
  | 'file-change'
  | 'notice'
  | 'approval-requested'
  | 'approval-decided'
  | 'approval-denied';

/** What a pending approval concerns. Neutral across providers. */
export type ApprovalRequestKind = 'command' | 'file-change' | 'permissions';

/**
 * An approval the app-server is waiting on. Carried by `approval-requested`
 * items so the renderer can present a decision card; the turn stays blocked on
 * the backend until `decideApproval` answers the request.
 */
export interface ApprovalRequest {
  /** Stable id for this pending decision, used by the decision round trip. */
  id: string;
  kind: ApprovalRequestKind;
  /**
   * Provider method the request arrived as, e.g.
   * `item/commandExecution/requestApproval`. Carried for honesty; the renderer
   * never branches on it.
   */
  method: string;
  /** Command the request concerns, when reported. */
  command?: string;
  /**
   * Redacted, bounded command safe to show in cards and notices. The raw
   * `command` stays untouched for rule matching.
   */
  displayCommand?: string;
  /** Working directory the command runs in, when reported. */
  cwd?: string;
  /** File paths the request concerns, when reported. */
  paths?: string[];
  /** Free-form reason shown next to the decision. */
  reason?: string;
  /** Host or network scope the request concerns, when reported. */
  network?: string;
  /**
   * Native proposed exec-policy amendment, when the backend offered one. Stored
   * on an `always` rule so the same native shape the CLI proposed is referenced.
   */
  execPolicyAmendment?: string[];
  /** Root the backend asks to grant write access under, when reported. */
  grantRoot?: string;
  /** Where the request originated (workspace root or cwd). */
  origin?: string;
}

/** A single line of a file-change diff, normalized for rendering. */
export interface FileChangeLine {
  kind: 'add' | 'del' | 'context';
  text: string;
}

/** How a file changed across a turn. Mirrors the journal's own vocabulary. */
export type ChangeStatus = 'created' | 'modified' | 'deleted' | 'renamed';

/**
 * How a turn's file change was learned, so a review surface can be honest about
 * it.
 *
 * - `reported` — the backend told us in a structured edit event.
 * - `watched`  — only the filesystem watcher saw it (a formatter, `git apply`,
 *                codegen invoked through the shell, or anything else that never
 *                emits an edit event).
 */
export type ChangeSource = 'reported' | 'watched';

/**
 * One file touch recorded for a turn, in the one shape every backend maps to.
 *
 * `absPath` is the host's absolute path and is what the journal snapshots and
 * diffs. `path` is the workspace-relative, POSIX-separated path a review surface
 * renders; the host recomputes it from the workspace roots so it is correct even
 * when an adapter could only supply an absolute path. `status` and `source` are
 * the recorded facts, never an inferred default.
 */
export interface ChangeEntry {
  /** Absolute path of the file after the change, or before for a delete. */
  absPath: string;
  /** Workspace-relative, POSIX-separated path for display. */
  path: string;
  status: ChangeStatus;
  source: ChangeSource;
  /** For a rename, the pre-turn workspace-relative path. */
  renamedFrom?: string;
}

/**
 * A change a backend reports mid-turn, before the host snapshot-diffs it.
 *
 * Adapters know the absolute path (Codex's apply-patch keys, opencode's tool
 * `filepath`); the host resolves the workspace-relative form and does the
 * before/after diff, so a reported entry is never trusted as a final record on
 * its own.
 */
export interface ReportedChange {
  /** Absolute path the adapter observed. */
  absPath: string;
  status: ChangeStatus;
  /**
   * Unified diff of this edit, when the backend sent one. The journal uses it
   * to recover the pre-edit file when it has no pre-turn snapshot, so a
   * one-line edit is not reviewed as a whole-file addition.
   */
  diff?: string;
  /**
   * The exact text an edit tool replaced, when it reported both sides. Used the
   * same way as `diff`: recover the pre-edit file instead of diffing against
   * empty content.
   */
  replacement?: { before: string; after: string };
  /**
   * Full pre-edit and post-edit file text, when the tool reported both. Trusted
   * only when the post-edit text still matches the file on disk.
   */
  beforeText?: string;
  afterText?: string;
}

/** One changed file attached to a `file-change` item. */
export interface FileChange {
  path: string;
  additions?: number;
  deletions?: number;
  /** Optional pre-normalized diff body; the renderer only paints it. */
  lines?: FileChangeLine[];
}

/** Broad class of an attachment, so a chip can pick an icon without a mime parse. */
export type AttachmentKind = 'image' | 'audio' | 'text' | 'file';

/**
 * A file carried on an outgoing user message.
 *
 * A picked file names its absolute `path`. An image also carries a `dataUrl`
 * so the webview can show a thumbnail and open a viewer. A clipboard image
 * carries its bytes the same way and has no path. Those bytes stay in the
 * webview and are stripped before the attachment is persisted, so no file
 * content is ever written to workspace state.
 */
export interface Attachment {
  id: string;
  /** Basename, always safe to show in the UI. */
  name: string;
  /** Absolute path for a host-picked file; absent for clipboard content. */
  path?: string;
  mimeType: string;
  /** Byte size when the host could read it. */
  size?: number;
  /** Inline image bytes (data URL) for clipboard content only. */
  dataUrl?: string;
  kind: AttachmentKind;
}

/** Compact, persisted lifecycle of a host-managed subagent or orchestration check. */
export interface AgentActivity {
  role: string;
  reason: string;
  /**
   * `unavailable` marks an advisory pass that could not run (provider failure,
   * deadline, or an unusable reply). It is not a failed assessment: the review
   * simply produced no evidence, so it must not read as a failure.
   */
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unavailable';
  detail?: string;
  findings?: string[];
}

export interface TranscriptItem {
  id: string;
  kind: TranscriptItemKind;
  /** Persisted status notice severity and optional recovery control. */
  noticeLevel?: 'info' | 'warning' | 'error';
  /** Present on a notice representing one subagent or host check. */
  agentActivity?: AgentActivity;
  /** Present when `kind` is `message`. */
  role?: MessageRole;
  /** Short label, e.g. a tool name or a model name. */
  title?: string;
  /**
   * Tool id when the backend reported one (`read`, `grep`, `bash`).
   * Grouping prefers this over the display title.
   */
  tool?: string;
  /** Free-form provider-neutral detail line. */
  detail?: string;
  /** `tool` items: the command or invocation that ran. */
  command?: string;
  /** `file-change` items: one entry per changed file. */
  files?: FileChange[];
  /** `approval-requested` items: the pending approval request, when known. */
  approval?: ApprovalRequest;
  /**
   * `approval-decided`/`approval-denied` items: how the request was answered.
   * Persisted so a reload shows the same scope the decision applied at.
   */
  approvalDecision?: ApprovalDecision;
  /**
   * `message` items: files the user attached to the turn. Metadata only; any
   * inline image bytes are dropped before persistence.
   */
  attachments?: Attachment[];
  /**
   * True when this user line is a host-built instruction (plan build or
   * continuation, crash resume, question retry), not text the user typed. It
   * stays a user row so turn anchoring and change cards keep working, but the
   * transcript never renders it.
   */
  orchestration?: boolean;
  /**
   * Full text of a message item. Live turns stream their text through
   * `item/delta`, so this is only populated for replayed history; the renderer
   * treats an absent value as an empty message.
   */
  text?: string;
  /**
   * Epoch milliseconds when the user message that opened a turn was stored.
   * The turn's elapsed line is measured from here.
   */
  sentAt?: number;
  /**
   * Milliseconds from `sentAt` until the turn finished. Set once, on the user
   * message that opened the turn.
   */
  workedMs?: number;
  /**
   * Lifecycle status, populated when a thread is replayed after a reload.
   * `pending` is carried by an unresolved `approval-requested` item so a
   * reload can repaint exactly one decision card and never a settled one.
   */
  status?: 'pending' | 'completed' | 'failed';
}

/** Provider-neutral row for a thread list, whatever store it comes from. */
export interface ThreadSummary {
  threadId: string;
  /** First-user-turn excerpt or provider-assigned name. */
  title?: string;
  model?: string;
  /** Epoch milliseconds of the last observed activity. */
  updatedAt?: number;
}

/**
 * Outcome of an on-demand authenticated call, provider-neutral so the settings
 * screen can name the failure precisely (wrong key vs bad host vs network)
 * without parsing provider text or showing a raw stack.
 */
export type ConnectionTestOutcome = 'ok' | 'invalid-key' | 'host' | 'network' | 'provider' | 'unavailable';

export interface ConnectionTestResult {
  backendId: string;
  outcome: ConnectionTestOutcome;
  /** Plain-language sentence for the result strip. Never contains the token. */
  message: string;
}

/**
 * Permission level, defined once and mapped per backend into that backend's own
 * native vocabulary.
 *
 * The sandbox is enforced by the provider outside the model; the approval policy
 * only governs *when the user is asked*. These are separate axes and this type
 * never conflates them: `read-only` and `default` both keep a sandbox, while
 * `unrestricted` removes the prompt entirely and is why selecting it needs the
 * explicit, labelled confirmation.
 */
export type PermissionLevel = 'read-only' | 'default' | 'unrestricted';

/** A level that widens permissions, so selecting it must be confirmed. */
export const DANGEROUS_PERMISSION_LEVEL: PermissionLevel = 'unrestricted';

/** Levels every backend that has an approval channel can serve. */
export const PERMISSION_LEVELS: readonly PermissionLevel[] = ['read-only', 'default', 'unrestricted'];

/**
 * The three modes, defined once for every backend and every surface.
 *
 * - `agent` — the agent acts on the workspace.
 * - `plan`  — the agent produces a plan and may not change the workspace until
 *             the user builds it.
 * - `ask`   — the agent answers questions and never acts.
 *
 * A backend that cannot honour a mode must not advertise it (see
 * `AgentBackend.modes`), so the UI can hide it rather than show a mode that
 * silently behaves like `agent`.
 */
export type DefaultMode = 'agent' | 'plan' | 'ask';

/** Every mode, in presentation order. The single source of truth. */
export const DEFAULT_MODES: readonly DefaultMode[] = ['agent', 'plan', 'ask'];

/**
 * Lifecycle of one step of a plan's bullet list. The three native states mirror
 * the generated `TurnPlanStepStatus` so a native `turn/plan/updated`
 * notification maps across without inventing a second vocabulary. `denied` is an
 * app-level terminal state: a step whose approval the user refused (or a mode
 * enforcement refused) never ran, and must not read as pending or as done.
 */
export type TodoStepStatus = 'pending' | 'inProgress' | 'completed' | 'denied';

/**
 * Resolve any step left `inProgress` when a turn ends. A turn that finishes,
 * is interrupted, fails, or is cancelled can leave the last step `inProgress`
 * because the provider's own plan update only ever marked it running. Returning
 * it to `pending` keeps the persisted list honest: no step stays "running" while
 * nothing is running, so a reload shows partial progress rather than a spinner
 * that never stops. Terminated steps (`completed`, `denied`) are left alone.
 */
export function settleInProgressSteps(steps: readonly TodoStep[]): TodoStep[] {
  let changed = false;
  const next = steps.map((step) => {
    if (step.status === 'inProgress') {
      changed = true;
      return { ...step, status: 'pending' as const };
    }
    return step;
  });
  return changed ? next : [...steps];
}

/**
 * Mark the first `inProgress` step as denied, preserving every other step. Used
 * when an approval for a step is refused: the step never ran, so it is recorded
 * as denied rather than left running or silently dropped. Returns the original
 * array when there is no `inProgress` step to mark.
 */
export function denyInProgressStep(steps: readonly TodoStep[]): TodoStep[] {
  const index = steps.findIndex((step) => step.status === 'inProgress');
  if (index === -1) {
    return [...steps];
  }
  return steps.map((step, i) => (i === index ? { ...step, status: 'denied' as const } : step));
}

/** One step of a plan, tracked per thread and persisted across a reload. */
export interface TodoStep {
  text: string;
  status: TodoStepStatus;
}

/**
 * A plan written to the workspace for one thread. The path is the friendly
 * file name from the plan title. Once chosen, a revision updates that same
 * file rather than creating a second plan.
 */
export interface PlanArtifact {
  /** Workspace-relative path the plan markdown was written to. */
  path: string;
  title: string;
  /**
   * The plan's "what it will do" paragraph, when one was written. Used for the
   * collapsed reference; absent for a plan with no summary.
   */
  summary?: string;
  /**
   * The plan document between the title and the `## Steps` list. The review
   * card renders this, then the todo list. Absent when the plan is only a list.
   */
  body?: string;
  steps: TodoStep[];
  /**
   * True once the plan has been built (the thread moved to execution). Drives
   * the collapsed-reference treatment: the review card folds away and the todo
   * list becomes the single step surface.
   */
  built?: boolean;
  /**
   * True once every step is complete and the user has sent a later message.
   * The "Plan complete" row stays visible until that message, then hides.
   */
  completedDismissed?: boolean;
  /** Epoch milliseconds the plan was last written. */
  updatedAt: number;
}

/**
 * A user's decision on a pending approval request. The vocabulary is fixed:
 *
 * - `allow-once`  — this request only.
 * - `allow-always`— persist a lasting rule in `globalState`.
 * - `allow-session`— remember for this conversation/thread only.
 * - `reject`      — deny and tell the agent, so it can adapt.
 */
export type ApprovalDecision = 'allow-once' | 'allow-always' | 'allow-session' | 'reject';

/** A decision the user made on a pending approval, carried by the transcript. */
export interface ApprovalOutcome {
  /** The `ApprovalRequest.id` this decided. */
  requestId: string;
  decision: ApprovalDecision;
  /** Short label of what was allowed or denied, shown in the transcript. */
  subject?: string;
}

/** A stored `always` rule that can be listed and revoked. */
export interface ApprovalRule {
  id: string;
  /** Backend the rule was created for, e.g. `codex`. */
  backendId: string;
  /** What the approval concerns, so a match uses the same axis. */
  kind: ApprovalRequestKind;
  /** Human-readable scope: exactly what the rule allows. */
  scope: string;
  /**
   * Native exec-policy `prefix_rule` token shape, recorded for compatibility
   * with the CLI. Matching uses `commandFamily`; empty or absent for a
   * non-command rule.
   */
  commandPrefix?: string[];
  /**
   * Normalized command family (program + leading non-flag tokens) this rule
   * matches. A rule with no family is a legacy rule and never matches.
   */
  commandFamily?: string[];
  /**
   * True when `commandFamily` is the exact token list of an unclassifiable or
   * composed command, so it only matches that exact token list.
   */
  commandExact?: boolean;
  /**
   * Whether the recorded git command is a write. A read-only git rule never
   * matches a write request.
   */
  gitWrite?: boolean;
  /** File roots the rule allows writes under, for a `file-change` rule. */
  paths?: string[];
  /** Host the rule allows network access to, for a permissions rule. */
  host?: string;
  /** Native proposed exec-policy prefix the rule mirrors, when one was offered. */
  execPolicyAmendment?: string[];
  /** Where the rule originated (workspace root or cwd). */
  origin?: string;
  /** Epoch milliseconds the rule was created. */
  createdAt: number;
}

/**
 * The persistent shape of the approval state a reload must not lose. Session
 * rules live under `workspaceState` keyed by thread, so a window reload in the
 * middle of a turn does not ask again for something already allowed, and never
 * silently auto-allows something it was not told to.
 */
export interface ApprovalSessionState {
  /** `always` rules, shared across workspaces. */
  rules: ApprovalRule[];
  /** Session (`session`) rules, keyed `backendId:threadId`. */
  sessions: Record<string, ApprovalRule[]>;
}

/**
 * Result of reconnecting to an existing thread: the live handle plus the prior
 * turns the renderer replays before the notification stream resumes.
 */
export interface ResumeResult {
  handle: ThreadHandle;
  model?: string;
  items: TranscriptItem[];
  /**
   * True when the provider still has turns older than `items`. The host paints
   * a page and loads the rest when the reader scrolls up.
   */
  hasOlderHistory?: boolean;
  /**
   * True when the provider thread was gone and this result is a new thread
   * carrying the saved chat. The sidebar conversation id stays the same.
   */
  recovered?: boolean;
}

/** One page of transcript rows older than those already painted. */
export interface OlderHistoryPage {
  items: TranscriptItem[];
  /** True when another page exists beyond `items`. */
  hasMore: boolean;
}

export interface ThreadStartedEvent {
  type: 'thread/started';
  backendId: string;
  threadId: string;
  model?: string;
}

/**
 * The provider's own view of a thread's runtime state, normalized from the
 * app-server's `ThreadStatus`. `idle` and `active` are meaningful to the
 * renderer; `notLoaded` / `systemError` are surfaced as a distinct status so the
 * UI can stop showing a spinner without inventing a fake turn.
 */
export type ThreadStatus = 'idle' | 'active' | 'notLoaded' | 'systemError';

export interface ThreadStatusChangedEvent {
  type: 'thread/status/changed';
  backendId: string;
  threadId: string;
  status: ThreadStatus;
}

export interface ItemStartedEvent {
  type: 'item/started';
  backendId: string;
  threadId: string;
  item: TranscriptItem;
}

export interface ItemDeltaEvent {
  type: 'item/delta';
  backendId: string;
  threadId: string;
  itemId: string;
  delta: string;
}

export interface ItemCompletedEvent {
  type: 'item/completed';
  backendId: string;
  threadId: string;
  itemId: string;
  status: 'completed' | 'failed';
}

export interface TurnStartedEvent {
  type: 'turn/started';
  backendId: string;
  threadId: string;
  turnId: string;
}

export interface TurnCompletedEvent {
  type: 'turn/completed';
  backendId: string;
  threadId: string;
  turnId: string;
}

export interface TurnInterruptedEvent {
  type: 'turn/interrupted';
  backendId: string;
  threadId: string;
  turnId: string;
  reason?: string;
  /** True when the interruption was a user-initiated cancel, not a failure. */
  canceled?: boolean;
}

/**
 * A backend reported a structured file edit during the current turn.
 *
 * This is the content side of a message that was previously discarded. It does
 * not itself record a journal entry: the host holds the report, then snapshot-
 * diffs it at turn end so the recorded before/after hashes are real. The
 * existing approval semantics are untouched — the approval request still goes to
 * the user exactly as before; this event only carries what the edit touched.
 */
export interface ChangesReportedEvent {
  type: 'changes/reported';
  backendId: string;
  threadId: string;
  turnId?: string;
  changes: ReportedChange[];
}

/**
 * A backend is waiting on a decision before the turn can continue. The turn is
 * blocked at the backend, not the UI: without an answer the request would hang,
 * so nothing here is ever auto-decided.
 */
/** A Plan or Agent turn is blocked until the user answers this question set. */
export interface QuestionRequestedEvent {
  type: 'question/requested';
  backendId: string;
  threadId: string;
  request: QuestionRequest;
}

export interface ApprovalRequestedEvent {
  type: 'approval/requested';
  backendId: string;
  threadId: string;
  turnId?: string;
  approval: ApprovalRequest;
}

/** A pending approval was decided, whichever way. */
export interface ApprovalDecidedEvent {
  type: 'approval/decided';
  backendId: string;
  threadId: string;
  outcome: ApprovalOutcome;
}

/** A request was denied; the agent is told, so it can adapt rather than stall. */
export interface ApprovalDeniedEvent {
  type: 'approval/denied';
  backendId: string;
  threadId: string;
  requestId: string;
  /** Short label of what was refused, for the transcript. */
  subject?: string;
  /** Plain-language reason the agent receives. */
  reason: string;
}

/**
 * The provider's own plan for the current turn changed. Mirrors the generated
 * `turn/plan/updated` notification: the plan's bullet list is the source of
 * truth for the todo list, and this event carries it through the same
 * provider-neutral path as every other event.
 */
export interface PlanUpdatedEvent {
  type: 'plan/updated';
  backendId: string;
  threadId: string;
  turnId: string;
  /** Optional one-line explanation the provider attached to the plan change. */
  explanation?: string;
  steps: TodoStep[];
}

/**
 * The persistent shape of the approval state a reload must not lose. Session
 * rules live under `workspaceState` keyed by thread, so a window reload in the
 * middle of a turn does not ask again for something already allowed, and never
 * silently auto-allows something it was not told to.
 */
export interface ApprovalSessionState {
  /** `always` rules, shared across workspaces. */
  rules: ApprovalRule[];
  /** Session (`session`) rules, keyed `backendId:threadId`. */
  sessions: Record<string, ApprovalRule[]>;
}

/**
 * Machine-readable shape of a failure surfaced to the renderer.
 *
 * The taxonomy is deliberately small and provider-neutral: `unauthenticated`
 * drives the actionable sign-in affordance, `network` and `stream` are
 * non-alarming degraded states, and `canceled` is a user-initiated stop.
 */
export type ErrorEventCode =
  | 'unauthenticated'
  | 'network'
  | 'stream'
  | 'provider'
  | 'canceled'
  /**
   * A credential was rejected that is not the one the user chose: specifically,
   * an API key where the ChatGPT login was expected. Distinct from the generic
   * `unauthenticated` so the API-key-vs-ChatGPT mismatch is named rather than
   * reported as a plain sign-out.
   */
  | 'auth-mismatch'
  /**
   * The optional agentic runtime could not be started. `cli-missing` is the
   * runtime executable not being resolvable, `spawn` is a launch failure once
   * resolved, and `invalid-config` is a generated config the runtime refused.
   */
  | 'cli-missing'
  | 'spawn'
  | 'invalid-config';

/**
 * A provider-neutral, non-transcript line the runtime wants to surface, e.g. a
 * degraded session resume. Carried on the shared event union so the host can
 * render it with the existing notice path and no provider-specific branch.
 */
export interface NoticeEvent {
  type: 'notice';
  backendId: string;
  threadId?: string;
  level: 'info' | 'warning';
  message: string;
}

/**
 * How full the model's context window is.
 *
 * `usedTokens` is the occupancy of the current window, not a lifetime total.
 * `windowTokens` is present when the provider named the window itself; the
 * ring still prefers the resolved max-context setting when one exists.
 */
export interface ContextUsageEvent {
  type: 'context/usage';
  backendId: string;
  threadId: string;
  usedTokens: number;
  windowTokens?: number;
}

export interface ErrorEvent {
  type: 'error';
  backendId: string;
  threadId?: string;
  message: string;
  /** False when the backend should be re-probed; true when the turn can continue. */
  recoverable: boolean;
  /** Present for categorized failures; lets the UI pick an affordance, not just text. */
  code?: ErrorEventCode;
}

/** Normalized stream both adapters feed the transcript renderer with. */
export type AgentEvent =
  | ThreadStartedEvent
  | ThreadStatusChangedEvent
  | ItemStartedEvent
  | ItemDeltaEvent
  | ItemCompletedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnInterruptedEvent
  | ChangesReportedEvent
  | QuestionRequestedEvent
  | ApprovalRequestedEvent
  | ApprovalDecidedEvent
  | ApprovalDeniedEvent
  | PlanUpdatedEvent
  | NoticeEvent
  | ContextUsageEvent
  | ErrorEvent;

export type AgentEventType = AgentEvent['type'];

export type BackendErrorCode = 'unavailable' | 'incompatible' | 'unauthenticated' | 'provider';

/**
 * Typed failure raised by a backend. `unavailable` means the backend could not
 * initialise at all (missing CLI, unreachable host); `incompatible` means it
 * started but reports a protocol version outside the pinned range; 
 * `unauthenticated` means it runs but has no usable credential; `provider` is a
 * recoverable API failure.
 */
export class BackendError extends Error {
  readonly code: BackendErrorCode;
  /** The server-reported version, carried only for `incompatible`. */
  readonly version?: string;
  /**
   * True when this attempt failed for a transient reason (the model host was
   * full, an upstream rate limit, a dropped stream, an internal server error)
   * and re-sending the same turn can recover. Set by the adapter that knows
   * the provider's structured error kind; the host uses it to continue
   * automatically instead of stopping for a Retry click.
   */
  retryable = false;

  constructor(code: BackendErrorCode, message: string, cause?: unknown, version?: string) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
    this.version = version;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/** What a backend needs in order to compact one thread. */
export interface CompactRequest {
  model?: string;
  modelSettings?: ModelSettingOverrides;
  /** Stored turns, for a backend that has to summarize them itself. */
  transcript: TranscriptItem[];
  /** Effective context window, so a summary request can be kept inside it. */
  maxTokens?: number;
}

/** The outcome of a compaction. An absent transcript means the provider kept its own. */
export interface CompactResult {
  transcript?: TranscriptItem[];
}

export interface AgentBackend {
  readonly id: string;
  readonly label: string;
  readonly badge: string;

  /**
   * Permission levels this backend can actually serve, in presentation order.
   * A backend with no approval channel (Ollama Cloud) reports exactly one level
   * and never emits an approval request, rather than faking prompts.
   */
  readonly permissionLevels: readonly PermissionLevel[];

  /**
   * Modes this backend can honour, in presentation order. A backend that cannot
   * enforce a mode must not list it, so the UI hides it instead of showing a
   * mode that silently behaves like `agent`. Every backend supports `agent`.
   */
  readonly modes: readonly DefaultMode[];

  /** True when this backend has an approval channel the UI may surface. */
  readonly hasApprovalChannel: boolean;

  /**
   * The stored `always` rules, newest first. Empty for a backend with no
   * approval channel.
   */
  listApprovalRules(): Promise<ApprovalRule[]>;

  /** Removes one stored `always` rule. A no-op when it is already gone. */
  revokeApprovalRule(ruleId: string): Promise<void>;

  /**
   * Answers a pending approval request. Must be called exactly once per
   * `approval/requested`; deciding a request that is already settled is a no-op
   * so a double click cannot answer twice. Never called on a timer.
   */
  decideApproval(threadId: string, requestId: string, decision: ApprovalDecision): void;

  /**
   * Answers a pending clarifying question. Must be called exactly once per
   * `question/requested`. An unknown or already settled id is a no-op.
   */
  answerQuestion(threadId: string, requestId: string, answers: QuestionAnswer[]): void;

  /**
   * Resolves whether the backend has a usable credential.
   * Throws `BackendError('unavailable')` when it cannot run at all.
   */
  isAuthenticated(): Promise<boolean>;

  /**
   * Optional richer auth report: the boolean plus, when the backend can name
   * it, the active auth mode and a distinct status such as an API-key-vs-login
   * mismatch. A backend that cannot report one is treated as `isAuthenticated()`.
   * Must never include a credential value.
   */
  authStatus?(): Promise<AuthStatusReport>;

  /** Lists models, most preferred first. */
  listModels(): Promise<BackendModel[]>;

  /**
   * The capability descriptor for one model, populated from the provider.
   *
   * Returns `undefined` when the model is not in the current list, so the caller
   * degrades to all-unknown rather than guessing. A backend that cannot report
   * per-model metadata still implements this and returns a descriptor that is
   * `'unknown'` where the provider said nothing.
   */
  modelCapabilities(modelId: string): Promise<ModelCapabilities | undefined>;

  /**
   * Performs a real authenticated call and classifies the result, so the
   * settings screen can distinguish a rejected credential from an unreachable
   * host or a network failure. Must never throw and never include the token.
   */
  testConnection?(): Promise<ConnectionTestResult>;

  startThread(options?: StartThreadOptions): Promise<ThreadHandle>;

  /**
   * Reconnects to an existing thread and returns its prior turns for replay.
   * Throws `BackendError('provider')` when the thread no longer exists and there
   * is nothing saved to continue from. A Codex thread that is gone, but whose
   * sidebar chat is still stored, is continued on a new thread instead.
   *
   * `options.context` is supplied again because a resumed thread must be
   * re-primed: the upstream provider may have lost its own context across the
   * resume, and a snapshot is cheap next to a confused session.
   */
  resumeThread(threadId: string, options?: ResumeThreadOptions): Promise<ResumeResult>;

  /**
   * The next older page of a resumed thread. Codex reads it from the app-server
   * cursors. Absent when the backend's own transcript is already complete.
   */
  loadOlderHistory?(threadId: string): Promise<OlderHistoryPage>;

  /** Lists threads this backend still knows about, newest first. */
  listThreads(): Promise<ThreadSummary[]>;

  /** Sends a turn and streams its result through `onEvent`. */
  sendTurn(handle: ThreadHandle, request: SendTurnRequest): Promise<void>;

  /**
   * Shrink the thread's context. Codex asks the app-server to compact in
   * place. Ollama summarizes the stored transcript and returns the replacement
   * the host persists. Safe to call only while no turn is running.
   */
  compact(handle: ThreadHandle, request: CompactRequest): Promise<CompactResult>;

  /**
   * Summarize a stored transcript so another provider can continue the chat.
   * Must not modify the thread. The host turns the text into the compacted
   * transcript it seeds onto the next provider.
   */
  summarize(request: CompactRequest): Promise<string>;

  /**
   * Adds a user message to the active turn.
   * Codex steers the app-server turn in place. Ollama, including its opencode
   * runtime, stops the current generation and continues the same turn with the
   * new text.
   */
  steerTurn?(handle: ThreadHandle, text: string, clientUserMessageId?: string): Promise<void>;

  /**
   * Aborts one in-flight turn. `threadId` stops that chat and leaves the others
   * running. With no id, every turn on this backend stops. Safe to call when idle.
   * The adapter must leave the transcript coherent and emit an interruption.
   */
  cancel(threadId?: string): void;

  /** Subscribes to the normalized event stream. */
  onEvent(listener: (event: AgentEvent) => void): Disposable;

  /**
   * Releases the backend's resources. A backend that owns a child process must
   * terminate it; returning a promise lets `deactivate` wait for a clean exit so
   * no orphan survives a window reload or extension-host restart.
   */
  dispose(): void | Promise<void>;
}
