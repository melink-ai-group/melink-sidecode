import type { JournalTurn } from './journal.ts';
import { mergeSessionFiles } from './sessionFiles.ts';

/** Net only the automatic continuations of this user request, through this turn. */
export function requestTurn(turn: JournalTurn, turnsNewestFirst: readonly JournalTurn[]): JournalTurn {
  if (!turn.requestMessageId) { return turn; }
  const turns = requestTurns(turn, turnsNewestFirst);
  return {
    ...turn,
    messageId: turn.requestMessageId,
    observed: turns.some((entry) => entry.observed),
    files: mergeSessionFiles(turns).map((file) => file.entry)
  };
}

/** Recorded boundaries for this request, oldest first, without later user turns. */
export function requestTurns(turn: JournalTurn, turnsNewestFirst: readonly JournalTurn[]): JournalTurn[] {
  if (!turn.requestMessageId) { return [turn]; }
  const index = turnsNewestFirst.findIndex((entry) => entry.turnId === turn.turnId);
  if (index < 0) { return [turn]; }
  const turns = turnsNewestFirst.slice(index).filter((entry) =>
    entry.backendId === turn.backendId && entry.threadId === turn.threadId &&
    entry.requestMessageId === turn.requestMessageId
  );
  return turns.reverse();
}
