/**
 * A live OpenCode turn that has stopped emitting events.
 *
 * Text arrives as a whole part, so a gap with no tokens is normal. The first
 * look is 90 seconds. A model step that is still open, or a tool call that has
 * not been followed by a finished step, can run much longer than that, so the
 * look repeats and the turn stays up until the cap. A turn that has already
 * finished its step stops at the first look. A command that is still running,
 * or a card the user has to answer, is not silence.
 */

/** First look. Silence this long is checked, not stopped on its own. */
export const OPENCODE_QUIET_MS = 90_000;

/** How far each later look moves when a slow call may still be running. */
export const OPENCODE_QUIET_EXTEND_MS = 90_000;

/** Longest silence kept for a slow model or tool follow-up. */
export const OPENCODE_QUIET_CAP_MS = 10 * 60_000;

export function opencodeQuietAction(input: {
  quietForMs: number;
  openTools: number;
  waitingOnUser: boolean;
  /**
   * True while a model step is open, or the last event was a tool / a
   * non-terminal step finish. Those calls often produce nothing until they end.
   */
  slowCall: boolean;
  firstMs?: number;
  extendMs?: number;
  capMs?: number;
}): 'wait' | 'stop' {
  if (input.waitingOnUser || input.openTools > 0 || input.quietForMs < 0) {
    return 'wait';
  }
  const first = input.firstMs ?? OPENCODE_QUIET_MS;
  const cap = input.capMs ?? OPENCODE_QUIET_CAP_MS;
  if (input.quietForMs < first) {
    return 'wait';
  }
  if (input.slowCall && input.quietForMs < cap) {
    return 'wait';
  }
  return 'stop';
}

/** Sentence thrown when a live turn is ended for going quiet. Matched by auto-continue. */
export function quietTurnMessage(): string {
  return 'The turn went quiet before it finished.';
}

export interface QuietClock {
  now(): number;
  schedule(ms: number, fire: () => void): () => void;
}

const defaultClock: QuietClock = {
  now: () => Date.now(),
  schedule: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  }
};

/**
 * Arm only after the first event, so server startup is not silence.
 * `blocked` covers a running command or a card the user still has to answer.
 * `slowCall` covers a model or tool call that can outlast the first look.
 */
export function watchOpencodeQuiet(options: {
  firstMs?: number;
  extendMs?: number;
  capMs?: number;
  clock?: QuietClock;
  blocked: () => boolean;
  slowCall?: () => boolean;
  onQuiet: () => void;
}): { activity: () => void; stop: () => void } {
  const first = options.firstMs ?? OPENCODE_QUIET_MS;
  const extend = options.extendMs ?? OPENCODE_QUIET_EXTEND_MS;
  const cap = options.capMs ?? OPENCODE_QUIET_CAP_MS;
  const clock = options.clock ?? defaultClock;
  const slowCall = options.slowCall ?? (() => false);
  let cancel: (() => void) | undefined;
  let last = 0;
  let started = false;
  let stopped = false;

  const clear = (): void => {
    cancel?.();
    cancel = undefined;
  };

  const nextWait = (quietForMs: number): number | undefined => {
    const action = opencodeQuietAction({
      quietForMs,
      openTools: 0,
      waitingOnUser: false,
      slowCall: slowCall(),
      firstMs: first,
      extendMs: extend,
      capMs: cap
    });
    if (action === 'stop') {
      return undefined;
    }
    if (quietForMs < first) {
      return first - quietForMs;
    }
    const untilCap = cap - quietForMs;
    if (untilCap <= 0) {
      return undefined;
    }
    return Math.min(extend, untilCap);
  };

  const arm = (): void => {
    clear();
    if (stopped || !started || options.blocked()) {
      return;
    }
    const wait = nextWait(clock.now() - last);
    if (wait === undefined) {
      return;
    }
    cancel = clock.schedule(wait, () => {
      cancel = undefined;
      if (stopped || !started || options.blocked()) {
        return;
      }
      const again = nextWait(clock.now() - last);
      if (again === undefined) {
        options.onQuiet();
        return;
      }
      arm();
    });
  };

  return {
    activity(): void {
      if (stopped) {
        return;
      }
      started = true;
      last = clock.now();
      arm();
    },
    stop(): void {
      stopped = true;
      clear();
    }
  };
}
