/**
 * The post-turn check gate for a Keep decision.
 *
 * Checks are advisory evidence, not an automatic decision: a failed check never
 * rejects or keeps anything. The host disables Keep while checks run, and asks
 * for an explicit override when they failed. Reject is not gated, so the user
 * can always undo a turn even if its checks are red.
 */

import type { CheckRunView } from './checks.ts';

/** Why Keep is blocked, or `undefined` when the decision may proceed. */
export function decisionBlockReason(
  checks: CheckRunView | undefined,
  override: boolean
): string | undefined {
  if (!checks) {
    return undefined;
  }
  if (checks.status === 'running') {
    return 'Checks are still running. Keep is disabled until they finish.';
  }
  if (override) {
    return undefined;
  }
  if (checks.status === 'failed') {
    return 'Checks failed. Confirm the override to keep anyway.';
  }
  return undefined;
}
