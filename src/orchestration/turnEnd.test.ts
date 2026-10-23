import test from 'node:test';
import assert from 'node:assert/strict';
import { planTurnEnd, runTurnEnd } from './turnEnd.ts';
import type { TurnPlan } from './plan.ts';
import type { OrchestrationChoices } from './settings.ts';

const SETTINGS: Pick<OrchestrationChoices, 'planning'> = { planning: 'on' };

function plan(overrides: Partial<TurnPlan> = {}): TurnPlan {
  return {
    choices: {
      testing: 'on',
      reviewing: 'off',
      styling: 'off',
      doubleCheck: 'on',
      quickTask: 'off',
      planning: 'on'
    },
    quick: false,
    quickReason: 'not-question',
    quickBypass: false,
    quickNotice: false,
    testing: true,
    reviewing: false,
    styling: false,
    doubleCheck: true,
    planning: true,
    reasons: {},
    ...overrides
  };
}

function seams(current = true): {
  calls: string[];
  seams: {
    settle: () => void;
    isStillCurrent: () => boolean;
    continue: () => void;
  };
} {
  const calls: string[] = [];
  return {
    calls,
    seams: {
      settle: () => {
        calls.push('settle');
      },
      isStillCurrent: () => current,
      continue: () => {
        calls.push('continue');
      }
    }
  };
}

test('planning off still runs the settle and never continues', async () => {
  const spy = seams();
  await runTurnEnd(
    { mode: 'agent', plan: plan({ planning: false }), settings: SETTINGS },
    spy.seams
  );
  assert.deepEqual(spy.calls, ['settle']);
});

test('a quick turn settles its step without continuing the plan', async () => {
  const spy = seams();
  await runTurnEnd(
    {
      mode: 'agent',
      plan: plan({ quick: true, quickReason: 'quick', planning: false }),
      settings: SETTINGS
    },
    spy.seams
  );
  assert.deepEqual(spy.calls, ['settle']);
});

test('planning on settles first and then continues', async () => {
  const spy = seams();
  await runTurnEnd({ mode: 'agent', plan: plan(), settings: SETTINGS }, spy.seams);
  assert.deepEqual(spy.calls, ['settle', 'continue']);
});

test('a stale chat settles but does not continue', async () => {
  const spy = seams(false);
  await runTurnEnd({ mode: 'agent', plan: plan(), settings: SETTINGS }, spy.seams);
  assert.deepEqual(spy.calls, ['settle']);
});

test('a missing plan falls back to the resolved policy for continuation', async () => {
  const off = seams();
  await runTurnEnd({ mode: 'agent', settings: { planning: 'off' } }, off.seams);
  assert.deepEqual(off.calls, ['settle']);

  const on = seams();
  await runTurnEnd({ mode: 'agent', settings: { planning: 'auto' } }, on.seams);
  assert.deepEqual(on.calls, ['settle', 'continue']);
});

test('the decision itself is pure and never calls a seam', () => {
  assert.deepEqual(planTurnEnd({ mode: 'agent', plan: plan({ planning: false }), settings: SETTINGS }), {
    settlePlanProgress: true,
    continuePlan: false
  });
  assert.deepEqual(planTurnEnd({ mode: 'agent', plan: plan(), settings: SETTINGS }), {
    settlePlanProgress: true,
    continuePlan: true
  });
  assert.deepEqual(planTurnEnd({ mode: 'plan', plan: plan(), settings: SETTINGS }), {
    settlePlanProgress: false,
    continuePlan: false
  });
});

