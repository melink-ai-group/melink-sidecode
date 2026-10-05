/**
 * Refresh a thread index entry without dropping the OpenCode session id.
 *
 * Sends update the title and mode and do not repeat the session id or the
 * compaction handover. Replacing the entry outright would forget them, and the
 * next turn would start a session that cannot see the previous one. A string
 * id on `next` still wins. Codex threads have no session id here; their
 * identity stays on `threadId`.
 */
export function mergeThreadRef<T extends { opencodeSessionId?: string; handoverSummary?: string }>(
  previous: T | undefined,
  next: T
): T {
  return {
    ...next,
    opencodeSessionId: next.opencodeSessionId ?? previous?.opencodeSessionId,
    handoverSummary: next.handoverSummary ?? previous?.handoverSummary
  };
}
