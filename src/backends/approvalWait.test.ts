import test from 'node:test';
import assert from 'node:assert/strict';
import { APPROVAL_WAIT_MS, awaitUserDecision } from './approvalWait.ts';

test('an approval waits at least 120 seconds before a timeout can refuse it', () => {
  assert.ok(APPROVAL_WAIT_MS >= 120_000);
});

test('a user decision is applied and the timeout does not replace it', async () => {
  const decision = await awaitUserDecision<string>({
    waitMs: 500,
    onRequest: (settle) => settle('allow-session'),
    onTimeout: () => 'reject'
  });
  assert.equal(decision, 'allow-session');
});

test('no decision within the wait refuses the request', async () => {
  const decision = await awaitUserDecision({
    waitMs: 20,
    onRequest: () => undefined,
    onTimeout: () => 'reject' as const
  });
  assert.equal(decision, 'reject');
});

test('cancel resolves through the abort path and ignores a later decision', async () => {
  const signal = new AbortController();
  let late: ((value: string) => void) | undefined;
  const pending = awaitUserDecision({
    waitMs: 5_000,
    signal: signal.signal,
    onRequest: (settle) => {
      late = settle;
    },
    onTimeout: () => 'timeout',
    onAbort: () => 'aborted'
  });
  signal.abort();
  assert.equal(await pending, 'aborted');
  late?.('allow-once');
  assert.equal(await pending, 'aborted');
});
