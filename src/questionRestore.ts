/**
 * What a reload does with a pending question card.
 *
 * A fence question is ours: the reply was already stored with the fence
 * removed, so the card can be shown again. A native question belongs to a
 * backend request that died with the previous process, so it can only be
 * reported, never answered.
 */

import type { PendingQuestion } from './questionStore.ts';

export type QuestionRestore =
  | { kind: 'restore'; pending: PendingQuestion }
  | { kind: 'notice'; message: string };

/** A warning for a native question that cannot be reconnected after a reload. */
export const NATIVE_QUESTION_LOST =
  'A question from the AI provider could not be restored after the window reloaded. Ask the agent to repeat it.';

/** Decide whether a stored pending question can be restored or only reported. */
export function restorePendingQuestion(pending: PendingQuestion | undefined): QuestionRestore | undefined {
  if (!pending) {
    return undefined;
  }
  if (pending.source === 'fence') {
    return { kind: 'restore', pending };
  }
  return { kind: 'notice', message: NATIVE_QUESTION_LOST };
}
