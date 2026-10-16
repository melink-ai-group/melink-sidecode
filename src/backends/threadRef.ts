/**
 * Refresh a thread index entry without dropping the OpenCode session id.
 *
 * Sends update the title and mode and do not repeat the session id, the
 * compaction handover, or how much of the transcript was carried across.
 * Replacing the entry outright would forget them, and the
 * next turn would start a session that cannot see the previous one. A string
 * id on `next` still wins. Codex threads have no session id here; their
 * identity stays on `threadId`.
 */
export function mergeThreadRef<
  T extends { opencodeSessionId?: string; handoverSummary?: string; handoverHistoryCount?: number }
>(previous: T | undefined, next: T): T {
  return {
    ...next,
    opencodeSessionId: next.opencodeSessionId ?? previous?.opencodeSessionId,
    handoverSummary: next.handoverSummary ?? previous?.handoverSummary,
    handoverHistoryCount: next.handoverHistoryCount ?? previous?.handoverHistoryCount
  };
}
