import test from 'node:test';
import assert from 'node:assert/strict';
import { planTurn, type TurnPlanInput } from './plan.ts';
import { resolveOrchestrationSettings, type OrchestrationToggles } from './settings.ts';

const ALL_ON: OrchestrationToggles = {
  testing: true,
  reviewing: true,
  doubleCheck: true,
  quickTask: true,
  planning: true
};

function input(overrides: Partial<TurnPlanInput> = {}): TurnPlanInput {
  return {
    text: 'Add a provider',
    mode: 'agent',
    origin: 'user',
    hasAttachments: false,
    hasActivePlan: false,
    settings: { ...ALL_ON },
    ...overrides
  };
}

test('a non-quick Agent turn runs every enabled pass', () => {
  assert.deepEqual(planTurn(input()), {
    quick: false,
    quickReason: 'action-verb',
    testing: true,
    reviewing: true,
    doubleCheck: true,
    planning: true
  });
});

test('a quick turn disables every pass', () => {
  const plan = planTurn(input({ text: 'What does registry.probe do?' }));
  assert.equal(plan.quick, true);
  assert.equal(plan.quickReason, 'quick');
  assert.equal(plan.testing, false);
  assert.equal(plan.reviewing, false);
  assert.equal(plan.doubleCheck, false);
  assert.equal(plan.planning, false);
});

test('each gate is its toggle AND not quick', () => {
  for (const key of ['testing', 'reviewing', 'doubleCheck', 'planning'] as const) {
    const plan = planTurn(input({ settings: { ...ALL_ON, [key]: false } }));
    assert.equal(plan[key], false, key);
    for (const other of ['testing', 'reviewing', 'doubleCheck', 'planning'] as const) {
      if (other !== key) {
        assert.equal(plan[other], true, `${key} off must not change ${other}`);
      }
    }
  }
});

test('planning stays off outside Agent mode while the other passes still run', () => {
  for (const mode of ['ask', 'plan']) {
    const plan = planTurn(input({ mode }));
    assert.equal(plan.quick, false, mode);
    assert.equal(plan.planning, false, mode);
    assert.equal(plan.testing, true, mode);
    assert.equal(plan.reviewing, true, mode);
    assert.equal(plan.doubleCheck, true, mode);
  }
});

test('a fresh profile resolves testing off, so the plan gate starts closed', () => {
  const plan = planTurn(input({ settings: resolveOrchestrationSettings({}) }));
  assert.equal(plan.testing, false);
  assert.equal(plan.doubleCheck, true);
  assert.equal(plan.reviewing, false);
});

test('quick detection disabled means the gates stay on', () => {
  const plan = planTurn(
    input({
      text: 'What does registry.probe do?',
      settings: { ...ALL_ON, quickTask: false }
    })
  );
  assert.equal(plan.quick, false);
  assert.equal(plan.quickReason, 'quick-task-disabled');
  assert.equal(plan.testing, true);
  assert.equal(plan.reviewing, true);
  assert.equal(plan.doubleCheck, true);
  assert.equal(plan.planning, true);
});

test('quick tasks is inert when every pass it could skip is off', () => {
  const plan = planTurn(
    input({
      text: 'What does registry.probe do?',
      settings: { ...ALL_ON, testing: false, reviewing: false, doubleCheck: false }
    })
  );
  assert.equal(plan.quick, false);
  assert.equal(plan.quickReason, 'quick-task-disabled');
  assert.equal(plan.planning, true);
});

test('the quick veto reason is passed through unchanged', () => {
  const cases: Array<[Partial<TurnPlanInput>, string]> = [
    [{ text: 'What is this?', mode: 'ask' }, 'mode-not-agent'],
    [{ text: 'What is this?', origin: 'autopilot' }, 'origin-not-user'],
    [{ text: 'What is this?', hasAttachments: true }, 'attachments'],
    [{ text: 'What is this?', hasActivePlan: true }, 'active-plan'],
    [{ text: 'What is this?' }, 'quick']
  ];
  for (const [overrides, reason] of cases) {
    assert.equal(planTurn(input(overrides)).quickReason, reason);
  }
});
