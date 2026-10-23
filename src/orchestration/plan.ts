/**
 * One decision per turn: whether the reply is a quick task and which roles are
 * potential or resolved for it. Host-free so the pipeline and the settings UI
 * agree.
 *
 * Two decisions live here:
 *
 * - `planTurn` runs at dispatch. It records the six choices, always runs quick
 *   detection (the bypass is intrinsic), and marks which roles could still run
 *   once the change set is known.
 * - `resolvePostTurnRoles` runs at turn end with the closed change set. It
 *   applies the tri-state policy: Off never, On whenever the hard mode applies,
 *   Auto only when the change is relevant (code changed, or a frontend file for
 *   the styling pass).
 */

import { detectQuickTask, type QuickTaskReason } from './quickTask.ts';
import { isFrontendPath } from '../review/stylingReview.ts';
import {
  ORCHESTRATION_DEFAULTS,
  normalizeOrchestrationChoice,
  type OrchestrationChoice,
  type OrchestrationChoices,
  type OrchestrationKey
} from './settings.ts';

export type PostTurnRole = 'testing' | 'reviewing' | 'styling' | 'doubleCheck';

export interface TurnPlanInput {
  text: string;
  mode: string;
  origin: string;
  hasAttachments: boolean;
  hasActivePlan: boolean;
  settings: OrchestrationChoices;
}

export interface TurnPlan {
  /** The six effective choices this turn was planned with. */
  choices: OrchestrationChoices;
  quick: boolean;
  quickReason: QuickTaskReason;
  /** True when quick detection forced every role off for this turn. */
  quickBypass: boolean;
  /** True when the Quick role/notice is surfaced (`quickTask` is not Off). */
  quickNotice: boolean;
  /** Potential post-turn roles; the change set resolves them at turn end. */
  testing: boolean;
  reviewing: boolean;
  styling: boolean;
  doubleCheck: boolean;
  /** Planning is resolved at plan time: Agent mode, an active plan, not Off. */
  planning: boolean;
  reasons: Partial<Record<OrchestrationKey, string>>;
}

export function planTurn(input: TurnPlanInput): TurnPlan {
  const choices = normalizedChoices(input.settings);
  const decision = detectQuickTask({
    text: input.text,
    mode: input.mode,
    origin: input.origin,
    hasAttachments: input.hasAttachments,
    hasActivePlan: input.hasActivePlan
  });
  const quickBypass = decision.quick;
  const reasons: Partial<Record<OrchestrationKey, string>> = {};

  const potential = (key: PostTurnRole): boolean => {
    if (quickBypass) {
      reasons[key] = 'quick-bypass';
      return false;
    }
    if (choices[key] === 'off') {
      reasons[key] = 'off';
      return false;
    }
    reasons[key] = `${choices[key]}-pending-change-set`;
    return true;
  };

  const planning = planningEnabled(choices.planning, input.mode, input.hasActivePlan, quickBypass);
  reasons.planning = planningReason(choices.planning, input.mode, input.hasActivePlan, quickBypass);
  reasons.quickTask = quickBypass
    ? choices.quickTask === 'off'
      ? 'quick-bypass-silent'
      : 'quick-bypass-notice'
    : decision.reason;

  return {
    choices,
    quick: decision.quick,
    quickReason: decision.reason,
    quickBypass,
    quickNotice: quickBypass && choices.quickTask !== 'off',
    testing: potential('testing'),
    reviewing: potential('reviewing'),
    styling: potential('styling'),
    doubleCheck: potential('doubleCheck'),
    planning,
    reasons
  };
}

/** The closed change set a role resolves against. */
export interface ChangeRelevance {
  hasChanges: boolean;
  /** True when at least one non-documentation file changed. */
  codeChanged: boolean;
  /** True when at least one frontend file changed. */
  frontendChanged: boolean;
}

const DOCUMENT_EXTENSIONS = new Set(['md', 'markdown', 'mdx', 'rst', 'adoc', 'txt']);

/** True for a documentation path; a docs-only turn is not code work. */
export function isDocumentationPath(path: string): boolean {
  const match = /\.([^./\\]+)$/.exec(path);
  return match ? DOCUMENT_EXTENSIONS.has(match[1].toLowerCase()) : false;
}

export function changeRelevance(entries: readonly { path: string }[]): ChangeRelevance {
  return {
    hasChanges: entries.length > 0,
    codeChanged: entries.some((entry) => !isDocumentationPath(entry.path)),
    frontendChanged: entries.some((entry) => isFrontendPath(entry.path))
  };
}

export interface PostTurnRoles {
  testing: boolean;
  reviewing: boolean;
  styling: boolean;
  doubleCheck: boolean;
  reasons: Partial<Record<PostTurnRole, string>>;
}

export interface PostTurnInput {
  choices: OrchestrationChoices;
  /** Quick detection is checked here too, so a stale plan can never bypass it. */
  quick: boolean;
  entries: readonly { path: string }[];
}

/** The plan facts the diagnostic and the debug snapshot read. */
export type OrchestrationPlanFacts = Pick<
  TurnPlan,
  'choices' | 'quick' | 'quickBypass' | 'quickNotice' | 'planning' | 'reasons'
> & {
  /**
   * Absent only for the fallback used when a turn has no stored plan (for
   * example a turn that started before this window did).
   */
  quickReason?: QuickTaskReason;
};

/** Reason text for one choice or post-turn role. Never includes file names. */
export type OrchestrationReasons = Partial<Record<OrchestrationKey | PostTurnRole, string>>;

/**
 * The bounded, per-turn debug record of what the resolver decided.
 *
 * It is what the settings read model exposes as the last resolved turn, so a
 * user (or a developer) can see the six choices, the resolved roles, and each
 * reason without reading the output channel. No diff, path, or prompt text is
 * stored.
 */
export interface OrchestrationTurnSnapshot {
  backendId: string;
  threadId: string;
  turnId: string;
  quick: boolean;
  quickReason?: QuickTaskReason;
  quickBypass: boolean;
  quickNotice: boolean;
  choices: OrchestrationChoices;
  roles: {
    testing: boolean;
    reviewing: boolean;
    styling: boolean;
    doubleCheck: boolean;
    planning: boolean;
  };
  reasons: OrchestrationReasons;
}

export interface OrchestrationTurnIds {
  backendId: string;
  threadId: string;
  turnId: string;
}

export function resolvePostTurnRoles(input: PostTurnInput): PostTurnRoles {
  const choices = normalizedChoices(input.choices);
  const relevance = changeRelevance(input.entries);
  const reasons: Partial<Record<PostTurnRole, string>> = {};

  const resolve = (key: PostTurnRole): boolean => {
    if (input.quick) {
      reasons[key] = 'quick-bypass';
      return false;
    }
    const choice = choices[key];
    if (choice === 'off') {
      reasons[key] = 'off';
      return false;
    }
    if (!relevance.hasChanges) {
      reasons[key] = 'no-change-set';
      return false;
    }
    if (key === 'styling') {
      if (!relevance.frontendChanged) {
        reasons[key] = 'no-frontend-change';
        return false;
      }
      reasons[key] = choice === 'on' ? 'on-frontend-change' : 'auto-frontend-change';
      return true;
    }
    if (choice === 'on') {
      reasons[key] = 'on-change';
      return true;
    }
    if (!relevance.codeChanged) {
      reasons[key] = 'docs-only';
      return false;
    }
    reasons[key] = 'auto-code-change';
    return true;
  };

  return {
    testing: resolve('testing'),
    reviewing: resolve('reviewing'),
    styling: resolve('styling'),
    doubleCheck: resolve('doubleCheck'),
    reasons
  };
}

/** A bounded diagnostic line for the output channel; never includes file text. */
export function orchestrationDiagnostic(
  plan: OrchestrationPlanFacts,
  roles: PostTurnRoles
): string {
  const choiceText = (Object.keys(ORCHESTRATION_DEFAULTS) as OrchestrationKey[])
    .map((key) => `${key}:${plan.choices[key]}`)
    .join(',');
  const roleText = (['testing', 'reviewing', 'styling', 'doubleCheck'] as const)
    .map((key) => `${key}=${roles[key] ? 'run' : 'skip'}(${roles.reasons[key] ?? 'unknown'})`)
    .join(' ');
  const planning = `planning=${plan.planning ? 'run' : 'skip'}(${plan.reasons.planning ?? 'unknown'})`;
  return `orchestration turn=${plan.quick ? 'quick' : 'normal'} quickBypass=${plan.quickBypass} quickNotice=${plan.quickNotice} quickReason=${plan.quickReason ?? 'unknown'} choices=${choiceText} ${planning} ${roleText}`;
}

/**
 * Compose the per-turn debug snapshot from the same facts the diagnostic logs.
 *
 * The settings read model exposes the newest one, so the resolved role set is
 * observable without the output channel. The shape is copied, never linked, so
 * the caller's map or plan cannot be mutated through the snapshot.
 */
export function orchestrationTurnSnapshot(
  plan: OrchestrationPlanFacts,
  roles: PostTurnRoles,
  ids: OrchestrationTurnIds
): OrchestrationTurnSnapshot {
  return {
    backendId: ids.backendId,
    threadId: ids.threadId,
    turnId: ids.turnId,
    quick: plan.quick,
    quickReason: plan.quickReason,
    quickBypass: plan.quickBypass,
    quickNotice: plan.quickNotice,
    choices: { ...plan.choices },
    roles: {
      testing: roles.testing,
      reviewing: roles.reviewing,
      styling: roles.styling,
      doubleCheck: roles.doubleCheck,
      planning: plan.planning
    },
    reasons: { ...plan.reasons, ...roles.reasons }
  };
}

function planningEnabled(
  choice: OrchestrationChoice,
  mode: string,
  hasActivePlan: boolean,
  quickBypass: boolean
): boolean {
  if (quickBypass || choice === 'off') {
    return false;
  }
  // Agent mode and a built plan are hard preconditions for On and Auto alike.
  return mode === 'agent' && hasActivePlan;
}

function planningReason(
  choice: OrchestrationChoice,
  mode: string,
  hasActivePlan: boolean,
  quickBypass: boolean
): string {
  if (quickBypass) {
    return 'quick-bypass';
  }
  if (choice === 'off') {
    return 'off';
  }
  if (mode !== 'agent') {
    return 'mode-not-agent';
  }
  if (!hasActivePlan) {
    return 'no-active-plan';
  }
  return `${choice}-agent-plan`;
}

function normalizedChoices(settings: OrchestrationChoices): OrchestrationChoices {
  const result = {} as OrchestrationChoices;
  for (const key of Object.keys(ORCHESTRATION_DEFAULTS) as OrchestrationKey[]) {
    result[key] =
      normalizeOrchestrationChoice(settings?.[key]) ?? ORCHESTRATION_DEFAULTS[key];
  }
  return result;
}
