/**
 * How long a turn ran, from the user message that opened it until the turn
 * finished. The duration is stored on that user message so a reload can paint
 * the same end note.
 */

export interface TimedTurnItem {
  id: string;
  kind: string;
  role?: string;
  sentAt?: number;
  workedMs?: number;
}

const EPOCH_MS = 1_000_000_000_000;

/** Start time stored on the user message that opened the turn. */
export function messageSentAt(item: { sentAt?: number }): number | undefined {
  if (typeof item.sentAt === 'number' && Number.isFinite(item.sentAt) && item.sentAt >= EPOCH_MS) {
    return item.sentAt;
  }
  return undefined;
}

/**
 * Record the elapsed time on the user message that opened the turn still in
 * progress. A later user message in the same turn (a steer) does not move the
 * start. A turn that already has a duration is left alone.
 */
export function stampTurnWorked<T extends TimedTurnItem>(items: readonly T[], endedAt: number): T[] {
  let opening = -1;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || item.kind !== 'message' || item.role !== 'user') {
      continue;
    }
    if (item.workedMs != null) {
      opening = -1;
      continue;
    }
    if (messageSentAt(item) == null) {
      continue;
    }
    if (opening === -1) {
      opening = index;
    }
  }
  const item = opening === -1 ? undefined : items[opening];
  const sentAt = item ? messageSentAt(item) : undefined;
  if (!item || sentAt == null) {
    return items as T[];
  }
  const next = items.slice();
  next[opening] = { ...item, sentAt, workedMs: Math.max(0, endedAt - sentAt) };
  return next;
}

/** "Worked for 1m 50s", "Worked for 2h 43m", or "Worked for 12s". */
export function formatWorked(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return minutes > 0 ? `Worked for ${hours}h ${minutes}m` : `Worked for ${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `Worked for ${minutes}m ${seconds}s` : `Worked for ${minutes}m`;
  }
  return `Worked for ${Math.max(totalSeconds, 1)}s`;
}
