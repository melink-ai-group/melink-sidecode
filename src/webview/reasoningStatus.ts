import type { ItemStatus } from './state.ts';

/**
 * The state-only wording announced for reasoning. It deliberately never
 * contains streamed text: the live region must change on state, not per delta.
 */
export function reasoningStatusMessage(status: ItemStatus): string {
  if (status === 'streaming' || status === 'pending') {
    return 'Reasoning in progress';
  }
  if (status === 'completed') {
    return 'Reasoning finished';
  }
  if (status === 'failed' || status === 'canceled' || status === 'warning') {
    return 'Reasoning stopped';
  }
  return '';
}

function isActive(status: ItemStatus | undefined): boolean {
  return status === 'streaming' || status === 'pending';
}

/**
 * What to announce now that `status` is current. A reasoning item that mounts
 * already terminal stays quiet (its history is not a new event), while an item
 * that was active when this view saw it announces its start and its terminal
 * state. Pending and streaming are one in-progress state.
 */
export function reasoningAnnouncement(status: ItemStatus, previous: ItemStatus | undefined): string {
  if (isActive(status)) {
    return isActive(previous) ? '' : reasoningStatusMessage(status);
  }
  if (isActive(previous)) {
    return reasoningStatusMessage(status);
  }
  return '';
}

export interface ReasoningState {
  id: string;
  kind: string;
  status: ItemStatus;
}

/**
 * Compare the statuses this view last announced with every transcript item.
 * Non-reasoning tools are ignored, so an item folded into a collapsed activity
 * group is still announced from the transcript itself. The result is one
 * state-only message for any start or terminal transition; items that were
 * already terminal on mount stay quiet.
 */
export function reasoningTransition(
  previous: ReadonlyMap<string, ItemStatus>,
  current: readonly ReasoningState[]
): { announcement: string; statuses: Map<string, ItemStatus> } {
  const statuses = new Map<string, ItemStatus>();
  let announcement = '';
  for (const item of current) {
    if (item.kind !== 'reasoning') {
      continue;
    }
    const before = previous.get(item.id);
    const next = reasoningAnnouncement(item.status, before);
    if (next) {
      announcement = next;
    }
    statuses.set(item.id, item.status);
  }
  return { announcement, statuses };
}
