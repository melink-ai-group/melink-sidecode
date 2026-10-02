/**
 * Sidebar chat-tab titles and which open tab a new chat or history pick should use.
 * Pure data so the host can share the rule with tests; no VS Code types.
 */

export const DEFAULT_TAB_TITLE = 'SideCode';

/** First-line length before the sidebar tab title is cut. */
export const TAB_TITLE_LIMIT = 28;

export interface OpenChatTab {
  backendId?: string;
  threadId?: string;
  /** True when this tab has never been bound to a conversation. */
  blank: boolean;
}

export interface ChatTabState {
  backendId?: string;
  threadId?: string;
  blank: boolean;
  title?: string;
  /** The tab that was visible when the sidebar was last saved. */
  active?: boolean;
}

/**
 * Tab label for a user message or a stored history title.
 * Empty text stays `SideCode`. Only the first line is used, extra whitespace
 * collapses, and a long line is cut at {@link TAB_TITLE_LIMIT}.
 */
export function tabTitle(text: string | undefined): string {
  const line = text?.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, ' ').trim();
  if (!line) {
    return DEFAULT_TAB_TITLE;
  }
  if (line.length <= TAB_TITLE_LIMIT) {
    return line;
  }
  return `${line.slice(0, TAB_TITLE_LIMIT)}...`;
}

/**
 * A new chat focuses an existing blank tab. A history pick focuses the tab
 * that already has that thread. Anything else asks for a new tab.
 */
export function resolveChatTarget(
  tabs: readonly OpenChatTab[],
  request: { kind: 'new' } | { kind: 'thread'; backendId: string; threadId: string }
): { action: 'reveal'; index: number } | { action: 'create' } {
  if (request.kind === 'new') {
    const index = tabs.findIndex((tab) => tab.blank && !tab.threadId);
    return index >= 0 ? { action: 'reveal', index } : { action: 'create' };
  }
  const index = tabs.findIndex(
    (tab) => tab.backendId === request.backendId && tab.threadId === request.threadId
  );
  return index >= 0 ? { action: 'reveal', index } : { action: 'create' };
}

/**
 * Move the item with `id` to `toIndex` in the open-tab order.
 * Returns undefined when the id is missing or the index would not change the order.
 */
export function reorderById<T extends { id: string }>(
  items: readonly T[],
  id: string,
  toIndex: number
): T[] | undefined {
  const from = items.findIndex((item) => item.id === id);
  if (from < 0 || !Number.isInteger(toIndex) || toIndex < 0 || toIndex >= items.length || from === toIndex) {
    return undefined;
  }
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  if (!moved) {
    return undefined;
  }
  next.splice(toIndex, 0, moved);
  return next;
}

/** One saved sidebar tab, from workspace state. */
export function parseChatTabState(state: unknown): ChatTabState {
  if (!state || typeof state !== 'object') {
    return { blank: true };
  }
  const record = state as Record<string, unknown>;
  const threadId = typeof record.threadId === 'string' && record.threadId ? record.threadId : undefined;
  const backendId = typeof record.backendId === 'string' && record.backendId ? record.backendId : undefined;
  const title = typeof record.title === 'string' && record.title.trim() ? record.title : undefined;
  return {
    blank: !(threadId && backendId),
    ...(backendId ? { backendId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(title ? { title } : {}),
    ...(record.active === true ? { active: true } : {})
  };
}
