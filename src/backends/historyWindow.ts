import type { Attachment, TranscriptItem } from './types.ts';
import { takeAttachmentSection } from './userPrompt.ts';
import { visibleTranscriptText } from '../webview/visibleTranscript.ts';

/**
 * How many older items the provider asks for per page when the reader scrolls
 * to the top of a thread whose earlier turns are not stored locally.
 */
export const HISTORY_PAGE_SIZE = 40;

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
  const overlaid = serverItems.flatMap((item): TranscriptItem[] => {
    if (item.kind !== 'message' || item.role !== 'user') {
      return [item];
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
      // A provider can coalesce the opening prompt and mid-turn steers into
      // one historical row. Recover boundaries only from an exact sequence
      // of locally recorded messages, never by splitting arbitrary prose.
      const sequence = coalescedUsers(storedUsers, text, cursor);
      if (sequence) {
        cursor = sequence.end;
        return storedUsers.slice(sequence.start, cursor);
      }
      return [item];
    }
    const match = storedUsers[found];
    cursor = found + 1;
    const attachments = preferStoredAttachments(match.attachments, item.attachments);
    return [{
      ...item,
      id: match.id,
      text: match.text ?? item.text,
      ...(attachments ? { attachments } : {}),
      ...(match.orchestration ? { orchestration: true } : {}),
      ...(match.sentAt != null ? { sentAt: match.sentAt } : {}),
      ...(match.workedMs != null ? { workedMs: match.workedMs } : {})
    }];
  });
  const seen = new Set(overlaid.map((item) => item.id));
  const rest = storedUsers.slice(cursor).filter((item) => !seen.has(item.id));
  return rest.length > 0 ? [...overlaid, ...rest] : overlaid;
}

/**
 * Keep the turns the provider did not replay. A resumed provider may return
 * only its most recent window, while the local log still holds the full thread;
 * the chat must show both. The provider's window stays authoritative for the
 * rows it contains, and the stored prefix that came before it is kept in front.
 */
export function withStoredHistory(serverItems: readonly TranscriptItem[], stored: readonly TranscriptItem[]): TranscriptItem[] {
  if (serverItems.length === 0) {
    return [...stored];
  }
  const prefix = stored.length > 0 ? storedPrefixLength(serverItems, stored) : 0;
  const overlaid = withStoredUserIds(serverItems, prefix > 0 ? stored.slice(prefix) : stored);
  return prefix > 0 ? [...stored.slice(0, prefix), ...overlaid] : overlaid;
}

/**
 * How many stored rows come before the provider's replay window. A window that
 * opens on a user prompt is anchored by that prompt even when the provider
 * restarted with fresh ids; otherwise the first shared item id marks the cut.
 */
function storedPrefixLength(serverItems: readonly TranscriptItem[], stored: readonly TranscriptItem[]): number {
  const first = serverItems[0];
  if (first?.kind === 'message' && first.role === 'user' && promptKey(first.text)) {
    const key = promptKey(first.text);
    const start = stored.findIndex(
      (item) => item.kind === 'message' && item.role === 'user' && promptKey(item.text) === key
    );
    if (start >= 0) {
      return start;
    }
    const users = stored.filter((item) => item.kind === 'message' && item.role === 'user');
    const sequence = coalescedUsers(users, key, 0);
    if (sequence) {
      return stored.indexOf(users[sequence.start]);
    }
  }
  const serverIds = new Set(serverItems.map((item) => item.id));
  for (let index = 0; index < stored.length; index += 1) {
    if (serverIds.has(stored[index].id)) {
      return index;
    }
  }
  return 0;
}

/** Match only whole recorded messages joined as provider text parts. */
function coalescedUsers(users: readonly TranscriptItem[], text: string, cursor: number): { start: number; end: number } | undefined {
  for (let start = cursor; start < users.length; start += 1) {
    const first = promptKey(users[start].text);
    if (!first || !text.startsWith(first)) {
      continue;
    }
    for (const separator of ['\n', '\n\n']) {
      let combined = first;
      for (let end = start + 1; end < users.length; end += 1) {
        combined += separator + promptKey(users[end].text);
        if (combined === text) {
          return { start, end: end + 1 };
        }
        if (!text.startsWith(combined)) {
          break;
        }
      }
    }
  }
  return undefined;
}

/** The words the user typed, without the provider's attachment list. */
function promptKey(text: string | undefined): string {
  return visibleTranscriptText(takeAttachmentSection(text ?? '').text);
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
