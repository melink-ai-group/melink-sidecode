/**
 * Place each turn's file-change card on the user message that opened it.
 *
 * The card follows the last transcript item of that turn, so it reads as
 * belonging to the turn rather than to the whole chat. A turn whose opening
 * message is not in the transcript is left unplaced and is not shown.
 */

export interface TurnChangeAnchor {
  turnId: string;
  messageId?: string;
}

export interface PlacedTurnChanges<T extends TurnChangeAnchor> {
  /** Cards to render after this transcript item, in turn order. */
  afterItem: Map<string, T[]>;
  /** Turns whose opening message is not in the transcript. These are not shown. */
  unplaced: T[];
}

export function placeTurnChanges<T extends TurnChangeAnchor>(
  items: readonly { id: string; kind: string; role?: string }[],
  turns: readonly T[],
  checkpoints: readonly { messageId: string; turnId: string }[]
): PlacedTurnChanges<T> {
  const byTurn = new Map(turns.map((turn) => [turn.turnId, turn]));
  const byMessage = new Map<string, T>();
  for (const turn of turns) {
    if (turn.messageId) {
      byMessage.set(turn.messageId, turn);
    }
  }
  for (const checkpoint of checkpoints) {
    if (byMessage.has(checkpoint.messageId)) {
      continue;
    }
    const turn = byTurn.get(checkpoint.turnId);
    if (turn) {
      byMessage.set(checkpoint.messageId, turn);
    }
  }

  const userIndexes: number[] = [];
  items.forEach((item, index) => {
    if (item.kind === 'message' && item.role === 'user') {
      userIndexes.push(index);
    }
  });

  const afterItem = new Map<string, T[]>();
  const used = new Set<string>();
  for (let i = 0; i < userIndexes.length; i += 1) {
    const start = userIndexes[i];
    const message = items[start];
    const turn = byMessage.get(message.id);
    if (!turn || used.has(turn.turnId)) {
      continue;
    }
    const end = i + 1 < userIndexes.length ? userIndexes[i + 1] - 1 : items.length - 1;
    const afterId = items[end]?.id ?? message.id;
    const list = afterItem.get(afterId) ?? [];
    list.push(turn);
    afterItem.set(afterId, list);
    used.add(turn.turnId);
  }

  return {
    afterItem,
    unplaced: turns.filter((turn) => !used.has(turn.turnId))
  };
}
