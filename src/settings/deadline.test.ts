import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DeadlineError,
  SAVE_TIMEOUT_MESSAGE,
  runSettingsWrite,
  withDeadline,
  type SettingsWriteOutcome
} from './deadline.ts';

test('a save that finishes inside the bound resolves unchanged', async () => {
  const value = await withDeadline(Promise.resolve('stored'), 50, SAVE_TIMEOUT_MESSAGE);
  assert.equal(value, 'stored');
});

test('a hung save rejects at the deadline instead of leaving the footer busy', async () => {
  const never = new Promise<string>(() => {});
  await assert.rejects(withDeadline(never, 10, SAVE_TIMEOUT_MESSAGE), (error: unknown) => {
    assert.ok(error instanceof DeadlineError);
    assert.equal(error.message, SAVE_TIMEOUT_MESSAGE);
    assert.match(error.message, /took too long/i);
    return true;
  });
});

test('a late rejection from the abandoned work is handled, not unhandled', async () => {
  let rejectLate: ((error: Error) => void) | undefined;
  const late = new Promise<string>((_resolve, reject) => {
    rejectLate = reject;
  });
  await assert.rejects(withDeadline(late, 10, SAVE_TIMEOUT_MESSAGE), DeadlineError);
  rejectLate?.(new Error('the abandoned write failed later'));
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test('a successful write settles before the slow echo runs', async () => {
  let settled: SettingsWriteOutcome<string> | undefined;
  let echoStarted = false;
  const echoNeverFinishes = new Promise<void>(() => {});
  await runSettingsWrite({
    write: async () => 'stored',
    echo: (result) => {
      echoStarted = true;
      assert.equal(result, 'stored');
      return echoNeverFinishes;
    },
    settle: (outcome) => {
      settled = outcome;
    },
    timeoutMs: 1000,
    timeoutMessage: SAVE_TIMEOUT_MESSAGE
  });
  assert.deepEqual(settled, { result: 'stored' });
  await Promise.resolve();
  assert.equal(echoStarted, true);
});

test('an echo failure is reported separately and never changes the settled result', async () => {
  const settled: Array<SettingsWriteOutcome<string>> = [];
  const echoErrors: unknown[] = [];
  await runSettingsWrite({
    write: async () => 'stored',
    echo: async () => {
      throw new Error('the echo probe failed');
    },
    settle: (outcome) => {
      settled.push(outcome);
    },
    timeoutMs: 1000,
    timeoutMessage: SAVE_TIMEOUT_MESSAGE,
    onEchoError: (error) => {
      echoErrors.push(error);
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled.length, 1);
  assert.deepEqual(settled[0], { result: 'stored' });
  assert.equal(echoErrors.length, 1);
});

test('a hung write still settles as a deadline error and the echo is best effort', async () => {
  let settled: SettingsWriteOutcome<string> | undefined;
  const echoed: Array<string | undefined> = [];
  const never = new Promise<string>(() => {});
  await runSettingsWrite({
    write: () => never,
    echo: async (result) => {
      echoed.push(result);
    },
    settle: (outcome) => {
      settled = outcome;
    },
    timeoutMs: 10,
    timeoutMessage: SAVE_TIMEOUT_MESSAGE
  });
  assert.ok(settled?.error instanceof DeadlineError);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(echoed, [undefined]);
});
