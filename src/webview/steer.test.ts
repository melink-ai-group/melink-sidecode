import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptsSteer, canSteer, type SteerContext } from './steer.ts';

const base: SteerContext = {
  busy: true,
  backendId: 'ollama',
  backendStatus: 'available',
  hasDraft: true,
  attachmentCount: 0,
  restoring: false,
  pendingApproval: false,
  askingQuestion: false,
  modeSwitch: false
};

test('every shipped provider adapter accepts a steer', () => {
  for (const backendId of ['ollama', 'ollama-local', 'opencode', 'codex']) {
    assert.equal(acceptsSteer(backendId), true, backendId);
  }
});

test('a provider without a steer channel or no active provider does not', () => {
  assert.equal(acceptsSteer('ollama-local-v2'), false);
  assert.equal(acceptsSteer(undefined), false);
});

test('Ollama Local can send during a busy turn, exactly like Cloud', () => {
  assert.equal(canSteer({ ...base, backendId: 'ollama' }), true);
  assert.equal(canSteer({ ...base, backendId: 'ollama-local' }), true);
  assert.equal(canSteer({ ...base, backendId: 'opencode' }), true);
  assert.equal(canSteer({ ...base, backendId: 'codex' }), true);
});

test('an unknown provider or a non-busy/non-available turn cannot steer', () => {
  assert.equal(canSteer({ ...base, backendId: 'other' }), false);
  assert.equal(canSteer({ ...base, busy: false }), false);
  assert.equal(canSteer({ ...base, backendStatus: 'unavailable' }), false);
});

test('composer blockers disable steering for every provider', () => {
  const blockers: Partial<SteerContext>[] = [
    { hasDraft: false },
    { attachmentCount: 1 },
    { restoring: true },
    { pendingApproval: true },
    { askingQuestion: true },
    { modeSwitch: true }
  ];
  for (const backendId of ['ollama', 'ollama-local', 'opencode', 'codex']) {
    for (const blocker of blockers) {
      assert.equal(canSteer({ ...base, ...blocker, backendId }), false, `${backendId} ${JSON.stringify(blocker)}`);
    }
  }
});
