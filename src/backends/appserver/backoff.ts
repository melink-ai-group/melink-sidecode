/**
 * Exponential backoff with jitter for the app-server's overload signal.
 *
 * Codex documents `-32001` / "Server overloaded; retry later." as an expected
 * response under load, and tells clients to retry with exponentially increasing
 * delay *and* jitter. This module is deliberately pure: the clock and the random
 * source are injectable, so the retry schedule is unit-testable without waiting.
 */

export interface BackoffOptions {
  /** Delay before the first retry; doubles each subsequent attempt. */
  baseDelayMs: number;
  /** Ceiling for a single delay, before jitter is applied. */
  maxDelayMs: number;
  /** Total attempts, including the first. A cap of 1 means "do not retry". */
  maxAttempts: number;
  /** Random source in [0, 1); injectable for deterministic tests. */
  random?: () => number;
  /** Sleep implementation; injectable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_BACKOFF: Omit<BackoffOptions, 'random' | 'sleep'> = {
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  maxAttempts: 6
};

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delay before retry number `attempt` (1-based). Uses "equal jitter": the
 * exponential ceiling is halved and a random amount up to the other half is
 * added, so delays trend upward with the attempt while still spreading clients
 * out. The result is always within [ceiling/2, ceiling].
 */
export function backoffDelayMs(attempt: number, options: BackoffOptions): number {
  const random = options.random ?? Math.random;
  const exponent = Math.max(attempt - 1, 0);
  const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** exponent);
  const half = ceiling / 2;
  return Math.round(half + random() * half);
}

export class RetryExhaustedError extends Error {
  readonly attempts: number;
  readonly retryCause: unknown;

  constructor(attempts: number, cause: unknown) {
    super(`Gave up after ${attempts} attempt${attempts === 1 ? '' : 's'}.`);
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    this.retryCause = cause;
  }
}

/**
 * Run `operation`, retrying while `isRetryable` accepts the failure, up to the
 * configured cap. The last failure is rethrown as a `RetryExhaustedError` so the
 * caller can distinguish "the cap was hit" from a single terminal failure.
 */
export async function retryWithBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  options: BackoffOptions
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!isRetryable(error)) {
        throw error;
      }
      if (attempt >= options.maxAttempts) {
        throw new RetryExhaustedError(attempt, error);
      }
      await sleep(backoffDelayMs(attempt, options));
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new RetryExhaustedError(options.maxAttempts, undefined);
}
