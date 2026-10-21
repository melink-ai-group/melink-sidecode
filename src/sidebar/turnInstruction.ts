import type { TodoStep } from '../backends/types';
import type { ChangeDecisionResult } from '../changes/changeStore';

/**
 * A plain-language summary of one decision outcome, or `undefined` when the
 * decision took effect. A conflict requires an explicit choice; any other
 * failure names its own reason so the UI shows why, not a generic error.
 */
export function describeDecisionOutcome(result: ChangeDecisionResult): string | undefined {
  if (result.ok) {
    return undefined;
  }
  if (result.conflict) {
    return 'That file changed after the turn. Choose whether to keep the current file or overwrite it with the pre-turn content.';
  }
  return result.error ?? 'The decision could not be applied.';
}

export function isCancellation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const named = error as { name?: unknown; message?: unknown };
  if (named.name === 'AbortError') {
    return true;
  }
  return typeof named.message === 'string' && /cancel/i.test(named.message);
}

/**
 * The turn text sent at the build transition. The plan's bullet list is already
 * the todo list; this tells the agent to execute it, so building the plan moves
 * the thread into execution rather than being a no-op.
 */
export function buildTurnInstruction(steps: readonly TodoStep[]): string {
  const list = steps.map((step) => `- [ ] ${step.text}`).join('\n');
  return [
    'Build the approved plan. Execute each step in order. As soon as you start a step, write a checkbox line on its own line that repeats the step text exactly: "- [~] ...". As soon as you finish it, write "- [x] ...". The plan document and the todo list update from those lines while you work. Leave the plan document prose unchanged.',
    '',
    list
  ].join('\n');
}
