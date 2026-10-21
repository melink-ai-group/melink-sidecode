import test from 'node:test';
import assert from 'node:assert/strict';
import { planTurnEnd, runTurnEnd } from './turnEnd.ts';
import type { TurnPlan } from './plan.ts';
import type { OrchestrationToggles } from './settings.ts';

const SETTINGS: Pick<OrchestrationToggles, 'planning'> = { planning: true };

function plan(overrides: Partial<TurnPlan> = {}): TurnPlan {
  return {
    quick: false,
    quickReason: 'not-question',
    testing: true,
    reviewing: false,
    doubleCheck: true,
    planning: true,
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
  await runTurnEnd({ mode: 'agent', settings: { planning: false } }, off.seams);
  assert.deepEqual(off.calls, ['settle']);

  const on = seams();
  await runTurnEnd({ mode: 'agent', settings: { planning: true } }, on.seams);
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
