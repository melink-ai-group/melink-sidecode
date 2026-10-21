/**
 * When a fence question becomes a card.
 *
 * The host captures on the item that completed and again when the turn ends,
 * so a fence whose `item/completed` already produced a card is not lost when
 * the turn is interrupted before `turn/completed`. An interruption also captures
 * the last completed assistant item as a fallback. Ask mode never asks.
 */

import type { AgentEventType, DefaultMode, TranscriptItem } from './backends/types.ts';

/**
 * The assistant item a fence payload should be taken from: the explicit item
 * when the caller has one, otherwise the latest completed assistant message.
 * A live item with no status is treated as completed; replayed history carries
 * a status.
 */
export function findFenceQuestionItem(
  items: readonly TranscriptItem[],
  itemId?: string
): TranscriptItem | undefined {
  if (itemId) {
    return items.find((item) => item.id === itemId);
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== 'message' || item.role !== 'assistant') {
      continue;
    }
    if (item.status === undefined || item.status === 'completed') {
      return item;
    }
  }
  return undefined;
}

/** Capture on item completion and on turn completion/interruption, only in Agent/Plan. */
export function shouldCaptureFenceQuestions(eventType: AgentEventType, mode: DefaultMode): boolean {
  if (mode !== 'agent' && mode !== 'plan') {
    return false;
  }
  return eventType === 'item/completed' || eventType === 'turn/completed' || eventType === 'turn/interrupted';
}
