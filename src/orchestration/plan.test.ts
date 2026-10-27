import test from 'node:test';
import assert from 'node:assert/strict';
import {
  changeRelevance,
  orchestrationDiagnostic,
  orchestrationTurnSnapshot,
  planTurn,
  resolvePostTurnRoles,
  type TurnPlanInput
} from './plan.ts';
import type { OrchestrationChoices } from './settings.ts';

const ALL_ON: OrchestrationChoices = {
  testing: 'on',
  reviewing: 'on',
  styling: 'on',
  doubleCheck: 'on',
  quickTask: 'on',
  planning: 'on'
};

const ALL_AUTO: OrchestrationChoices = {
  testing: 'auto',
  reviewing: 'auto',
  styling: 'auto',
  doubleCheck: 'auto',
  quickTask: 'auto',
  planning: 'auto'
};

const ALL_OFF: OrchestrationChoices = {
  testing: 'off',
  reviewing: 'off',
  styling: 'off',
  doubleCheck: 'off',
  quickTask: 'off',
  planning: 'off'
};

const CODE = [{ path: 'src/backends/registry.ts' }];
const DOCS = [{ path: 'README.md' }];
const FRONTEND = [{ path: 'src/webview/App.tsx' }];

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

test('an Agent turn stores the choices and the potential roles', () => {
  const plan = planTurn(input({ hasActivePlan: true }));
  assert.equal(plan.quick, false);
  assert.equal(plan.quickReason, 'active-plan');
  assert.equal(plan.quickBypass, false);
  assert.equal(plan.quickNotice, false);
  assert.deepEqual(plan.choices, ALL_ON);
  assert.equal(plan.testing, true);
  assert.equal(plan.reviewing, true);
  assert.equal(plan.styling, true);
  assert.equal(plan.doubleCheck, true);
  assert.equal(plan.planning, true);
  assert.equal(plan.reasons.testing, 'on-pending-change-set');
  assert.equal(plan.reasons.planning, 'on-agent-plan');
});

test('explicit quick send bypasses every role even with an active plan and attachments', () => {
  const plan = planTurn(input({ quick: true, hasActivePlan: true, hasAttachments: true }));
  assert.equal(plan.quickReason, 'user-requested');
  assert.equal(plan.quickBypass, true);
  for (const role of ['testing', 'reviewing', 'styling', 'doubleCheck', 'planning'] as const) {
    assert.equal(plan[role], false);
  }
  const roles = resolvePostTurnRoles({ choices: ALL_ON, quick: plan.quick, entries: FRONTEND });
  assert.equal(roles.testing, false);
  assert.equal(roles.reviewing, false);
  assert.equal(roles.styling, false);
  assert.equal(roles.doubleCheck, false);
  assert.equal(planTurn(input({ quick: true, origin: 'autopilot' })).quickBypass, false);
});

test('Off removes a role from the plan and On/Auto keep it potential', () => {
  const plan = planTurn(input({ settings: { ...ALL_ON, reviewing: 'off' } }));
  assert.equal(plan.reviewing, false);
  assert.equal(plan.reasons.reviewing, 'off');
  assert.equal(plan.testing, true);
  assert.equal(plan.reasons.testing, 'on-pending-change-set');

  const auto = planTurn(input({ settings: ALL_AUTO }));
  assert.equal(auto.testing, true);
  assert.equal(auto.reasons.testing, 'auto-pending-change-set');
});

test('quick detection always runs and bypasses every role even with quickTask Off', () => {
  const plan = planTurn(
    input({
      text: 'What does registry.probe do?',
      settings: { ...ALL_ON, quickTask: 'off' }
    })
  );
  assert.equal(plan.quick, true);
  assert.equal(plan.quickBypass, true);
  assert.equal(plan.quickNotice, false);
  assert.equal(plan.quickReason, 'quick');
  assert.equal(plan.testing, false);
  assert.equal(plan.reviewing, false);
  assert.equal(plan.styling, false);
  assert.equal(plan.doubleCheck, false);
  assert.equal(plan.planning, false);
  assert.equal(plan.reasons.testing, 'quick-bypass');

  const roles = resolvePostTurnRoles({ choices: plan.choices, quick: plan.quick, entries: CODE });
  assert.deepEqual(
    [roles.testing, roles.reviewing, roles.styling, roles.doubleCheck],
    [false, false, false, false]
  );
  assert.equal(roles.reasons.testing, 'quick-bypass');
});

test('quickTask Auto or On surfaces the Quick notice without changing the bypass', () => {
  for (const quickTask of ['auto', 'on'] as const) {
    const plan = planTurn(
      input({
        text: 'What does registry.probe do?',
        settings: { ...ALL_ON, quickTask }
      })
    );
    assert.equal(plan.quick, true, quickTask);
    assert.equal(plan.quickBypass, true, quickTask);
    assert.equal(plan.quickNotice, true, quickTask);
    assert.equal(plan.reviewing, false, quickTask);
  }
});

test('Off never runs a post-turn role, even on a code change', () => {
  const roles = resolvePostTurnRoles({ choices: ALL_OFF, quick: false, entries: CODE });
  assert.deepEqual(
    [roles.testing, roles.reviewing, roles.styling, roles.doubleCheck],
    [false, false, false, false]
  );
  assert.equal(roles.reasons.reviewing, 'off');
});

test('On runs on any closed change set; styling still needs a frontend file', () => {
  const docs = resolvePostTurnRoles({ choices: ALL_ON, quick: false, entries: DOCS });
  assert.equal(docs.testing, true);
  assert.equal(docs.reviewing, true);
  assert.equal(docs.doubleCheck, true);
  assert.equal(docs.styling, false);
  assert.equal(docs.reasons.styling, 'no-frontend-change');

  const backend = resolvePostTurnRoles({ choices: ALL_ON, quick: false, entries: CODE });
  assert.equal(backend.styling, false);

  const frontend = resolvePostTurnRoles({ choices: ALL_ON, quick: false, entries: FRONTEND });
  assert.equal(frontend.styling, true);
  assert.equal(frontend.reasons.styling, 'on-frontend-change');
  const interrupted = resolvePostTurnRoles({ choices: ALL_ON, quick: false, entries: FRONTEND, mode: 'agent', terminus: 'interrupted' });
  for (const role of ['testing', 'reviewing', 'styling', 'doubleCheck'] as const) {
    assert.equal(interrupted[role], false);
    assert.equal(interrupted.reasons[role], 'turn-interrupted');
  }
  const planning = resolvePostTurnRoles({ choices: ALL_ON, quick: false, entries: FRONTEND, mode: 'plan', terminus: 'completed' });
  assert.equal(planning.reviewing, false);
  assert.equal(planning.styling, false);
  assert.equal(planning.reasons.styling, 'mode-not-agent');
});

test('Auto runs testing, reviewing and double-check only for code changes', () => {
  const code = resolvePostTurnRoles({ choices: ALL_AUTO, quick: false, entries: CODE });
  assert.deepEqual(
    [code.testing, code.reviewing, code.doubleCheck],
    [true, true, true]
  );
  assert.equal(code.reasons.testing, 'auto-code-change');

  const docs = resolvePostTurnRoles({ choices: ALL_AUTO, quick: false, entries: DOCS });
  assert.deepEqual(
    [docs.testing, docs.reviewing, docs.doubleCheck],
    [false, false, false]
  );
  assert.equal(docs.reasons.testing, 'docs-only');
});

test('Auto styling needs a frontend file, not just any file', () => {
  assert.equal(resolvePostTurnRoles({ choices: ALL_AUTO, quick: false, entries: CODE }).styling, false);
  assert.equal(resolvePostTurnRoles({ choices: ALL_AUTO, quick: false, entries: DOCS }).styling, false);
  const frontend = resolvePostTurnRoles({ choices: ALL_AUTO, quick: false, entries: FRONTEND });
  assert.equal(frontend.styling, true);
  assert.equal(frontend.reasons.styling, 'auto-frontend-change');
});

test('an empty change set runs no post-turn role', () => {
  for (const choices of [ALL_ON, ALL_AUTO]) {
    const roles = resolvePostTurnRoles({ choices, quick: false, entries: [] });
    assert.deepEqual(
      [roles.testing, roles.reviewing, roles.styling, roles.doubleCheck],
      [false, false, false, false]
    );
    assert.equal(roles.reasons.testing, 'no-change-set');
  }
});

test('planning resolves at plan time: Agent mode and an active plan are required', () => {
  const autoAgent = planTurn(input({ settings: ALL_AUTO, hasActivePlan: true }));
  assert.equal(autoAgent.planning, true);
  assert.equal(autoAgent.reasons.planning, 'auto-agent-plan');

  const onAgent = planTurn(input({ settings: ALL_ON, hasActivePlan: true }));
  assert.equal(onAgent.planning, true);

  const noPlan = planTurn(input({ settings: ALL_AUTO, hasActivePlan: false }));
  assert.equal(noPlan.planning, false);
  assert.equal(noPlan.reasons.planning, 'no-active-plan');

  const off = planTurn(input({ settings: ALL_OFF, hasActivePlan: true }));
  assert.equal(off.planning, false);
  assert.equal(off.reasons.planning, 'off');

  for (const mode of ['ask', 'plan']) {
    const notAgent = planTurn(input({ mode, settings: ALL_AUTO, hasActivePlan: true }));
    assert.equal(notAgent.planning, false, mode);
    assert.equal(notAgent.reasons.planning, 'mode-not-agent', mode);
    assert.equal(notAgent.reviewing, true, mode);
  }
});

test('change relevance separates documentation, code and frontend files', () => {
  assert.deepEqual(changeRelevance([]), {
    hasChanges: false,
    codeChanged: false,
    frontendChanged: false
  });
  assert.deepEqual(changeRelevance(DOCS), {
    hasChanges: true,
    codeChanged: false,
    frontendChanged: false
  });
  assert.deepEqual(changeRelevance(FRONTEND), {
    hasChanges: true,
    codeChanged: true,
    frontendChanged: true
  });
  const mixed = changeRelevance([...DOCS, ...CODE]);
  assert.equal(mixed.codeChanged, true);
  assert.equal(mixed.frontendChanged, false);
});

test('the diagnostic names the resolved roles without file text', () => {
  const plan = planTurn(input({ settings: ALL_AUTO }));
  const roles = resolvePostTurnRoles({ choices: plan.choices, quick: plan.quick, entries: DOCS });
  const line = orchestrationDiagnostic(plan, roles);
  assert.match(line, /turn=normal/);
  assert.match(line, /quickBypass=false/);
  assert.match(line, /quickNotice=false/);
  assert.match(line, /quickReason=action-verb/);
  assert.match(line, /choices=testing:auto,reviewing:auto,styling:auto,doubleCheck:auto,quickTask:auto,planning:auto/);
  assert.match(line, /planning=skip\(no-active-plan\)/);
  assert.match(line, /testing=skip\(docs-only\)/);
  assert.match(line, /styling=skip\(docs-only\)|styling=skip\(no-frontend-change\)/);
  assert.equal(line.includes('README.md'), false);
});

test('the debug snapshot carries the choices and the resolved roles', () => {
  const plan = planTurn(input({ settings: ALL_AUTO }));
  const roles = resolvePostTurnRoles({ choices: plan.choices, quick: plan.quick, entries: CODE });
  const snapshot = orchestrationTurnSnapshot(plan, roles, {
    backendId: 'codex',
    threadId: 'thread-1',
    turnId: 'turn-1'
  });
  assert.equal(snapshot.backendId, 'codex');
  assert.equal(snapshot.turnId, 'turn-1');
  assert.deepEqual(snapshot.choices, plan.choices);
  assert.deepEqual(snapshot.roles, {
    testing: true,
    reviewing: true,
    styling: false,
    doubleCheck: true,
    planning: false
  });
  assert.match(snapshot.reasons.testing ?? '', /auto-code-change/);
  assert.match(snapshot.reasons.styling ?? '', /no-frontend-change/);
  assert.match(snapshot.reasons.planning ?? '', /no-active-plan/);
  // The snapshot is a copy: mutating it cannot change the plan the turn used.
  snapshot.choices.testing = 'off';
  assert.equal(plan.choices.testing, 'auto');
  assert.equal(JSON.stringify(snapshot).includes('src/backends/registry.ts'), false);
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
