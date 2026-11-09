import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_EXPLANATION,
  ORCHESTRATION_FIELDS,
  ORCHESTRATION_INTRO,
  ORCHESTRATION_TITLE,
  orchestrationFieldHelp,
  orchestrationSummary,
  type OrchestrationCopyValues
} from './orchestrationCopy.ts';

const DEFAULTS: OrchestrationCopyValues = {
  testing: 'on',
  reviewing: 'auto',
  styling: 'auto',
  doubleCheck: 'auto',
  quickTask: 'off',
  planning: 'auto'
};

function values(overrides: Partial<OrchestrationCopyValues> = {}): OrchestrationCopyValues {
  return { ...DEFAULTS, ...overrides };
}

test('title, intro and the Auto explanation are the documented copy', () => {
  assert.equal(ORCHESTRATION_TITLE, 'Orchestration');
  assert.equal(ORCHESTRATION_INTRO, 'Changes apply from the next turn.');
  assert.equal(
    AUTO_EXPLANATION,
    'Auto runs a pass only when this turn is relevant; On runs it whenever its mode applies; Off never runs it.'
  );
});

test('the six fields carry the exact labels, help, and defaults', () => {
  assert.deepEqual(
    ORCHESTRATION_FIELDS.map(({ key, label, defaultValue }) => [key, label, defaultValue]),
    [
      ['testing', 'Testing', 'on'],
      ['reviewing', 'Reviewing', 'auto'],
      ['styling', 'Styling check', 'auto'],
      ['doubleCheck', 'Double-check', 'auto'],
      ['quickTask', 'Quick tasks', 'off'],
      ['planning', 'Plan autopilot', 'auto']
    ]
  );
  assert.deepEqual(
    ORCHESTRATION_FIELDS.map(({ help }) => help),
    [
      'Run typecheck or lint and the tests as host checks after a turn. Auto runs only when code files changed. (Default: On.)',
      'Spawn a read-only review subagent using the selected model after a turn. Auto runs only when code files changed. Advisory; never edits or blocks Keep. (Default: Auto.)',
      'Spawn a read-only styling subagent using the selected model to compare frontend work with other pages, shared controls, and design tokens. Explicit user style requests take precedence. Auto and On both require a frontend file change. (Default: Auto.)',
      'Sweep changed files for VS Code errors as a host check after a turn. Auto runs only when code files changed. No second model call. (Default: Auto.)',
      'Short single-question Agent turns always bypass the other passes. Off hides the Quick notice; Auto or On shows it. (Default: Off.)',
      'Continue a built plan step by step after a clean turn. Agent mode and an active plan are required. (Default: Auto.)'
    ]
  );
});

test('the default summary spells out every choice and the intrinsic bypass', () => {
  assert.equal(
    orchestrationSummary(values()),
    'Effective policy: testing On, reviewing Auto, styling Auto, double-check Auto and plan autopilot Auto. Quick bypass always applies; quick notice Off; dictation On.'
  );
});

test('the summary follows every choice, including quick notice Auto', () => {
  assert.equal(
    orchestrationSummary(values({ testing: 'auto', quickTask: 'auto' })),
    'Effective policy: testing Auto, reviewing Auto, styling Auto, double-check Auto and plan autopilot Auto. Quick bypass always applies; quick notice Auto; dictation On.'
  );
  assert.equal(
    orchestrationSummary(
      values({ testing: 'off', reviewing: 'off', styling: 'off', doubleCheck: 'off', planning: 'off' })
    ),
    'Effective policy: testing Off, reviewing Off, styling Off, double-check Off and plan autopilot Off. Quick bypass always applies; quick notice Off; dictation On.'
  );
});

test('legacy sources replace the field help with the migration copy', () => {
  assert.equal(
    orchestrationFieldHelp('testing', values({ testing: 'on', legacyTesting: true })),
    'On from `melink.review.checks.enabled`; saving takes over.'
  );
  assert.equal(
    orchestrationFieldHelp('reviewing', values({ reviewing: 'on', legacyReviewing: true })),
    'On from `melink.review.diffReview`; saving takes over.'
  );
  assert.equal(
    orchestrationFieldHelp('reviewing', values({ reviewing: 'off', legacyReviewing: true })),
    'Off from `melink.review.diffReview`; saving takes over.'
  );
});

test('every field without a legacy source keeps its normal help', () => {
  assert.equal(
    orchestrationFieldHelp('quickTask', values({ testing: 'off', reviewing: 'off' })),
    'Short single-question Agent turns always bypass the other passes. Off hides the Quick notice; Auto or On shows it. (Default: Off.)'
  );
});
