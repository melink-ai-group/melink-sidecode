import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODES, GIT_SAFETY, isDefaultMode, modeDescriptor, modeInstructions } from './modes.ts';
import {
  backendSupportsMode,
  effectivePermissionLevel,
  modeEnforcement,
  modeForcesReadOnly,
  modeRefusesTools,
  supportedModes
} from './modes.ts';

test('every offered mode has a descriptor and is recognised', () => {
  for (const mode of DEFAULT_MODES) {
    assert.equal(modeDescriptor(mode).mode, mode);
    assert.ok(isDefaultMode(mode));
  }
  assert.deepEqual([...DEFAULT_MODES], ['agent', 'plan', 'ask']);
});

test('agent and plan carry the engineering definition of done', () => {
  const agent = modeInstructions('agent') ?? '';
  const plan = modeInstructions('plan') ?? '';
  for (const text of [agent, plan]) {
    assert.match(text, /definition of done/i);
    assert.match(text, /`package\.json` scripts/);
    assert.match(text, /README or contributor docs/);
    assert.match(text, /lint/);
    assert.match(text, /typecheck/);
    assert.match(text, /test/);
    assert.match(text, /run\/dev/);
    assert.match(text, /never assume another repository/i);
  }
  // Agent runs the checks and reports each result before it closes.
  assert.match(agent, /run every applicable check/i);
  assert.match(agent, /console, runtime, and network errors/i);
  assert.match(agent, /report each check\u2019s result or failure before your closing sentence/i);
  assert.match(agent, /never claim a check passed without running it/i);
  // Plan names verification and puts it in the plan, without running it.
  assert.match(plan, /name the verification commands this plan depends on/i);
  assert.match(plan, /include verification with its expected result/i);
  assert.match(plan, /do not run those commands while planning/i);
  assert.match(plan, /do not implement the plan/i);
});

test('ask is answer-only and carries no engineering definition of done', () => {
  const ask = modeInstructions('ask') ?? '';
  assert.match(ask, /do not run commands/i);
  assert.doesNotMatch(ask, /definition of done/i);
  assert.doesNotMatch(ask, /run\s+(the\s+)?(lint|typecheck|tests?)/i);
  assert.doesNotMatch(ask, /`package\.json`/);
  assert.doesNotMatch(ask, /console, runtime, and network errors/i);
});

test('every mode carries the shared plan-document contract', () => {
  const agent = modeInstructions('agent') ?? '';
  const plan = modeInstructions('plan') ?? '';
  const ask = modeInstructions('ask') ?? '';
  assert.match(agent, /checkbox/i);
  assert.match(agent, /do not rewrite the plan prose/i);
  assert.match(agent, /do not stop to ask whether to continue/i);
  assert.match(plan, /## Steps/);
  assert.match(plan, /unless the user asked you to update or revise it/i);
  assert.match(plan, /when the user answers your questions, rewrite/i);
  assert.match(ask, /do not run commands/i);
  assert.match(ask, /write or revise the plan/i);
  assert.match(agent, /sidecode-question/);
  assert.match(plan, /sidecode-question/);
  assert.match(plan, /do not write the plan yet/i);
  assert.match(ask, /do not emit a sidecode-question/i);
  for (const text of [agent, plan, ask]) {
    assert.match(text, /header row/);
    assert.match(text, /last thing the user reads/);
    assert.match(text, /Want me to/);
  }
  for (const text of [agent, plan]) {
    assert.match(text, /\.melink\/plans\//);
    assert.match(text, /\.melink\/reports\//);
    assert.match(text, /Do not create or write those files in `docs\/` or `reports\/`/);
    assert.match(text, /Do not create a plan file yourself/);
    assert.match(text, /never name a plan after a thread id or uuid/);
  }
  assert.equal(ask.includes('.melink/plans/'), false);
});

test('agent and plan carry the one shared git-safety rule', () => {
  const agent = modeInstructions('agent') ?? '';
  const plan = modeInstructions('plan') ?? '';
  const ask = modeInstructions('ask') ?? '';

  assert.ok(GIT_SAFETY.trim().length > 0);
  // The rule is interpolated once, not copy-pasted per mode.
  assert.equal(agent.split(GIT_SAFETY).length - 1, 1);
  assert.equal(plan.split(GIT_SAFETY).length - 1, 1);
  assert.equal(ask.includes(GIT_SAFETY), false);

  for (const text of [agent, plan]) {
    for (const verb of ['git commit', 'git push', 'git reset', 'git clean']) {
      assert.ok(text.includes(verb), `${verb} must be forbidden`);
    }
    assert.match(text, /explicitly requested that exact action in this conversation/i);
    assert.match(text, /general request such as "fix the bug" or "clean this up" is not permission/i);

    assert.match(text, /ANY git write/i);
    for (const write of [
      'git add',
      'git checkout -f',
      'git rebase',
      'git tag',
      'git branch -D',
      'git stash drop',
      'force push'
    ]) {
      assert.ok(text.includes(write), `${write} must require approval`);
    }
    assert.ok(text.includes('state the exact command and ask for the user\u2019s approval'));

    for (const read of ['git status', 'git diff', 'git log', 'git show']) {
      assert.ok(text.includes(read), `${read} must be allowed`);
    }
    assert.match(text, /Read-only git/i);
    assert.match(text, /needs no extra approval/i);

    assert.match(text, /Never use git to undo or bypass/i);
    assert.match(text, /Keep, Reject, or checkpoint/i);
  }
});

test('ask does not carry git-safety instructions', () => {
  const ask = modeInstructions('ask') ?? '';
  assert.match(ask, /Do not run commands/);
  assert.equal(ask.includes('Git safety'), false);
  assert.equal(ask.includes('git commit'), false);
  assert.equal(ask.includes('git push'), false);
});

test('an unknown mode degrades to the agent default', () => {
  assert.equal(isDefaultMode('not-a-mode'), false);
  assert.equal(modeDescriptor('not-a-mode' as never).mode, 'agent');
  assert.equal(modeInstructions('not-a-mode' as never), modeInstructions('agent'));
});

test('plan and agent honor permission levels; ask enforces read-only', () => {
  assert.equal(modeEnforcement('agent'), 'act');
  assert.equal(modeEnforcement('plan'), 'act');
  assert.equal(modeEnforcement('ask'), 'answer-only');
  assert.equal(modeForcesReadOnly('agent'), false);
  assert.equal(modeForcesReadOnly('plan'), false);
  assert.equal(modeForcesReadOnly('ask'), true);
});

test('only ask refuses tools outright', () => {
  assert.equal(modeRefusesTools('agent'), false);
  assert.equal(modeRefusesTools('plan'), false);
  assert.equal(modeRefusesTools('ask'), true);
});

test('ask narrows the selected level; plan and agent honor it', () => {
  assert.equal(effectivePermissionLevel('plan', 'unrestricted'), 'unrestricted');
  assert.equal(effectivePermissionLevel('ask', 'default'), 'read-only');
  // Agent is untouched: the selected level applies.
  assert.equal(effectivePermissionLevel('agent', 'unrestricted'), 'unrestricted');
  assert.equal(effectivePermissionLevel('agent', 'read-only'), 'read-only');
  assert.equal(effectivePermissionLevel('plan', 'default'), 'default');
});

test('supported modes are filtered to the shared set, in presentation order', () => {
  assert.deepEqual([...supportedModes(['ask', 'agent'])], ['agent', 'ask']);
  assert.deepEqual([...supportedModes([])], []);
  assert.equal(backendSupportsMode(['agent', 'plan'], 'plan'), true);
  assert.equal(backendSupportsMode(['agent'], 'plan'), false);
  assert.equal(backendSupportsMode([], 'agent'), false);
});
