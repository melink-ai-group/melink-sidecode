import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORCHESTRATION_FIELDS,
  ORCHESTRATION_INTRO,
  ORCHESTRATION_TITLE,
  QUICK_TASKS_DISABLED_HELP,
  effectiveQuickTask,
  orchestrationFieldHelp,
  orchestrationSummary,
  quickTasksAvailable,
  type OrchestrationCopyValues
} from './orchestrationCopy.ts';

const DEFAULTS: OrchestrationCopyValues = {
  testing: false,
  reviewing: false,
  doubleCheck: true,
  quickTask: true,
  planning: true
};

function values(overrides: Partial<OrchestrationCopyValues> = {}): OrchestrationCopyValues {
  return { ...DEFAULTS, ...overrides };
}

test('title and intro are the documented copy', () => {
  assert.equal(ORCHESTRATION_TITLE, 'Orchestration');
  assert.equal(ORCHESTRATION_INTRO, 'Changes apply from the next turn.');
  assert.equal(ORCHESTRATION_INTRO.includes('Per-turn helpers'), false);
});

test('the five fields carry the exact labels, help, and defaults', () => {
  assert.deepEqual(
    ORCHESTRATION_FIELDS.map(({ key, label, defaultValue }) => [key, label, defaultValue]),
    [
      ['testing', 'Testing', false],
      ['reviewing', 'Reviewing', false],
      ['doubleCheck', 'Double-check', true],
      ['quickTask', 'Quick tasks', true],
      ['planning', 'Plan autopilot', true]
    ]
  );
  assert.deepEqual(
    ORCHESTRATION_FIELDS.map(({ help }) => help),
    [
      'Run typecheck or lint and the tests after a turn that changes files. (Default: off.)',
      'Read-only diff review after a turn that changes files. Advisory; never edits or blocks Keep. (Default: off.)',
      'Sweep changed files for VS Code errors after a turn. No second model call. (Default: on.)',
      'Skip these passes for short, single-question turns in Agent mode. (Default: on.)',
      'Continue a built plan step by step after a clean turn. Agent mode only. (Default: on.)'
    ]
  );
});

test('the fresh default policy summary shows testing off', () => {
  assert.equal(
    orchestrationSummary(values()),
    'Effective policy: double-check and plan autopilot on · testing and reviewing off · quick tasks skip these passes.'
  );
});

test('summary lists every pass that is on and every pass that is off', () => {
  assert.equal(
    orchestrationSummary(values({ reviewing: true })),
    'Effective policy: reviewing, double-check and plan autopilot on · testing off · quick tasks skip these passes.'
  );
  assert.equal(
    orchestrationSummary(values({ reviewing: true, planning: false, doubleCheck: false })),
    'Effective policy: reviewing on · testing, double-check and plan autopilot off · quick tasks skip these passes.'
  );
  assert.equal(
    orchestrationSummary(values({ testing: false, reviewing: false, doubleCheck: false, planning: false })),
    'Effective policy: no post-turn passes.'
  );
});

test('the summary never claims a skip when every pass is off', () => {
  const allPassesOff = values({ testing: false, reviewing: false, doubleCheck: false });
  assert.equal(effectiveQuickTask(allPassesOff), false);
  assert.equal(
    orchestrationSummary(allPassesOff),
    'Effective policy: plan autopilot on · testing, reviewing and double-check off.'
  );
  assert.equal(orchestrationSummary(allPassesOff).includes('quick tasks skip'), false);
  assert.equal(effectiveQuickTask(values()), true);
});

test('summary drops the quick suffix when quick tasks are off', () => {
  assert.equal(
    orchestrationSummary(values({ quickTask: false })),
    'Effective policy: double-check and plan autopilot on · testing and reviewing off.'
  );
  assert.equal(
    orchestrationSummary(
      values({ quickTask: false, testing: false, reviewing: false, doubleCheck: false, planning: false })
    ),
    'Effective policy: no post-turn passes.'
  );
});

test('a single enabled pass is named without a conjunction', () => {
  assert.equal(
    orchestrationSummary(
      values({ testing: true, reviewing: false, doubleCheck: false, planning: false })
    ),
    'Effective policy: testing on · reviewing, double-check and plan autopilot off · quick tasks skip these passes.'
  );
});

test('legacy sources replace the field help with the migration copy', () => {
  assert.equal(
    orchestrationFieldHelp('testing', values({ testing: true, legacyTesting: true })),
    'On from `melink.review.checks.enabled`; saving takes over.'
  );
  assert.equal(
    orchestrationFieldHelp('reviewing', values({ reviewing: true, legacyReviewing: true })),
    'On from `melink.review.diffReview`; saving takes over.'
  );
  assert.equal(
    orchestrationFieldHelp('reviewing', values({ legacyReviewing: true })),
    'Off from `melink.review.diffReview`; saving takes over.'
  );
});

test('quick tasks is disabled with help when every pass is off', () => {
  const allPassesOff = values({ testing: false, reviewing: false, doubleCheck: false });
  assert.equal(quickTasksAvailable(allPassesOff), false);
  assert.equal(orchestrationFieldHelp('quickTask', allPassesOff), QUICK_TASKS_DISABLED_HELP);
  assert.equal(QUICK_TASKS_DISABLED_HELP, 'Enable at least one pass first.');

  assert.equal(quickTasksAvailable(values({ reviewing: true })), true);
  assert.equal(
    orchestrationFieldHelp('quickTask', values({ reviewing: true })),
    'Skip these passes for short, single-question turns in Agent mode. (Default: on.)'
  );
});
