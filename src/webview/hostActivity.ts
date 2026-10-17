import { useSyncExternalStore } from 'react';

/**
 * Background work the sidebar started (Keep, restore, loading earlier
 * messages) plus transcript updates held back while the reader is scrolling.
 * The corner spinner subscribes here so those flags do not re-render the chat.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

let pending = 0;
let backlog = false;
let epoch = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function hostActivityPending(): boolean {
  return pending > 0 || backlog;
}

export function subscribeHostActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True while streamed updates are waiting so a scroll can finish. */
export function setHostBacklog(value: boolean): void {
  if (backlog === value) {
    return;
  }
  backlog = value;
  emit();
}

/**
 * Count one in-flight host action. The returned function is safe to call
 * twice. A timeout clears a count the host never answers.
 */
export function beginHostActivity(timeoutMs = DEFAULT_TIMEOUT_MS): () => void {
  pending += 1;
  emit();
  const ticket = epoch;
  let closed = false;
  const finish = (): void => {
    if (closed || ticket !== epoch) {
      return;
    }
    closed = true;
    clearTimeout(timer);
    pending = Math.max(0, pending - 1);
    emit();
  };
  const timer = setTimeout(finish, timeoutMs);
  return finish;
}

/**
 * Leave the click's paint on screen, then run `work`. The spinner stays up
 * until the caller releases it, which is when the host answers.
 */
export function deferHostClick(work: () => void): () => void {
  const release = beginHostActivity();
  const run = (): void => {
    try {
      work();
    } catch (error) {
      release();
      throw error;
    }
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      setTimeout(run, 0);
    });
  } else {
    setTimeout(run, 0);
  }
  return release;
}

export function useHostActivity(): boolean {
  return useSyncExternalStore(subscribeHostActivity, hostActivityPending, hostActivityPending);
}

export function resetHostActivityForTests(): void {
  epoch += 1;
  pending = 0;
  backlog = false;
  emit();
}
