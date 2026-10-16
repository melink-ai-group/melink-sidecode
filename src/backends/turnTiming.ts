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
 * Record each turn's elapsed time on the user message that opened it.
 * A message without a start time (a steer or a mid-turn answer) stays in the
 * turn already open. A duration already stored is left alone, so a later turn
 * cannot stretch an earlier one.
 */
export function stampTurnWorked<T extends TimedTurnItem>(items: readonly T[], endedAt: number): T[] {
  const openers: number[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || item.kind !== 'message' || item.role !== 'user' || messageSentAt(item) == null) {
      continue;
    }
    openers.push(index);
  }
  let next: T[] | undefined;
  for (let cursor = 0; cursor < openers.length; cursor += 1) {
    const index = openers[cursor];
    const item = items[index];
    const sentAt = item ? messageSentAt(item) : undefined;
    if (!item || sentAt == null || item.workedMs != null) {
      continue;
    }
    const following = cursor + 1 < openers.length ? items[openers[cursor + 1] ?? -1] : undefined;
    const end = following ? messageSentAt(following) : endedAt;
    if (end == null) {
      continue;
    }
    if (!next) {
      next = items.slice();
    }
    next[index] = { ...item, sentAt, workedMs: Math.max(0, end - sentAt) };
  }
  return next ?? (items as T[]);
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
