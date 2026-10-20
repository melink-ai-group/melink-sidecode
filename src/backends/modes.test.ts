import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODES, isDefaultMode, modeDescriptor, modeInstructions } from './modes.ts';
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
