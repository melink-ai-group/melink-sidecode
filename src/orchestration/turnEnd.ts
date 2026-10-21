/**
 * The two plan decisions a finished Agent turn makes.
 *
 * Settling progress is not part of the planning policy: a step the provider
 * left `inProgress` must return to `pending` even when autopilot is off (or the
 * turn was a quick task, whose plan also carries `planning: false`), or the
 * todo list keeps a spinner that never stops. Only the automatic continuation
 * is gated.
 */

import type { TurnPlan } from './plan.ts';
import type { OrchestrationToggles } from './settings.ts';

export interface TurnEndInput {
  mode: string;
  plan?: TurnPlan;
  settings: Pick<OrchestrationToggles, 'planning'>;
}

export interface TurnEndActions {
  /** Always true for Agent turns; false outside Agent mode. */
  settlePlanProgress: boolean;
  /** True only when this turn's plan allows the next automatic turn. */
  continuePlan: boolean;
}

export function planTurnEnd(input: TurnEndInput): TurnEndActions {
  if (input.mode !== 'agent') {
    return { settlePlanProgress: false, continuePlan: false };
  }
  return {
    settlePlanProgress: true,
    continuePlan: input.plan?.planning ?? input.settings.planning
  };
}

/** The injected side effects a real turn end performs. */
export interface TurnEndSeams {
  /** Settle a step the provider left running, then write the plan document. */
  settle: () => void | Promise<void>;
  /** False when the chat or plan epoch moved on while settling. */
  isStillCurrent: () => boolean;
  /** Queue the next automatic turn. */
  continue: () => void | Promise<void>;
}

/**
 * Run the two turn-end steps in order. Settling happens before the staleness
 * check (it must finish even if the session changes) and the continuation is
 * skipped when the chat moved on or the plan does not allow it.
 */
export async function runTurnEnd(
  input: TurnEndInput,
  seams: TurnEndSeams
): Promise<TurnEndActions> {
  const actions = planTurnEnd(input);
  if (actions.settlePlanProgress) {
    await seams.settle();
  }
  if (!seams.isStillCurrent()) {
    return actions;
  }
  if (actions.continuePlan) {
    await seams.continue();
  }
  return actions;
}
