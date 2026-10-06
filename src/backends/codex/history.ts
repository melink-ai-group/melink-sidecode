/** One backwards page of Codex thread items. */
export const OLDER_ITEM_PAGE = 40;

/** One backwards page of Codex turns, each with its items. */
export const OLDER_TURN_PAGE = 8;

/**
 * Cursors from `thread/resume`. Each one addresses the oldest row already
 * returned. `thread/items/list` and `thread/turns/list` with `sortDirection:
 * "desc"` include that anchor, then continue into older history.
 */
export interface HistoryCursors {
  items: string | null;
  turns: string | null;
}

export type OlderQuery =
  | { kind: 'items'; cursor: string; limit: number }
  | { kind: 'turns'; cursor: string; limit: number };

export function historyCursors(items: string | null, turns: string | null): HistoryCursors {
  return { items, turns };
}

/** Item cursor first: a paginated thread often cuts mid-turn, on a reasoning row. */
export function nextOlderQuery(cursors: HistoryCursors): OlderQuery | undefined {
  if (cursors.items) {
    return { kind: 'items', cursor: cursors.items, limit: OLDER_ITEM_PAGE };
  }
  if (cursors.turns) {
    return { kind: 'turns', cursor: cursors.turns, limit: OLDER_TURN_PAGE };
  }
  return undefined;
}

/**
 * Advance the cursor that was just used. A cursor that does not move is
 * exhausted: paging it again would return the same anchor forever.
 */
export function cursorsAfterPage(
  cursors: HistoryCursors,
  kind: OlderQuery['kind'],
  requested: string,
  nextCursor: string | null
): HistoryCursors {
  const advanced = nextCursor && nextCursor !== requested ? nextCursor : null;
  if (kind === 'items') {
    return { ...cursors, items: advanced };
  }
  return { ...cursors, turns: advanced };
}

/** `sortDirection: "desc"` is newest-first. The transcript reads oldest-first. */
export function chronological<T>(entries: readonly T[]): T[] {
  return [...entries].reverse();
}
