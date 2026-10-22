import { DeadlineError, withDeadline } from '../settings/deadline.ts';

/** How long opening may spend reading transcript files before painting anyway. */
export const OPEN_HYDRATE_MS = 4_000;
/** A resume paints from memory if the file read is still going. */
export const RESUME_HYDRATE_MS = 1_000;
/** Project context must not hold the open chat on the restoring screen. */
export const RESUME_SNAPSHOT_MS = 8_000;
/** Reconnecting to a provider must not hold the open chat on the restoring screen. */
export const RESUME_PROVIDER_MS = 12_000;

export function safeOpenNotice(error: unknown, painted: boolean): string {
  if (painted) {
    return error instanceof DeadlineError
      ? 'Opening this chat took too long. Your saved messages are on screen, and you can keep working.'
      : 'The provider could not be reached. Your saved messages are on screen, and you can keep working.';
  }
  if (error instanceof DeadlineError) {
    return 'Opening the sidebar took too long. You can still use the chat.';
  }
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message && message.length <= 240 && !message.includes('\n')) {
      return message;
    }
  }
  return 'The sidebar could not finish opening. You can still start a chat.';
}

export interface OpenSidebarSteps {
  /** Read saved transcripts. A hang or a throw must not stop the paint. */
  hydrate: () => Promise<void>;
  /** Put the saved chat on screen and leave it usable. */
  paint: () => Promise<void>;
  /**
   * Queue restore, context, and shrinking workspace state. Runs only after
   * the chat is already usable.
   */
  afterPaint?: () => Promise<void>;
  /** The file read finished after the chat was already painted from memory. */
  onHydratedLate?: () => Promise<void>;
}

/**
 * Open the sidebar in safe mode.
 *
 * Saved messages are painted even when loading them throws or never finishes.
 * `unblock` runs as soon as that paint settles, before any later work, so a
 * failure there cannot leave the chat on the restoring screen.
 */
export async function openSidebarSafely(
  steps: OpenSidebarSteps,
  report: (error: unknown) => void,
  unblock: () => void,
  options?: { hydrateTimeoutMs?: number }
): Promise<void> {
  const hydrate = steps.hydrate();
  // A deadline abandons the read. Keep a handler so a later rejection is not unhandled.
  void hydrate.then(
    () => undefined,
    () => undefined
  );
  let late = false;
  try {
    await withDeadline(hydrate, options?.hydrateTimeoutMs ?? OPEN_HYDRATE_MS, 'Loading saved chats');
  } catch (error) {
    late = error instanceof DeadlineError;
    report(error);
  }
  try {
    await steps.paint();
  } catch (error) {
    report(error);
  } finally {
    unblock();
  }
  if (late && steps.onHydratedLate) {
    void hydrate.then(
      () => {
        void steps.onHydratedLate?.().catch(report);
      },
      () => undefined
    );
  }
  if (!steps.afterPaint) {
    return;
  }
  try {
    await steps.afterPaint();
  } catch (error) {
    report(error);
  }
}
