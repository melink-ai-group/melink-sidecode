import type { Attachment, TranscriptItem } from './types.ts';
import { takeAttachmentSection } from './userPrompt.ts';

/**
 * How many transcript items a restored chat paints at first, and how many more
 * appear each time the reader scrolls to the top. The rest stay available and
 * load on demand, so a long thread does not have to render in one pass.
 */
export const HISTORY_PAGE_SIZE = 40;

/**
 * Index of the first item currently on screen. The cut snaps back to the user
 * message that opened the turn, so a page does not begin on the reasoning row
 * that follows the prompt.
 */
export function initialHistoryHidden(items: readonly TranscriptItem[], pageSize = HISTORY_PAGE_SIZE): number {
  return snapToUserMessage(items, Math.max(0, items.length - pageSize));
}

/**
 * Move a cut that landed mid-turn back to the user message that opened it.
 * A cut with no user message above it stays where it is, so a page of tool
 * rows is not pulled all the way to the start of the thread.
 */
function snapToUserMessage(items: readonly TranscriptItem[], hidden: number): number {
  const cut = Math.min(Math.max(hidden, 0), items.length);
  let start = cut;
  while (start > 0 && !(items[start]?.kind === 'message' && items[start]?.role === 'user')) {
    start -= 1;
  }
  if (items[start]?.kind === 'message' && items[start]?.role === 'user') {
    return start;
  }
  return cut;
}

/** The painted suffix. `hidden` is the index of its first item. */
export function visibleHistory<T>(items: readonly T[], hidden: number): T[] {
  const start = Math.min(Math.max(hidden, 0), items.length);
  return items.slice(start);
}

/**
 * Reveal the next page that is already in `items`, just above the painted suffix.
 * Returns the items that were not on screen before.
 */
export function revealStoredHistory(
  items: readonly TranscriptItem[],
  hidden: number,
  pageSize = HISTORY_PAGE_SIZE
): { hidden: number; added: TranscriptItem[] } {
  const start = Math.min(Math.max(hidden, 0), items.length);
  const reveal = Math.min(pageSize, start);
  const next = snapToUserMessage(items, start - reveal);
  return { hidden: next, added: items.slice(next, start) };
}

/**
 * Items appended to the local log after `loaded` was captured: the stored tail
 * that follows the last id the loaded list already has. Older stored rows that
 * the loaded list replaced are left out, so they cannot reappear at the bottom.
 */
export function newerThanLoaded(loaded: readonly TranscriptItem[], stored: readonly TranscriptItem[]): TranscriptItem[] {
  if (loaded.length === 0) {
    return [...stored];
  }
  const ids = new Set(loaded.map((item) => item.id));
  const newer: TranscriptItem[] = [];
  for (let index = stored.length - 1; index >= 0; index -= 1) {
    if (ids.has(stored[index].id)) {
      break;
    }
    newer.push(stored[index]);
  }
  return newer.reverse();
}

/** Refresh captured rows from the local log, then append newer turns. */
export function transcriptWithNewer(
  loaded: readonly TranscriptItem[] | undefined,
  stored: readonly TranscriptItem[]
): TranscriptItem[] {
  if (!loaded || loaded.length === 0) {
    return [...stored];
  }
  const byId = new Map(stored.map((item) => [item.id, item]));
  return [...loaded.map((item) => byId.get(item.id) ?? item), ...newerThanLoaded(loaded, stored)];
}

/**
 * Keep the host's user-message ids when the server repeats the same turn.
 * Checkpoints address those ids. A stored user row older than this server
 * window is not appended; rows that follow the last match are, so a message
 * sent after the snapshot stays at the end.
 */
export function withStoredUserIds(serverItems: readonly TranscriptItem[], stored: readonly TranscriptItem[]): TranscriptItem[] {
  const storedUsers = stored.filter((item) => item.kind === 'message' && item.role === 'user');
  let cursor = 0;
  const overlaid = serverItems.map((item) => {
    if (item.kind !== 'message' || item.role !== 'user') {
      return item;
    }
    const text = promptKey(item.text);
    let found = -1;
    for (let index = cursor; index < storedUsers.length; index += 1) {
      if (promptKey(storedUsers[index].text) === text) {
        found = index;
        break;
      }
    }
    if (found === -1) {
      return item;
    }
    const match = storedUsers[found];
    cursor = found + 1;
    return {
      ...item,
      id: match.id,
      text: match.text ?? item.text,
      attachments: preferStoredAttachments(match.attachments, item.attachments),
      ...(match.sentAt != null ? { sentAt: match.sentAt } : {}),
      ...(match.workedMs != null ? { workedMs: match.workedMs } : {})
    };
  });
  const seen = new Set(overlaid.filter((item) => item.kind === 'message' && item.role === 'user').map((item) => promptKey(item.text)));
  const rest = storedUsers.slice(cursor).filter((item) => !seen.has(promptKey(item.text)));
  return rest.length > 0 ? [...overlaid, ...rest] : overlaid;
}

/** The words the user typed, without the provider's attachment list. */
function promptKey(text: string | undefined): string {
  return takeAttachmentSection(text ?? '').text.trim();
}

/**
 * The stored row is the one the composer saved: its id is what a checkpoint
 * addresses, and its file list is the one the user attached. A path or preview
 * recovered from the provider fills a gap, and never replaces that list.
 */
function preferStoredAttachments(
  stored: Attachment[] | undefined,
  recovered: Attachment[] | undefined
): Attachment[] | undefined {
  if (!stored || stored.length === 0) {
    return recovered && recovered.length > 0 ? recovered : undefined;
  }
  return stored.map((item) => {
    const match = recovered?.find((entry) => (item.path && entry.path === item.path) || entry.name === item.name);
    if (!match) {
      return item;
    }
    return {
      ...item,
      ...(item.path ? {} : match.path ? { path: match.path } : {}),
      ...(item.dataUrl ? {} : match.dataUrl ? { dataUrl: match.dataUrl } : {})
    };
  });
}

/**
 * Prepend provider rows that are not already present, then reveal one page of
 * what was above the fold. Duplicate ids are dropped. A user row whose text
 * is already on screen is dropped too, so a server copy of a locally stored
 * prompt cannot appear twice.
 */
export function prependOlderHistory(
  items: readonly TranscriptItem[],
  hidden: number,
  older: readonly TranscriptItem[],
  pageSize = HISTORY_PAGE_SIZE
): { items: TranscriptItem[]; hidden: number; added: TranscriptItem[] } {
  const merged = mergeOlderItems(items, older);
  const inserted = merged.length - items.length;
  const shifted = Math.min(merged.length, Math.max(0, hidden) + inserted);
  const reveal = Math.min(pageSize, shifted);
  const nextHidden = snapToUserMessage(merged, shifted - reveal);
  return {
    items: merged,
    hidden: nextHidden,
    added: merged.slice(nextHidden, shifted)
  };
}

export function mergeOlderItems(existing: readonly TranscriptItem[], older: readonly TranscriptItem[]): TranscriptItem[] {
  const ids = new Set(existing.map((item) => item.id));
  const userText = new Set(
    existing
      .filter((item) => item.kind === 'message' && item.role === 'user')
      .map((item) => (item.text ?? '').trim())
      .filter((text) => text.length > 0)
  );
  const fresh: TranscriptItem[] = [];
  for (const item of older) {
    if (ids.has(item.id)) {
      continue;
    }
    if (item.kind === 'message' && item.role === 'user') {
      const text = (item.text ?? '').trim();
      if (text && userText.has(text)) {
        continue;
      }
      if (text) {
        userText.add(text);
      }
    }
    ids.add(item.id);
    fresh.push(item);
  }
  return fresh.length === 0 ? [...existing] : [...fresh, ...existing];
}
