/**
 * Pure copy for the Orchestration settings tab. Kept out of the JSX so the
 * summary, labels, and dependent help can be unit-tested without a DOM.
 */

import type { OrchestrationToggles } from '../../orchestration/settings.ts';
import { quickTaskApplies } from '../../orchestration/quickTask.ts';

export type OrchestrationFieldKey = keyof OrchestrationToggles;

export interface OrchestrationFieldCopy {
  key: OrchestrationFieldKey;
  label: string;
  help: string;
  defaultValue: boolean;
}

export interface OrchestrationCopyValues extends OrchestrationToggles {
  legacyTesting?: boolean;
  legacyReviewing?: boolean;
}

export const ORCHESTRATION_TITLE = 'Orchestration';
export const ORCHESTRATION_INTRO = 'Changes apply from the next turn.';
export const QUICK_TASKS_DISABLED_HELP = 'Enable at least one pass first.';

export const ORCHESTRATION_FIELDS: readonly OrchestrationFieldCopy[] = [
  {
    key: 'testing',
    label: 'Testing',
    help: 'Run typecheck or lint and the tests after a turn that changes files. (Default: on.)',
    defaultValue: true
  },
  {
    key: 'reviewing',
    label: 'Reviewing',
    help: 'Read-only diff review after a turn that changes files. Advisory; never edits or blocks Keep. (Default: off.)',
    defaultValue: false
  },
  {
    key: 'doubleCheck',
    label: 'Double-check',
    help: 'Sweep changed files for VS Code errors after a turn. No second model call. (Default: on.)',
    defaultValue: true
  },
  {
    key: 'quickTask',
    label: 'Quick tasks',
    help: 'Skip these passes for short, single-question turns in Agent mode. (Default: on.)',
    defaultValue: true
  },
  {
    key: 'planning',
    label: 'Plan autopilot',
    help: 'Continue a built plan step by step after a clean turn. Agent mode only. (Default: on.)',
    defaultValue: true
  }
];

const SUMMARY_LABELS: Record<OrchestrationFieldKey, string> = {
  testing: 'testing',
  reviewing: 'reviewing',
  doubleCheck: 'double-check',
  quickTask: 'quick tasks',
  planning: 'plan autopilot'
};

export function orchestrationField(key: OrchestrationFieldKey): OrchestrationFieldCopy {
  return ORCHESTRATION_FIELDS.find((field) => field.key === key) ?? ORCHESTRATION_FIELDS[0];
}

export function orchestrationSummary(values: OrchestrationCopyValues): string {
  const on = summaryKeys().filter((key) => values[key]);
  const off = summaryKeys().filter((key) => !values[key]);
  const onText = on.length
    ? `${joinNatural(on.map((key) => SUMMARY_LABELS[key]))} on`
    : 'no post-turn passes';
  const offText = on.length && off.length
    ? ` · ${joinNatural(off.map((key) => SUMMARY_LABELS[key]))} off`
    : '';
  const base = `Effective policy: ${onText}${offText}`;
  return effectiveQuickTask(values)
    ? `${base} · quick tasks skip these passes.`
    : `${base}.`;
}

export function orchestrationFieldHelp(
  key: OrchestrationFieldKey,
  values: OrchestrationCopyValues
): string {
  if (key === 'testing' && values.legacyTesting) {
    return `${values.testing ? 'On' : 'Off'} from \`melink.review.checks.enabled\`; saving takes over.`;
  }
  if (key === 'reviewing' && values.legacyReviewing) {
    return `${values.reviewing ? 'On' : 'Off'} from \`melink.review.diffReview\`; saving takes over.`;
  }
  if (key === 'quickTask' && !quickTasksAvailable(values)) {
    return QUICK_TASKS_DISABLED_HELP;
  }
  return orchestrationField(key).help;
}

export function quickTasksAvailable(values: OrchestrationCopyValues): boolean {
  return values.testing || values.reviewing || values.doubleCheck;
}

/**
 * The value the field displays and the draft saves. With every pass off there
 * is nothing to skip, so the toggle is effectively off even if the stored
 * snapshot still says true.
 */
export function effectiveQuickTask(values: OrchestrationCopyValues): boolean {
  return quickTaskApplies(values.quickTask, values);
}

function summaryKeys(): OrchestrationFieldKey[] {
  return ['testing', 'reviewing', 'doubleCheck', 'planning'];
}

function joinNatural(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? '';
  }
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
