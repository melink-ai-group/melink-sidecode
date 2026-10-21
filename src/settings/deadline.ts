/**
 * A hard wall-clock bound for one settings save.
 *
 * The save path probes CLIs and lists models, and a wedged child process can
 * keep a promise pending indefinitely. The settings screen must never be left
 * in a permanent "Saving..." state, so the whole operation is raced against
 * this deadline and the loser is abandoned. The rejection message is safe to
 * render: it never includes a path, a credential, or raw CLI output.
 */

export class DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadlineError';
  }
}

/**
 * Resolve with `work`, or reject with `DeadlineError` after `timeoutMs`.
 *
 * The timer is always cleared, and the original promise keeps its own
 * handlers, so a late rejection after the deadline is not unhandled.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(message)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** The sentence the screen shows when a save misses the deadline. */
export const SAVE_TIMEOUT_MESSAGE =
  'Saving took too long and was stopped. Some values may already be saved; reopen Settings to see the stored values, then retry anything that is still marked unsaved.';

/** One settled save. `error` is set only when the write phase itself failed. */
export interface SettingsWriteOutcome<T> {
  result?: T;
  error?: unknown;
}

export interface RunSettingsWriteOptions<T> {
  /** The write phase, bounded by the deadline. */
  write: () => Promise<T>;
  /**
   * The slow echo (snapshot, CLI probes, model lists). It runs after the
   * outcome is reported and can never change or delay it.
   */
  echo: (result: T | undefined) => Promise<void>;
  /** Called exactly once, as soon as the write phase settles. */
  settle: (outcome: SettingsWriteOutcome<T>) => void;
  timeoutMs: number;
  timeoutMessage: string;
  /** An echo failure is reported here, never as a save failure. */
  onEchoError?: (error: unknown) => void;
}

/**
 * Bound only the write phase, then report the result before the slow echo.
 *
 * The echo refreshes every surface and probes CLIs; making the deadline cover
 * it produced false "Saving took too long" reports after every write had
 * succeeded. Here the deadline protects the promise that can actually hang a
 * write, the footer settles on that result, and the echo continues on its own
 * without the screen ever claiming a successful save failed.
 */
export async function runSettingsWrite<T>(
  options: RunSettingsWriteOptions<T>
): Promise<void> {
  let outcome: SettingsWriteOutcome<T>;
  try {
    outcome = {
      result: await withDeadline(options.write(), options.timeoutMs, options.timeoutMessage)
    };
  } catch (error) {
    outcome = { error };
  }
  options.settle(outcome);
  void Promise.resolve()
    .then(() => options.echo(outcome.result))
    .catch((error: unknown) => options.onEchoError?.(error));
}
