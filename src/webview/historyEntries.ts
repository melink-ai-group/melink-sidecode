import type { ThreadSummary } from '../backends/types';

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

/** True while any provider's history request is still outstanding. */
export function historyLoading(
  providers: readonly { id: string }[],
  threadLoading: Record<string, boolean | undefined>
): boolean {
  return providers.some((provider) => threadLoading[provider.id] === true);
}
