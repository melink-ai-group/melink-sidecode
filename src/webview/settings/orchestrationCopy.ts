/**
 * Pure copy for the Orchestration settings tab. Kept out of the JSX so the
 * summary, labels, and help can be unit-tested without a DOM.
 */

import type { OrchestrationChoice, OrchestrationChoices } from '../../orchestration/settings.ts';

export type OrchestrationFieldKey = keyof OrchestrationChoices;

export interface OrchestrationFieldCopy {
  key: OrchestrationFieldKey;
  label: string;
  help: string;
  defaultValue: OrchestrationChoice;
}

export interface OrchestrationCopyValues extends OrchestrationChoices {
  legacyTesting?: boolean;
  legacyReviewing?: boolean;
}

export const ORCHESTRATION_TITLE = 'Orchestration';
export const ORCHESTRATION_INTRO = 'Changes apply from the next turn.';
export const AUTO_EXPLANATION =
  'Auto runs a pass only when this turn is relevant; On runs it whenever its mode applies; Off never runs it.';

export const ORCHESTRATION_FIELDS: readonly OrchestrationFieldCopy[] = [
  {
    key: 'testing',
    label: 'Testing',
    help:
      'Run typecheck or lint and the tests after a turn. Auto runs only when code files changed. (Default: On.)',
    defaultValue: 'on'
  },
  {
    key: 'reviewing',
    label: 'Reviewing',
    help:
      'Read-only diff review after a turn. Auto runs only when code files changed. Advisory; never edits or blocks Keep. (Default: Auto.)',
    defaultValue: 'auto'
  },
  {
    key: 'styling',
    label: 'Styling check',
    help:
      'Check new frontend work against the brand kit, tokens, and existing components. Auto and On both require a frontend file change. (Default: Auto.)',
    defaultValue: 'auto'
  },
  {
    key: 'doubleCheck',
    label: 'Double-check',
    help:
      'Sweep changed files for VS Code errors after a turn. Auto runs only when code files changed. No second model call. (Default: Auto.)',
    defaultValue: 'auto'
  },
  {
    key: 'quickTask',
    label: 'Quick tasks',
    help:
      'Short single-question Agent turns always bypass the other passes. Off hides the Quick notice; Auto or On shows it. (Default: Off.)',
    defaultValue: 'off'
  },
  {
    key: 'planning',
    label: 'Plan autopilot',
    help:
      'Continue a built plan step by step after a clean turn. Agent mode and an active plan are required. (Default: Auto.)',
    defaultValue: 'auto'
  }
];

const SUMMARY_LABELS: Record<OrchestrationFieldKey, string> = {
  testing: 'testing',
  reviewing: 'reviewing',
  styling: 'styling',
  doubleCheck: 'double-check',
  quickTask: 'quick tasks',
  planning: 'plan autopilot'
};

const CHOICE_LABELS: Record<OrchestrationChoice, string> = {
  auto: 'Auto',
  on: 'On',
  off: 'Off'
};

export function choiceLabel(choice: OrchestrationChoice): string {
  return CHOICE_LABELS[choice];
}

export function orchestrationField(key: OrchestrationFieldKey): OrchestrationFieldCopy {
  return ORCHESTRATION_FIELDS.find((field) => field.key === key) ?? ORCHESTRATION_FIELDS[0];
}

export function orchestrationSummary(values: OrchestrationCopyValues): string {
  const roles = summaryKeys().map(
    (key) => `${SUMMARY_LABELS[key]} ${choiceLabel(values[key])}`
  );
  const quick =
    values.quickTask === 'off'
      ? 'quick notice Off'
      : `quick notice ${choiceLabel(values.quickTask)}`;
  return `Effective policy: ${joinNatural(roles)}. Quick bypass always applies; ${quick}.`;
}

export function orchestrationFieldHelp(
  key: OrchestrationFieldKey,
  values: OrchestrationCopyValues
): string {
  if (key === 'testing' && values.legacyTesting) {
    return `${choiceLabel(values.testing)} from \`melink.review.checks.enabled\`; saving takes over.`;
  }
  if (key === 'reviewing' && values.legacyReviewing) {
    return `${choiceLabel(values.reviewing)} from \`melink.review.diffReview\`; saving takes over.`;
  }
  return orchestrationField(key).help;
}

function summaryKeys(): OrchestrationFieldKey[] {
  return ['testing', 'reviewing', 'styling', 'doubleCheck', 'planning'];
}

function joinNatural(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? '';
  }
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
