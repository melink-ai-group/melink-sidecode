import type { ThreadSummary } from '../backends/types';
import { visibleTranscriptText } from './visibleTranscript.ts';

/** History rows keep a short label. The tab title is shorter still. */
const HISTORY_TITLE_LIMIT = 60;

/** One row in the chat-history menu. Threads from every provider share this list. */
export interface HistoryEntry extends ThreadSummary {
  backendId: string;
  backendLabel: string;
}

/**
 * Every stored conversation, newest first, regardless of which provider is selected.
 * A provider that has dropped out of the availability list still contributes the
 * threads already loaded for it.
 */
export function historyEntries(
  providers: readonly { id: string; label: string }[],
  threads: Record<string, ThreadSummary[] | undefined>
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  const seen = new Set<string>();
  const push = (backendId: string, backendLabel: string, list: ThreadSummary[] | undefined): void => {
    for (const thread of list ?? []) {
      const key = `${backendId}:${thread.threadId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      entries.push({ ...thread, backendId, backendLabel });
    }
  };
  for (const provider of providers) {
    push(provider.id, provider.label, threads[provider.id]);
  }
  for (const [backendId, list] of Object.entries(threads)) {
    if (providers.some((provider) => provider.id === backendId)) {
      continue;
    }
    push(backendId, backendId, list);
  }
  return entries.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

/**
 * Label for one history row.
 *
 * Candidates are tried in order. A stored first-message title wins. A provider
 * preview is only a fallback, and the mode instruction we send in front of the
 * user's words is removed so it cannot become the label.
 */
export function historyThreadTitle(...candidates: (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    const line = historyTitleLine(candidate);
    if (!line) {
      continue;
    }
    return line.length > HISTORY_TITLE_LIMIT ? `${line.slice(0, HISTORY_TITLE_LIMIT)}...` : line;
  }
  return undefined;
}

function historyTitleLine(text: string | undefined): string | undefined {
  if (!text?.trim()) {
    return undefined;
  }
  const line = visibleTranscriptText(text).split(/\r?\n/, 1)[0]?.replace(/\s+/g, ' ').trim();
  return line || undefined;
}

/** True while any provider's history request is still outstanding. */
export function historyLoading(
  providers: readonly { id: string }[],
  threadLoading: Record<string, boolean | undefined>
): boolean {
  return providers.some((provider) => threadLoading[provider.id] === true);
}
