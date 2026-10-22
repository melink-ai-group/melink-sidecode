import type { Attachment, DefaultMode, ModelSettingOverrides, PermissionLevel } from '../backends/types.ts';
import { parseDraftAttachments } from '../chatTabs.ts';
import type { QueuedTurnEntryView } from '../protocol';

/**
 * One user turn accepted while its chat was busy.
 *
 * Attachments are already retained (a clipboard image has a saved `path`, never
 * inline bytes), so an entry is plain JSON and survives a reload in workspace
 * state. Inline bytes are never persisted.
 */
export interface QueuedTurn {
  id: string;
  /** Chat tab (`ChatSession.id`) this turn belongs to. Queues never mix chats. */
  sessionId: string;
  text: string;
  attachments: Attachment[];
  createdAt: number;
  /** Snapshot of the chat's mode at enqueue time. */
  mode?: DefaultMode;
  /** Reserved context hint; dispatch recomputes context from the live host. */
  context?: string;
  backendId?: string;
  /** Thread the message was queued against, so a restore can reopen the chat. */
  threadId?: string;
  model?: string;
  permissionLevel?: PermissionLevel;
  modelSettings?: ModelSettingOverrides;
  updatePlan?: boolean;
}

/** Per-chat FIFO queues. Kept as a Map so session order is stable. */
export type UserTurnQueues = Map<string, QueuedTurn[]>;

export const USER_TURN_QUEUE_CAP = 20;

export type EnqueueTurnResult = 'queued' | 'duplicate' | 'full';

let queuedSequence = 0;

export function createQueuedTurnId(): string {
  queuedSequence += 1;
  return `queued_${Date.now().toString(36)}_${queuedSequence.toString(36)}`;
}

function findTurn(queues: UserTurnQueues, id: string): QueuedTurn | undefined {
  for (const queue of queues.values()) {
    const found = queue.find((turn) => turn.id === id);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** Append one turn. Duplicate ids are rejected anywhere, not only per chat. */
export function enqueueTurn(
  queues: UserTurnQueues,
  turn: QueuedTurn,
  cap = USER_TURN_QUEUE_CAP
): EnqueueTurnResult {
  if (findTurn(queues, turn.id)) {
    return 'duplicate';
  }
  const queue = queues.get(turn.sessionId) ?? [];
  if (queue.length >= cap) {
    return 'full';
  }
  queues.set(turn.sessionId, [...queue, turn]);
  return 'queued';
}

export function listQueuedTurns(queues: UserTurnQueues, sessionId: string): readonly QueuedTurn[] {
  return queues.get(sessionId) ?? [];
}

export function peekQueuedTurn(queues: UserTurnQueues, sessionId: string): QueuedTurn | undefined {
  return queues.get(sessionId)?.[0];
}

/** Remove and return the oldest turn for one chat (delete-before-start). */
export function takeNextTurn(queues: UserTurnQueues, sessionId: string): QueuedTurn | undefined {
  const queue = queues.get(sessionId);
  if (!queue || queue.length === 0) {
    return undefined;
  }
  const [next, ...rest] = queue;
  if (rest.length === 0) {
    queues.delete(sessionId);
  } else {
    queues.set(sessionId, rest);
  }
  return next;
}

/** Remove and return one specific turn by id, keeping earlier blocked entries. */
export function takeQueuedTurn(
  queues: UserTurnQueues,
  sessionId: string,
  id: string
): QueuedTurn | undefined {
  const queue = queues.get(sessionId);
  if (!queue) {
    return undefined;
  }
  const index = queue.findIndex((turn) => turn.id === id);
  if (index < 0) {
    return undefined;
  }
  const [taken] = queue.splice(index, 1);
  if (queue.length === 0) {
    queues.delete(sessionId);
  } else {
    queues.set(sessionId, queue.slice());
  }
  return taken;
}

/** Remove one turn by id. False means it already dispatched or never existed. */
export function removeQueuedTurn(queues: UserTurnQueues, sessionId: string, id: string): boolean {
  const queue = queues.get(sessionId);
  if (!queue) {
    return false;
  }
  const next = queue.filter((turn) => turn.id !== id);
  if (next.length === queue.length) {
    return false;
  }
  if (next.length === 0) {
    queues.delete(sessionId);
  } else {
    queues.set(sessionId, next);
  }
  return true;
}

/** Drop one chat's queue (closed tab, cleared chat, or Stop). Returns the count. */
export function clearSessionQueue(queues: UserTurnQueues, sessionId: string): number {
  const queue = queues.get(sessionId) ?? [];
  queues.delete(sessionId);
  return queue.length;
}

function previewText(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1).trimEnd()}…` : collapsed;
}

/** The safe UI shape: a short preview and basenames only, never paths or bytes. */
export function queuedTurnView(turn: QueuedTurn, previewLimit = 80): QueuedTurnEntryView {
  const names = turn.attachments.map((attachment) => attachment.name).filter(Boolean);
  return {
    id: turn.id,
    textPreview: previewText(turn.text, previewLimit),
    attachmentCount: turn.attachments.length,
    ...(names.length > 0 ? { attachmentNames: names } : {})
  };
}

export function queuedTurnViews(
  queues: UserTurnQueues,
  sessionId: string,
  previewLimit = 80
): QueuedTurnEntryView[] {
  return listQueuedTurns(queues, sessionId).map((turn) => queuedTurnView(turn, previewLimit));
}

/**
 * A busy send is queued when the user explicitly asks for it, or when it carries
 * an attachment (steer is text-only).
 */
export function shouldQueueWhileBusy(input: {
  busy: boolean;
  queueRequested: boolean;
  attachmentCount: number;
}): boolean {
  return input.busy && (input.queueRequested || input.attachmentCount > 0);
}

/** The minimal session state dispatch depends on. */
export interface QueueGate {
  id: string;
  turnBusy: boolean;
  turnOpen: boolean;
  pendingQuestion: boolean;
  pendingApproval: boolean;
  disposed: boolean;
}

/**
 * The oldest queued turn that is not blocked. A blocked entry (for example one
 * whose retained attachment vanished) stays in place so nothing is lost, while
 * later messages keep their order and can still dispatch.
 */
export function selectDispatchableTurn(
  queue: readonly QueuedTurn[] | undefined,
  blocked?: ReadonlySet<string>
): QueuedTurn | undefined {
  return queue?.find((entry) => !blocked?.has(entry.id));
}

/**
 * The first queued turn that may start now, oldest queue first. It does not
 * mutate: the host deletes the entry immediately before starting the turn.
 */
export function nextDispatchableTurn(
  queues: UserTurnQueues,
  gates: readonly QueueGate[],
  blocked?: ReadonlySet<string>
): { sessionId: string; entry: QueuedTurn } | undefined {
  for (const [sessionId, queue] of queues) {
    const entry = selectDispatchableTurn(queue, blocked);
    if (!entry) {
      continue;
    }
    const gate = gates.find((candidate) => candidate.id === sessionId);
    if (
      !gate ||
      gate.disposed ||
      gate.turnBusy ||
      gate.turnOpen ||
      gate.pendingQuestion ||
      gate.pendingApproval
    ) {
      continue;
    }
    return { sessionId, entry };
  }
  return undefined;
}

/**
 * One flush pass, in product order: one user turn per idle chat (user intent
 * beats an automatic continuation), then one continue, then one autopilot.
 * A session appears at most once, so a rapid second completion cannot dispatch
 * the same chat twice from one snapshot.
 */
export type QueueDrainAction =
  | { origin: 'user'; sessionId: string; entry: QueuedTurn }
  | { origin: 'continue' | 'autopilot'; sessionId: string };

function gateFor(gates: readonly QueueGate[], sessionId: string): QueueGate | undefined {
  return gates.find((gate) => gate.id === sessionId);
}

function gateIsReady(gate: QueueGate | undefined): gate is QueueGate {
  return Boolean(
    gate && !gate.disposed && !gate.turnBusy && !gate.turnOpen && !gate.pendingQuestion && !gate.pendingApproval
  );
}

export function planQueueDrain(input: {
  queues: UserTurnQueues;
  gates: readonly QueueGate[];
  continuations: readonly string[];
  autopilot: readonly string[];
  /** Entries kept for a retry, skipped so they cannot block later messages. */
  blocked?: ReadonlySet<string>;
}): QueueDrainAction[] {
  const actions: QueueDrainAction[] = [];
  const claimed = new Set<string>();
  for (const [sessionId, queue] of input.queues) {
    const entry = selectDispatchableTurn(queue, input.blocked);
    if (!entry || claimed.has(sessionId) || !gateIsReady(gateFor(input.gates, sessionId))) {
      continue;
    }
    actions.push({ origin: 'user', sessionId, entry });
    claimed.add(sessionId);
  }
  for (const [origin, ids] of [
    ['continue', input.continuations],
    ['autopilot', input.autopilot]
  ] as const) {
    for (const sessionId of ids) {
      if (claimed.has(sessionId) || !gateIsReady(gateFor(input.gates, sessionId))) {
        continue;
      }
      actions.push({ origin, sessionId });
      claimed.add(sessionId);
    }
  }
  return actions;
}

/**
 * Put a dispatched turn back at the front when it could not start. A racing
 * enqueue may already have filled the cap, so this deliberately keeps every
 * accepted entry (at most one over the cap) instead of slicing and losing the
 * newest message. The next enqueue reports full until the drain catches up.
 */
export function requeueTurnFront(queues: UserTurnQueues, turn: QueuedTurn): void {
  const queue = queues.get(turn.sessionId) ?? [];
  if (queue.some((entry) => entry.id === turn.id)) {
    return;
  }
  queues.set(turn.sessionId, [turn, ...queue]);
}

/** The thread a queued turn recorded, when that target is safe to reopen. */
export interface QueuedTurnTarget {
  backendId: string;
  threadId: string;
}

/**
 * A restored entry must go back to the thread it was typed into. No target
 * means "use the chat's current thread"; a partial or unknown-provider target
 * is invalid and must be reported rather than merged into another chat.
 */
export function queuedTurnThreadTarget(
  turn: QueuedTurn,
  isKnownBackend: (backendId: string) => boolean
): QueuedTurnTarget | 'invalid' | undefined {
  if (!turn.backendId && !turn.threadId) {
    return undefined;
  }
  if (!turn.backendId || !turn.threadId) {
    return 'invalid';
  }
  return isKnownBackend(turn.backendId)
    ? { backendId: turn.backendId, threadId: turn.threadId }
    : 'invalid';
}

/** True when a session already points at the target thread. */
export function sessionMatchesQueueTarget(
  session: { activeThread?: { backendId: string; threadId: string } },
  target: QueuedTurnTarget
): boolean {
  return (
    session.activeThread?.backendId === target.backendId &&
    session.activeThread.threadId === target.threadId
  );
}

/** True when a user send must draw its own transcript row in the webview. */
export function shouldAnnounceUserMessage(input: {
  origin: 'user' | 'autopilot' | 'continue' | 'instruction';
  busy: boolean;
  queueRequested: boolean;
  queuedDispatch: boolean;
}): boolean {
  if (input.origin !== 'user') {
    return false;
  }
  // A queued turn was never typed into this webview. A `queue:true` send that
  // raced the end of the host turn was typed there but the webview deferred
  // the bubble, so it also needs the host's row.
  return input.queuedDispatch || (input.queueRequested && !input.busy);
}

/**
 * Workspace-state key for accepted turns. The payload is one-shot: a loading
 * window claims it so a second window cannot dispatch the same messages.
 */
export const QUEUED_TURNS_KEY = 'melink.queuedTurns';
/**
 * Long enough that a second window cannot mistake a live owner for a crash
 * between heartbeat writes; a crashed owner delays restore at most this long.
 */
export const QUEUE_LEASE_MS = 10 * 60_000;

/**
 * A window may hand the lease back only when it has nothing left to dispatch,
 * or when the extension host is shutting down (and local flushing has stopped).
 * Releasing on a plain webview dispose would let a second window claim turns
 * that this process is still about to send.
 */
export function queueLeaseDisposition(input: {
  queuedTurns: number;
  shuttingDown: boolean;
}): 'keep' | 'release' {
  if (input.queuedTurns === 0) {
    return 'release';
  }
  return input.shuttingDown ? 'release' : 'keep';
}

/** Only a non-empty queue needs an owner; an empty payload clears it. */
export function queueLeaseOwner(queuedTurns: number, ownerId: string): string | undefined {
  return queuedTurns > 0 ? ownerId : undefined;
}

export interface PersistedTurnQueues {
  version: 1;
  /** Window that currently owns the queue, so another window stays out. */
  owner?: string;
  /** Last owner heartbeat; a crashed window's lease goes stale. */
  heartbeat?: number;
  queues: Array<{ sessionId: string; turns: QueuedTurn[] }>;
}

function withoutInlineBytes(attachment: Attachment): Attachment {
  const { dataUrl: _dataUrl, ...rest } = attachment;
  return rest;
}

export function serializeTurnQueues(
  queues: UserTurnQueues,
  owner?: string,
  heartbeat = Date.now()
): PersistedTurnQueues {
  return {
    version: 1,
    // With no owner there is no live lease: omit the heartbeat too, so a
    // drained queue never looks like a recent owner to a second window.
    ...(owner ? { owner, heartbeat } : {}),
    queues: [...queues].map(([sessionId, turns]) => ({
      sessionId,
      turns: turns.map((turn) => ({
        ...turn,
        attachments: turn.attachments.map(withoutInlineBytes)
      }))
    }))
  };
}

const MODES = new Set<DefaultMode>(['ask', 'plan', 'agent']);
const PERMISSION_LEVELS = new Set<PermissionLevel>(['read-only', 'default', 'unrestricted']);

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function parseQueuedTurn(value: unknown, sessionId: string): QueuedTurn | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = optionalString(record.id);
  if (!id || typeof record.text !== 'string') {
    return undefined;
  }
  const mode = record.mode;
  const permissionLevel = record.permissionLevel;
  const modelSettings = record.modelSettings;
  return {
    id,
    sessionId,
    text: record.text,
    // Malformed or vanished attachments are dropped here; the host validates
    // paths again before dispatch, so a missing file can never start a turn.
    attachments: parseDraftAttachments(record.attachments),
    createdAt: typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
    ...(mode !== undefined && MODES.has(mode as DefaultMode) ? { mode: mode as DefaultMode } : {}),
    ...(optionalString(record.context) ? { context: record.context as string } : {}),
    ...(optionalString(record.backendId) ? { backendId: record.backendId as string } : {}),
    ...(optionalString(record.threadId) ? { threadId: record.threadId as string } : {}),
    ...(optionalString(record.model) ? { model: record.model as string } : {}),
    ...(permissionLevel !== undefined && PERMISSION_LEVELS.has(permissionLevel as PermissionLevel)
      ? { permissionLevel: permissionLevel as PermissionLevel }
      : {}),
    ...(modelSettings && typeof modelSettings === 'object' && !Array.isArray(modelSettings)
      ? { modelSettings: modelSettings as ModelSettingOverrides }
      : {}),
    ...(typeof record.updatePlan === 'boolean' ? { updatePlan: record.updatePlan } : {})
  };
}

/** Validate a persisted payload; malformed entries are dropped, never thrown. */
export function parsePersistedTurnQueues(
  value: unknown
): { queues: UserTurnQueues; owner?: string; heartbeat: number } | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return undefined;
  }
  const queues: UserTurnQueues = new Map();
  for (const row of Array.isArray(record.queues) ? record.queues : []) {
    if (!row || typeof row !== 'object') {
      continue;
    }
    const sessionId = optionalString((row as Record<string, unknown>).sessionId);
    if (!sessionId) {
      continue;
    }
    const rawTurns = (row as Record<string, unknown>).turns;
    const turns: QueuedTurn[] = [];
    for (const raw of Array.isArray(rawTurns) ? rawTurns : []) {
      const turn = parseQueuedTurn(raw, sessionId);
      if (!turn || turns.some((entry) => entry.id === turn.id)) {
        continue;
      }
      turns.push(turn);
      if (turns.length >= USER_TURN_QUEUE_CAP) {
        break;
      }
    }
    if (turns.length > 0) {
      queues.set(sessionId, turns);
    }
  }
  return {
    queues,
    ...(optionalString(record.owner) ? { owner: record.owner as string } : {}),
    heartbeat:
      typeof record.heartbeat === 'number' && Number.isFinite(record.heartbeat) ? record.heartbeat : 0
  };
}

/** A live foreign owner blocks restore; a crashed owner's lease expires. */
export function foreignQueueLeaseIsLive(
  owner: string | undefined,
  heartbeat: number,
  ownerId: string,
  now = Date.now(),
  leaseMs = QUEUE_LEASE_MS
): boolean {
  return Boolean(owner && owner !== ownerId && heartbeat > now - leaseMs);
}

/**
 * Attachment validation for an enqueue, after clipboard bytes were retained.
 * An image without a path lost its bytes; never queue that silently.
 */
export function invalidQueuedAttachment(
  attachments: readonly Attachment[] | undefined,
  maxBytes: number
): string | undefined {
  for (const attachment of attachments ?? []) {
    if (typeof attachment.size === 'number' && attachment.size > maxBytes) {
      return 'An attached file is too large to send. Remove it and try again.';
    }
    if (attachment.kind === 'image' && !attachment.path) {
      return 'An attached image could not be saved for sending. Attach it again.';
    }
  }
  return undefined;
}
