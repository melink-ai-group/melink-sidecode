import { startTransition } from 'react';

/**
 * Fold a burst of host messages into one render, and hold that render while
 * the reader is scrolling so layout stays on the scroll.
 *
 * Urgent messages (a draft restore, dictation, a notice) flush anything
 * waiting and apply on their own turn.
 */

const COALESCE_MS = 32;
const DEFER_RETRY_MS = 48;
const DEFER_CAP_MS = 400;

const URGENT_HOST_MESSAGES = new Set([
  'snapshot',
  'conversation',
  'restoring',
  'chatTabs',
  'settings',
  'models',
  'threads',
  'permissions',
  'modes',
  'busy',
  'question/asked',
  'question/cleared',
  'composerDraft',
  'dictationCleaned',
  'dictationError',
  'dictationStatus',
  'revertLocalSend',
  'modeSwitchPrompt',
  'showSettings',
  'notice',
  'attachmentError',
  'attachmentsPicked',
  'queuedTurns',
  'userMessageSent',
  'userMessageId'
]);

export function isUrgentHostMessage(type: string): boolean {
  return URGENT_HOST_MESSAGES.has(type);
}

export interface MessagePump<T> {
  push(message: T, urgent?: boolean): void;
  dispose(): void;
}

export function createMessagePump<T>(options: {
  apply: (message: T) => void;
  /** When true, streamed updates wait so scrolling can use the frame. */
  shouldDefer?: () => boolean;
  /** Fired when updates start or stop waiting on a scroll. */
  onHold?: (held: boolean) => void;
  schedule?: (run: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (id: ReturnType<typeof setTimeout>) => void;
}): MessagePump<T> {
  const schedule = options.schedule ?? ((run, delayMs) => setTimeout(run, delayMs));
  const cancel = options.cancel ?? ((id) => clearTimeout(id));
  let queued: T[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deferStarted = 0;
  let held = false;
  let dead = false;

  const setHeld = (value: boolean): void => {
    if (held === value) {
      return;
    }
    held = value;
    options.onHold?.(value);
  };

  const flush = (): void => {
    timer = undefined;
    deferStarted = 0;
    const batch = queued;
    queued = [];
    // Stay marked while the reader is still scrolling, so a cap flush does not blink the spinner.
    setHeld(options.shouldDefer?.() ?? false);
    if (batch.length === 0) {
      return;
    }
    startTransition(() => {
      for (const message of batch) {
        options.apply(message);
      }
    });
  };

  const tryFlush = (): void => {
    timer = undefined;
    if (dead) {
      return;
    }
    const defer = (options.shouldDefer?.() ?? false) && queued.length < 400;
    if (defer && (deferStarted === 0 || Date.now() - deferStarted < DEFER_CAP_MS)) {
      if (deferStarted === 0) {
        deferStarted = Date.now();
      }
      setHeld(true);
      timer = schedule(tryFlush, DEFER_RETRY_MS);
      return;
    }
    flush();
  };

  return {
    push(message, urgent = false) {
      if (dead) {
        return;
      }
      if (urgent) {
        if (timer !== undefined) {
          cancel(timer);
          timer = undefined;
        }
        const batch = queued;
        queued = [];
        deferStarted = 0;
        setHeld(false);
        if (batch.length > 0) {
          startTransition(() => {
            for (const item of batch) {
              options.apply(item);
            }
          });
        }
        options.apply(message);
        return;
      }
      queued.push(message);
      if (timer === undefined) {
        timer = schedule(tryFlush, COALESCE_MS);
      }
    },
    dispose() {
      dead = true;
      if (timer !== undefined) {
        cancel(timer);
      }
      timer = undefined;
      queued = [];
      deferStarted = 0;
      setHeld(false);
    }
  };
}
