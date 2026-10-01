/**
 * How long an approval stays open for the user before the agent is told to
 * continue another way. Both adapters use this floor: a decision that arrives
 * sooner is applied immediately, and nothing is refused before this elapses.
 */
export const APPROVAL_WAIT_MS = 120_000;

/** Shown when the wait elapses with no decision, so the agent can change approach. */
export const APPROVAL_TIMEOUT_REASON =
  'No decision arrived within 120 seconds, so this action was refused and the agent can try a different approach.';

/**
 * Wait for a user decision, or call `onTimeout` once `waitMs` elapses.
 *
 * Exactly one of `settle`, `onTimeout`, or `onAbort` runs. A late click after
 * the wait cannot apply a second answer.
 */
export function awaitUserDecision<T>(options: {
  /** Defaults to {@link APPROVAL_WAIT_MS}. Tests pass a shorter wait. */
  waitMs?: number;
  signal?: AbortSignal;
  onRequest: (settle: (value: T) => void) => void;
  onTimeout: () => T;
  onAbort?: () => T;
}): Promise<T> {
  const waitMs = options.waitMs ?? APPROVAL_WAIT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const timer = setTimeout(() => finish(options.onTimeout()), waitMs);
    const onAbort = (): void => {
      finish((options.onAbort ?? options.onTimeout)());
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    options.onRequest(finish);
  });
}
