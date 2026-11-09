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
  /** Undefined reads as the documented default, On. */
  dictation?: boolean;
  legacyTesting?: boolean;
  legacyReviewing?: boolean;
}

export const ORCHESTRATION_TITLE = 'Orchestration';
export const ORCHESTRATION_INTRO = 'Changes apply from the next turn.';
export const AUTO_EXPLANATION =
  'Auto runs a pass only when this turn is relevant; On runs it whenever its mode applies; Off never runs it.';

export const DICTATION_LABEL = 'Dictation for orchestration';
export const DICTATION_HELP =
  'Let a model decide which Auto passes run, using your request and the files that changed. It can only narrow Auto choices: On and Off keep their meaning. Uses the dictation model when one is set, otherwise this chat\u2019s model. (Default: On.)';
export const DICTATION_OFF_HELP =
  'Off keeps the fixed Auto, On, and Off rules and makes no decision call.';

/** The switch's one-line help, honest about the off state. */
export function orchestrationDictationHelp(enabled: boolean): string {
  return enabled ? DICTATION_HELP : DICTATION_OFF_HELP;
}

export const ORCHESTRATION_FIELDS: readonly OrchestrationFieldCopy[] = [
  {
    key: 'testing',
    label: 'Testing',
    help:
      'Run typecheck or lint and the tests as host checks after a turn. Auto runs only when code files changed. (Default: On.)',
    defaultValue: 'on'
  },
  {
    key: 'reviewing',
    label: 'Reviewing',
    help:
      'Spawn a read-only review subagent using the selected model after a turn. Auto runs only when code files changed. Advisory; never edits or blocks Keep. (Default: Auto.)',
    defaultValue: 'auto'
  },
  {
    key: 'styling',
    label: 'Styling check',
    help:
      'Spawn a read-only styling subagent using the selected model to compare frontend work with other pages, shared controls, and design tokens. Explicit user style requests take precedence. Auto and On both require a frontend file change. (Default: Auto.)',
    defaultValue: 'auto'
  },
  {
    key: 'doubleCheck',
    label: 'Double-check',
    help:
      'Sweep changed files for VS Code errors as a host check after a turn. Auto runs only when code files changed. No second model call. (Default: Auto.)',
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
  const dictation = values.dictation === false ? 'Off' : 'On';
  return `Effective policy: ${joinNatural(roles)}. Quick bypass always applies; ${quick}; dictation ${dictation}.`;
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
