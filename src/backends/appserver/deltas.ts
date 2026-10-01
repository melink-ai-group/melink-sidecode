/**
 * Maps the app-server's streaming delta notifications onto the neutral
 * `item/delta` shape.
 *
 * Delta method names are the most drift-prone part of the protocol: the current
 * CLI streams an assistant message as `item/agentMessage/delta`, but a rename or
 * an alias between releases would otherwise complete a turn silently with an
 * empty transcript — the item would open and close with no text. Keeping the
 * method-to-field mapping here, as a pure table, means a new or renamed delta
 * method is one entry and is covered by a unit test rather than a runtime
 * mystery.
 *
 * The adapter still ignores an unrecognised method (a newer CLI must not be able
 * to break the transcript), but every method it does know is listed explicitly
 * so a missing one is a visible omission, not an accident.
 */

import type { AgentMessageDeltaNotification } from '../../../schemas/v2/AgentMessageDeltaNotification';
import type { ReasoningTextDeltaNotification } from '../../../schemas/v2/ReasoningTextDeltaNotification';
import type { ReasoningSummaryTextDeltaNotification } from '../../../schemas/v2/ReasoningSummaryTextDeltaNotification';
import type { CommandExecutionOutputDeltaNotification } from '../../../schemas/v2/CommandExecutionOutputDeltaNotification';

/** One streaming delta, normalized across every delta method. */
export interface ItemDelta {
  threadId: string;
  itemId: string;
  delta: string;
}

/**
 * The delta methods this adapter understands. `item/agentMessage/delta` is the
 * assistant-message stream and the one that must be present for a turn to render
 * incrementally; the reasoning and command variants stream their own item kinds.
 *
 * Every entry is keyed by the exact wire method. Add a new method here (and a
 * test) rather than special-casing it in the switch, so the set stays complete.
 */
const DELTA_METHODS = new Set<string>([
  'item/agentMessage/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/commandExecution/outputDelta'
]);

/**
 * Extract a delta from a notification, or `undefined` when the method is not a
 * known streaming method. A malformed payload (missing ids or a non-string
 * delta) is also `undefined`, so a shape change degrades to no delta rather than
 * firing a corrupt event.
 */
export function itemDeltaFor(
  method: string,
  params: unknown
): ItemDelta | undefined {
  if (!DELTA_METHODS.has(method)) {
    return undefined;
  }
  const value = params as
    | AgentMessageDeltaNotification
    | ReasoningTextDeltaNotification
    | ReasoningSummaryTextDeltaNotification
    | CommandExecutionOutputDeltaNotification
    | undefined;
  if (!value || typeof value.threadId !== 'string' || typeof value.itemId !== 'string') {
    return undefined;
  }
  if (typeof value.delta !== 'string' || value.delta.length === 0) {
    return undefined;
  }
  return { threadId: value.threadId, itemId: value.itemId, delta: value.delta };
}

/** The exact set of handled delta methods, exposed for the diagnostic tests. */
export const HANDLED_DELTA_METHODS: readonly string[] = [...DELTA_METHODS];
