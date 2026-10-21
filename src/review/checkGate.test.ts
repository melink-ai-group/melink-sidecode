import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionBlockReason } from './checkGate.ts';
import type { CheckRunView } from './checks.ts';

function view(status: CheckRunView['status']): CheckRunView {
  return { status, summary: `Checks: ${status}`, results: [], startedAt: 1 };
}

test('running checks block Keep until they finish', () => {
  assert.equal(
    decisionBlockReason(view('running'), false),
    'Checks are still running. Keep is disabled until they finish.'
  );
});

test('failed checks require an explicit override', () => {
  assert.equal(
    decisionBlockReason(view('failed'), false),
    'Checks failed. Confirm the override to keep anyway.'
  );
  assert.equal(decisionBlockReason(view('failed'), true), undefined);
});

test('passed, skipped, untrusted and absent checks do not block Keep', () => {
  for (const status of ['passed', 'skipped', 'untrusted'] as const) {
    assert.equal(decisionBlockReason(view(status), false), undefined, status);
  }
  assert.equal(decisionBlockReason(undefined, false), undefined);
});

test('an override never bypasses a still-running check', () => {
  assert.equal(
    decisionBlockReason(view('running'), true),
    'Checks are still running. Keep is disabled until they finish.'
  );
});
