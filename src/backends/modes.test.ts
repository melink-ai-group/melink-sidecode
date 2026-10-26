import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPLETION_CONTRACT, DEFAULT_MODES, GIT_SAFETY, isDefaultMode, modeDescriptor, modeInstructions } from './modes.ts';
import {
  backendSupportsMode,
  effectivePermissionLevel,
  modeEnforcement,
  modeForcesReadOnly,
  modeInstructionsForTurn,
  modeRefusesTools,
  modeSwitchInstructions,
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
    // Applies even without a detected framework (plain HTML/CSS, for example).
    assert.match(text, /inspect comparable controls on other existing pages/i);
    assert.match(text, /buttons, inputs, checkboxes, textareas, selects/i);
    assert.match(text, /reuse established components, variants, and design tokens/i);
    assert.match(text, /Before finishing, compare the changed UI/i);
    assert.match(text, /user explicitly requests a specific style, redesign, or other departure/i);
    assert.match(text, /for its stated scope and preserve existing consistency elsewhere/i);
    assert.match(text, /If no comparable page exists/i);
    assert.match(text, /do not invent a reference or restyle unrelated pages/i);
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
  assert.doesNotMatch(modeInstructions('ask') ?? '', /Styling consistency:/);
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
  assert.match(agent, /answer is skipped or omitted/i);
  assert.match(plan, /do not assume an answer/i);
  assert.match(agent, /least-destructive option/i);
  assert.match(plan, /state the assumption/i);
  assert.equal(ask.includes('least-destructive'), false);
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
    assert.match(text, /put it under `\.melink\/reports\/` by default/i);
    assert.match(text, /explicitly asks for a specific path in this project/i);
    assert.match(text, /`reports\/T121-scout\.md`/);
    assert.match(text, /without such a request, do not write generated documents into `reports\/` or `docs\/`/i);
    assert.match(text, /do not create a `docs\/` file unless the user asks/i);
    assert.match(text, /Do not create a plan file yourself/);
    assert.match(text, /never name a plan after a thread id or uuid/);
  }
  assert.equal(ask.includes('.melink/plans/'), false);
});

test('agent carries the completion contract and no other mode does', () => {
  const agent = modeInstructions('agent') ?? '';
  const plan = modeInstructions('plan') ?? '';
  const ask = modeInstructions('ask') ?? '';

  assert.ok(COMPLETION_CONTRACT.trim().length > 0);
  // Interpolated once, not copy-pasted, and appended only to Agent.
  assert.equal(agent.split(COMPLETION_CONTRACT).length - 1, 1);
  assert.equal(plan.includes(COMPLETION_CONTRACT), false);
  assert.equal(ask.includes(COMPLETION_CONTRACT), false);

  // (a) bounded inspection of related code before editing, no whole-repo scan.
  assert.match(agent, /before editing, inspect the callers and usages/i);
  assert.match(agent, /directly adjacent module or modules/i);
  assert.match(agent, /limited to what this request touches/i);
  assert.match(agent, /never scan the whole repository/i);

  // (b) re-check the same bounded areas, fix mismatches, note them before the close.
  assert.match(agent, /before finishing, re-check those same bounded areas/i);
  assert.match(agent, /fix any mismatch/i);
  assert.match(agent, /state what you checked in brief notes before the closing sentence/i);

  // (c) cover the request; keep one honest result sentence.
  assert.match(agent, /cover every part of the request/i);
  assert.match(agent, /state what remains in the single closing result sentence/i);
  assert.match(agent, /never call the work finished while a named step is open/i);

  // (d) reuse same-chat decisions and delegate unreadable or skipped answers.
  assert.match(agent, /reuse decisions and conventions already established in this chat/i);
  assert.match(agent, /do not re-ask answered questions/i);
  assert.match(agent, /ask only when the answer cannot be read from the workspace, transcript, or provided context/i);
  assert.match(agent, /defer skipped or unanswered answers to the question block/i);
  assert.match(agent, /ask a genuinely ambiguous new decision when needed/i);

  // The existing question block and single close keep their own form.
  assert.match(agent, /sidecode-question/);
  assert.match(agent, /last thing the user reads/);
});

test('the completion contract is the only no-reask rule and does not restate the definition of done', () => {
  const agent = modeInstructions('agent') ?? '';
  const oldSentence = 'Ask only when you cannot look the answer up yourself';

  assert.equal(agent.includes(oldSentence), false);
  assert.equal(agent.match(/ask only when/gi)?.length, 1);
  assert.equal(COMPLETION_CONTRACT.match(/definition of done/gi)?.length, 1);
  assert.equal(agent.match(/never claim a check passed/gi)?.length, 1);
  assert.equal(COMPLETION_CONTRACT.includes('package.json'), false);
  assert.equal(COMPLETION_CONTRACT.includes('never claim'), false);
});

test('plan is outside the completion contract by scope, not read-only safety', () => {
  const plan = modeInstructions('plan') ?? '';
  assert.equal(plan.includes('Completion contract'), false);
  assert.equal(plan.includes('brief notes before the closing sentence'), false);
  // Plan still acts at the caller-selected level; unchanged here for scope only.
  assert.equal(modeEnforcement('plan'), 'act');
  assert.equal(modeForcesReadOnly('plan'), false);
  assert.equal(effectivePermissionLevel('plan', 'unrestricted'), 'unrestricted');
  assert.match(plan, /do not implement the plan/i);
});

test('ask carries none of the completion contract', () => {
  const ask = modeInstructions('ask') ?? '';
  assert.equal(ask.includes('Completion contract'), false);
  for (const clause of [
    /callers and usages/i,
    /directly adjacent module/i,
    /re-check those same bounded areas/i,
    /cover every part of the request/i,
    /reuse decisions and conventions/i,
    /do not re-ask answered questions/i,
    /defer skipped or unanswered answers/i
  ]) {
    assert.doesNotMatch(ask, clause);
  }
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

test('Agent and Plan append the frontend checklist for a detected stack', () => {
  for (const stack of ['react', 'next', 'vue'] as const) {
    for (const mode of ['agent', 'plan'] as const) {
      const base = modeDescriptor(mode).developerInstructions ?? '';
      const text = modeInstructions(mode, stack) ?? '';
      assert.ok(text.startsWith(base), `${mode}/${stack} must keep the base text intact`);
      assert.match(text, /Frontend checklist/);
      assert.ok(text.length > base.length);
    }
  }
  assert.match(modeInstructions('agent', 'next')!, /hydration/i);
  assert.match(modeInstructions('plan', 'vue')!, /v-for/i);
});

test('Ask never receives the frontend checklist, even for a frontend stack', () => {
  const base = modeDescriptor('ask').developerInstructions;
  assert.equal(modeInstructions('ask', 'react'), base);
  assert.equal(modeInstructions('ask', 'next'), base);
  assert.doesNotMatch(modeInstructions('ask', 'react') ?? '', /Frontend checklist/);
});

test('a non-frontend project leaves the base instructions unchanged', () => {
  for (const mode of DEFAULT_MODES) {
    assert.equal(modeInstructions(mode, 'none'), modeDescriptor(mode).developerInstructions);
  }
  assert.equal(modeInstructions('agent'), modeDescriptor('agent').developerInstructions);
});

test('an unknown mode degrades to the agent default', () => {
  assert.equal(isDefaultMode('not-a-mode'), false);
  assert.equal(modeDescriptor('not-a-mode' as never).mode, 'agent');
  assert.equal(modeInstructions('not-a-mode' as never), modeInstructions('agent'));
});

test('a mode switch revokes the previous mode for every provider', () => {
  const revocation = modeSwitchInstructions('plan', 'agent');
  assert.match(revocation, /required Plan mode is revoked/);
  assert.match(revocation, /no longer applies/);
  assert.match(revocation, /every earlier mode instruction is retired/);
  assert.match(revocation, /Follow only the mode described next: Agent mode/);
  assert.match(revocation, /active developer instruction for this turn is Agent mode/);

  const switched = modeInstructionsForTurn('agent', 'plan') ?? '';
  assert.ok(switched.startsWith(revocation));
  assert.ok(switched.endsWith(modeInstructions('agent') ?? ''));
  assert.equal(switched.split(revocation).length - 1, 1);

  const same = modeInstructionsForTurn('agent', 'agent') ?? '';
  assert.equal(same, modeInstructions('agent'));
  assert.equal(same.includes('is revoked'), false);

  const first = modeInstructionsForTurn('ask') ?? '';
  assert.equal(first, modeInstructions('ask'));
  assert.equal(first.includes('is revoked'), false);
});

test('a revoked switch keeps the frontend checklist for the new mode', () => {
  const switched = modeInstructionsForTurn('agent', 'ask', 'react') ?? '';
  assert.match(switched, /required Ask mode is revoked/);
  assert.match(switched, /Follow only the mode described next: Agent mode/);
  assert.match(switched, /Frontend checklist/);
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
