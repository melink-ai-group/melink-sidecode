import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTENTION_LEDGER_LIMIT,
  AttentionLedger,
  attentionFollowUpText,
  attentionKey,
  decideAttention,
  type AttentionCheckFacts,
  type AttentionInput,
  type AttentionPlanFacts,
  type AttentionNotice
} from './completion.ts';

const COMMON: Omit<AttentionInput, 'trigger' | 'plan' | 'check'> = {
  mode: 'agent',
  terminus: 'completed',
  quick: false,
  sameSession: true,
  sameThread: true,
  currentTurn: true,
  pendingQuestion: false,
  pendingApproval: false
};

const PLAN: AttentionPlanFacts = {
  built: true,
  planning: true,
  remaining: 2,
  epochCurrent: true,
  hold: false,
  autopilot: 'hold'
};

const CHECK: AttentionCheckFacts = { status: 'failed' };

function planInput(
  patch: Partial<AttentionInput> = {},
  plan: Partial<AttentionPlanFacts> = {}
): AttentionInput {
  return { ...COMMON, trigger: 'plan', plan: { ...PLAN, ...plan }, ...patch };
}

function checkInput(
  patch: Partial<AttentionInput> = {},
  check: Partial<AttentionCheckFacts> = {}
): AttentionInput {
  return { ...COMMON, trigger: 'check', check: { ...CHECK, ...check }, ...patch };
}

function settle(
  ledger: AttentionLedger,
  key: string,
  notice: AttentionNotice | undefined
): AttentionNotice | undefined {
  if (!notice) {
    return undefined;
  }
  return ledger.claim(key) ? notice : undefined;
}

test('a built plan that autopilot holds posts the plan info notice', () => {
  const notice = decideAttention(planInput());
  assert.deepEqual(notice, {
    kind: 'plan-remaining',
    level: 'info',
    message: '2 plan steps still remain.',
    action: 'preparePlanFollowUp'
  });
});

test('one remaining plan step reads as a single step', () => {
  assert.equal(decideAttention(planInput({}, { remaining: 1 }))?.message, '1 plan step still remains.');
});

test('a terminal failed check posts the warning notice', () => {
  const notice = decideAttention(checkInput());
  assert.deepEqual(notice, {
    kind: 'check-failed',
    level: 'warning',
    message: 'The post-turn checks failed. See the change card for details.',
    action: 'prepareCheckFollowUp'
  });
});

test('the follow-up text is fixed and generic', () => {
  assert.equal(attentionFollowUpText('plan-remaining'), 'Continue the remaining steps of this plan.');
  assert.equal(
    attentionFollowUpText('check-failed'),
    "The post-turn checks failed. Investigate the failure, fix it, and rerun the project's checks."
  );
});

test('the ledger key carries backend, thread and turn identity', () => {
  assert.equal(attentionKey('ollama', 'thread_1', 'turn_1'), 'ollama:thread_1:turn_1');
});

const COMMON_SKIPS: Array<[string, Partial<AttentionInput>]> = [
  ['a non-Agent mode', { mode: 'plan' }],
  ['an interrupted turn', { terminus: 'interrupted' }],
  ['a Quick turn', { quick: true }],
  ['a different active session', { sameSession: false }],
  ['a different active thread', { sameThread: false }],
  ['a genuinely newer turn', { currentTurn: false }],
  ['a pending question', { pendingQuestion: true }],
  ['a pending approval', { pendingApproval: true }]
];

for (const [name, patch] of COMMON_SKIPS) {
  test(`a common skip (${name}) suppresses both triggers`, () => {
    assert.equal(decideAttention(planInput(patch)), undefined, 'plan trigger');
    assert.equal(decideAttention(checkInput(patch)), undefined, 'check trigger');
  });
}

const PLAN_SKIPS: Array<[string, Partial<AttentionPlanFacts>]> = [
  ['Planning Off', { planning: false }],
  ['a stale plan epoch', { epochCurrent: false }],
  ['no built plan', { built: false }],
  ['no remaining steps', { remaining: 0 }],
  ['a plan hold', { hold: true }],
  ['autopilot continued', { autopilot: 'continue' }]
];

for (const [name, plan] of PLAN_SKIPS) {
  test(`a plan-only skip (${name}) suppresses the plan notice only`, () => {
    assert.equal(decideAttention(planInput({}, plan)), undefined);
    assert.equal(decideAttention(checkInput())?.kind, 'check-failed');
  });
}

const CHECK_SKIPS: AttentionCheckFacts['status'][] = [
  'not-run',
  'untrusted',
  'skipped',
  'pending',
  'running',
  'passed',
  'cancelled'
];

for (const status of CHECK_SKIPS) {
  test(`a check-only status (${status}) suppresses the check notice only`, () => {
    assert.equal(decideAttention(checkInput({}, { status })), undefined);
    assert.equal(decideAttention(planInput())?.kind, 'plan-remaining');
  });
}

test('no plan and a terminal failed check still posts the check notice', () => {
  const notice = decideAttention(
    checkInput({ plan: { ...PLAN, built: false, remaining: 0, planning: false } })
  );
  assert.equal(notice?.kind, 'check-failed');
});

test('Planning Off and a terminal failed check still posts the check notice', () => {
  const notice = decideAttention(checkInput({ plan: { ...PLAN, planning: false } }));
  assert.equal(notice?.kind, 'check-failed');
});

test('a no-change, zero-work plan hold still posts the plan notice', () => {
  const notice = decideAttention(planInput({ check: { status: 'not-run' } }));
  assert.equal(notice?.kind, 'plan-remaining');
});

test('a plan hold with checks still running posts the plan notice', () => {
  const notice = decideAttention(planInput({ check: { status: 'running' } }));
  assert.equal(notice?.kind, 'plan-remaining');
});

test('the plan trigger ignores an independently failed check in the same input', () => {
  const notice = decideAttention(planInput({ check: CHECK }));
  assert.equal(notice?.kind, 'plan-remaining');
});

test('the check trigger ignores a held plan in the same input', () => {
  const notice = decideAttention(checkInput({ plan: PLAN }));
  assert.equal(notice?.kind, 'check-failed');
});

test('the ending turn may still be busy; busyness is not part of the decision', () => {
  const busyPlan = { ...planInput(), turnBusy: true, turnOpen: true } as AttentionInput;
  assert.equal(decideAttention(busyPlan)?.kind, 'plan-remaining');
  const busyCheck = { ...checkInput(), turnBusy: true, turnOpen: true } as AttentionInput;
  assert.equal(decideAttention(busyCheck)?.kind, 'check-failed');
});

test('the decision is deterministic for the same input', () => {
  assert.deepEqual(decideAttention(planInput()), decideAttention(planInput()));
  assert.deepEqual(decideAttention(checkInput()), decideAttention(checkInput()));
});

test('the decision never carries check output, a diff, or a review line', () => {
  for (const notice of [decideAttention(planInput()), decideAttention(checkInput())]) {
    assert.ok(notice);
    assert.doesNotMatch(
      notice.message,
      /stdout|stderr|^\+{3}|^-{3}|@@|localDiffReview|extractMentionedPaths/
    );
  }
});

test('plan settling first wins over a later failed check', () => {
  const ledger = new AttentionLedger();
  const key = attentionKey('ollama', 'thread_1', 'turn_1');
  const posted = [
    settle(ledger, key, decideAttention(planInput())),
    settle(ledger, key, decideAttention(checkInput()))
  ].filter((notice): notice is AttentionNotice => notice !== undefined);
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.kind, 'plan-remaining');
});

test('a failed check settling first wins over a later plan hold', () => {
  const ledger = new AttentionLedger();
  const key = attentionKey('ollama', 'thread_1', 'turn_1');
  const posted = [
    settle(ledger, key, decideAttention(checkInput())),
    settle(ledger, key, decideAttention(planInput()))
  ].filter((notice): notice is AttentionNotice => notice !== undefined);
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.kind, 'check-failed');
});

test('duplicate callbacks claim the key once', () => {
  const ledger = new AttentionLedger();
  const key = attentionKey('ollama', 'thread_1', 'turn_1');
  const notice = decideAttention(planInput());
  const posted = [
    settle(ledger, key, notice),
    settle(ledger, key, notice),
    settle(ledger, key, notice)
  ].filter((entry) => entry !== undefined);
  assert.equal(posted.length, 1);
});

test('the ledger keeps different chats apart', () => {
  const ledger = new AttentionLedger();
  assert.equal(ledger.claim(attentionKey('ollama', 'thread_1', 'turn_1')), true);
  assert.equal(ledger.claim(attentionKey('ollama', 'thread_2', 'turn_1')), true);
  assert.equal(ledger.claim(attentionKey('opencode', 'thread_1', 'turn_1')), true);
  assert.equal(ledger.claim(attentionKey('ollama', 'thread_1', 'turn_2')), true);
  assert.equal(ledger.size, 4);
});

test('the ledger is a bounded FIFO', () => {
  const ledger = new AttentionLedger();
  for (let index = 0; index < ATTENTION_LEDGER_LIMIT; index += 1) {
    assert.equal(ledger.claim(`key_${index}`), true);
  }
  assert.equal(ledger.size, ATTENTION_LEDGER_LIMIT);
  assert.equal(ledger.claim('key_new'), true);
  assert.equal(ledger.size, ATTENTION_LEDGER_LIMIT);
  assert.equal(ledger.has('key_0'), false, 'the oldest key was evicted');
  assert.equal(ledger.claim('key_1'), false, 'the next key is still inside the window');
  assert.equal(ledger.claim('key_0'), true, 'an evicted key can be claimed again');
});

test('clearing the ledger forgets every claim', () => {
  const ledger = new AttentionLedger();
  assert.equal(ledger.claim('key_1'), true);
  ledger.clear();
  assert.equal(ledger.size, 0);
  assert.equal(ledger.claim('key_1'), true);
});
