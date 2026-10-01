import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffDelayMs,
  RetryExhaustedError,
  retryWithBackoff,
  type BackoffOptions
} from './backoff.ts';
import { isServerOverloaded, JsonRpcError, SERVER_OVERLOADED_CODE } from './jsonrpc.ts';

function overloaded(): JsonRpcError {
  return new JsonRpcError({ code: SERVER_OVERLOADED_CODE, message: 'Server overloaded; retry later.' });
}

test('backoffDelayMs grows exponentially and stays within [ceiling/2, ceiling]', () => {
  const options: BackoffOptions = {
    baseDelayMs: 100,
    maxDelayMs: 10_000,
    maxAttempts: 10,
    // Fixed random source makes the schedule assertable.
    random: () => 0
  };
  // random()=0 gives the lower bound, i.e. exactly half the ceiling.
  assert.equal(backoffDelayMs(1, options), 50);
  assert.equal(backoffDelayMs(2, options), 100);
  assert.equal(backoffDelayMs(3, options), 200);
  assert.equal(backoffDelayMs(4, options), 400);
});

test('backoffDelayMs caps at maxDelayMs', () => {
  const options: BackoffOptions = {
    baseDelayMs: 100,
    maxDelayMs: 500,
    maxAttempts: 10,
    random: () => 0
  };
  assert.equal(backoffDelayMs(10, options), 250);
});

test('backoffDelayMs jitters upward with the random source', () => {
  const low: BackoffOptions = { baseDelayMs: 100, maxDelayMs: 10_000, maxAttempts: 10, random: () => 0 };
  const high: BackoffOptions = { ...low, random: () => 0.999 };
  // The high draw is strictly greater than the low draw: this is the "jitter"
  // the ticket asks for, not a fixed backoff.
  assert.ok(backoffDelayMs(4, high) > backoffDelayMs(4, low));
  // random()=0.999 draws just under the 800ms ceiling for attempt 4.
  assert.equal(backoffDelayMs(4, high), 800);
});

test('retryWithBackoff retries the overload signal with increasing delays and then gives up', async () => {
  const delays: number[] = [];
  let calls = 0;
  const options: BackoffOptions = {
    baseDelayMs: 100,
    maxDelayMs: 10_000,
    maxAttempts: 4,
    random: () => 0.5,
    sleep: async (ms) => {
      delays.push(ms);
    }
  };

  await assert.rejects(
    retryWithBackoff(
      async () => {
        calls += 1;
        throw overloaded();
      },
      isServerOverloaded,
      options
    ),
    (error: unknown) => error instanceof RetryExhaustedError && error.attempts === 4
  );

  assert.equal(calls, 4, 'attempts are capped');
  assert.equal(delays.length, 3, 'one delay between each of the four attempts');
  // Each delay grows: 75, 150, 300 with random()=0.5.
  assert.deepEqual(delays, [75, 150, 300]);
  for (let i = 1; i < delays.length; i += 1) {
    assert.ok(delays[i] > delays[i - 1], 'delay increases with each attempt');
  }
});

test('retryWithBackoff succeeds when a retry eventually clears the overload', async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await retryWithBackoff(
    async () => {
      calls += 1;
      if (calls < 3) {
        throw overloaded();
      }
      return 'ok';
    },
    isServerOverloaded,
    { baseDelayMs: 10, maxDelayMs: 100, maxAttempts: 5, random: () => 0, sleep: async (ms) => void delays.push(ms) }
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [5, 10]);
});

test('retryWithBackoff does not retry a non-overload failure', async () => {
  let calls = 0;
  await assert.rejects(
    retryWithBackoff(
      async () => {
        calls += 1;
        throw new JsonRpcError({ code: -32600, message: 'invalid request' });
      },
      isServerOverloaded,
      { baseDelayMs: 10, maxDelayMs: 100, maxAttempts: 5, random: () => 0, sleep: async () => undefined }
    ),
    (error: unknown) => error instanceof JsonRpcError && error.code === -32600
  );
  assert.equal(calls, 1, 'a terminal error is not retried');
});
