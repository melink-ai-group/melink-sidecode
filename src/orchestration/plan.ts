/**
 * One decision per turn: whether the reply is a quick task and which post-turn
 * passes are enabled for it. Host-free so the pipeline and the settings UI agree.
 */

import { detectQuickTask, quickTaskApplies, type QuickTaskReason } from './quickTask.ts';
import type { OrchestrationToggles } from './settings.ts';

export interface TurnPlanInput {
  text: string;
  mode: string;
  origin: string;
  hasAttachments: boolean;
  hasActivePlan: boolean;
  settings: OrchestrationToggles;
}

export interface TurnPlan {
  quick: boolean;
  quickReason: QuickTaskReason;
  testing: boolean;
  reviewing: boolean;
  doubleCheck: boolean;
  planning: boolean;
}

export function planTurn(input: TurnPlanInput): TurnPlan {
  const decision = detectQuickTask({
    text: input.text,
    mode: input.mode,
    origin: input.origin,
    hasAttachments: input.hasAttachments,
    hasActivePlan: input.hasActivePlan,
    // With every skippable pass off there is nothing to skip, so the toggle is
    // inert here exactly as the settings screen shows it.
    settings: {
      quickTask: quickTaskApplies(input.settings.quickTask, {
        testing: input.settings.testing,
        reviewing: input.settings.reviewing,
        doubleCheck: input.settings.doubleCheck
      })
    }
  });
  const enabled = !decision.quick;

  return {
    quick: decision.quick,
    quickReason: decision.reason,
    testing: input.settings.testing && enabled,
    reviewing: input.settings.reviewing && enabled,
    doubleCheck: input.settings.doubleCheck && enabled,
    planning: input.settings.planning && enabled && input.mode === 'agent'
  };
}
