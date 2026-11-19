/**
 * Sidebar chat-tab titles and which open tab a new chat or history pick should use.
 * Pure data so the host can share the rule with tests; no VS Code types.
 */
import { parseStoredComposer, type StoredComposer } from './composerControls.ts';

export const DEFAULT_TAB_TITLE = 'sideCode';

/** First-line length before the sidebar tab title is cut. */
export const TAB_TITLE_LIMIT = 28;

export interface OpenChatTab {
  backendId?: string;
  threadId?: string;
  /** True when this tab has never been bound to a conversation. */
  blank: boolean;
}

/** Unsent composer text is capped so a workspace-state write stays bounded. */
export const COMPOSER_DRAFT_LIMIT = 200_000;

/** Attachment metadata stored with an open tab. File bytes are never included. */
export interface DraftAttachment {
  id: string;
  name: string;
  path?: string;
  mimeType: string;
  size?: number;
  kind: 'image' | 'audio' | 'text' | 'file';
}

export interface ChatTabState extends StoredComposer {
  /**
   * Stable tab id, so a queue persisted against this chat can find it again
   * after a reload. Older saved records omit it and get a fresh id.
   */
  tabId?: string;
  backendId?: string;
  threadId?: string;
  blank: boolean;
  title?: string;
  /** The tab that was visible when the sidebar was last saved. */
  active?: boolean;
  /** Unsent composer text for this tab. */
  draftText?: string;
  /** Unsent composer files for this tab. Metadata only. */
  draftAttachments?: DraftAttachment[];
  planContextExcluded?: boolean;
}

/**
 * Tab label for a user message or a stored history title.
 * Empty text stays `sideCode`. Only the first line is used, extra whitespace
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

const DRAFT_KINDS = new Set<DraftAttachment['kind']>(['image', 'audio', 'text', 'file']);

/** One saved sidebar tab, from workspace state. */
export function parseChatTabState(state: unknown): ChatTabState {
  if (!state || typeof state !== 'object') {
    return { blank: true };
  }
  const record = state as Record<string, unknown>;
  const threadId = typeof record.threadId === 'string' && record.threadId ? record.threadId : undefined;
  const backendId = typeof record.backendId === 'string' && record.backendId ? record.backendId : undefined;
  const title = typeof record.title === 'string' && record.title.trim() ? record.title : undefined;
  const tabId = typeof record.tabId === 'string' && record.tabId ? record.tabId : undefined;
  const draftText = parseDraftText(record.draftText);
  const draftAttachments = parseDraftAttachments(record.draftAttachments);
  const composer = parseStoredComposer(record);
  return {
    blank: !(threadId && backendId),
    ...(tabId ? { tabId } : {}),
    ...(backendId ? { backendId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(title ? { title } : {}),
    ...(record.active === true ? { active: true } : {}),
    ...(draftText ? { draftText } : {}),
    ...(draftAttachments.length > 0 ? { draftAttachments } : {}),
    ...(record.planContextExcluded === true ? { planContextExcluded: true } : {}),
    ...composer
  };
}

function parseDraftText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.slice(0, COMPOSER_DRAFT_LIMIT);
  return text.length > 0 ? text : undefined;
}

/** Drop malformed chips. Inline bytes are ignored even if a saved record has them. */
export function parseDraftAttachments(value: unknown): DraftAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const attachments: DraftAttachment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const kind = record.kind;
    if (typeof record.id !== 'string' || !record.id) {
      continue;
    }
    if (typeof record.name !== 'string' || !record.name) {
      continue;
    }
    if (typeof record.mimeType !== 'string' || !record.mimeType) {
      continue;
    }
    if (typeof kind !== 'string' || !DRAFT_KINDS.has(kind as DraftAttachment['kind'])) {
      continue;
    }
    const path = typeof record.path === 'string' && record.path ? record.path : undefined;
    const size = typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : undefined;
    attachments.push({
      id: record.id,
      name: record.name,
      mimeType: record.mimeType,
      kind: kind as DraftAttachment['kind'],
      ...(path ? { path } : {}),
      ...(size !== undefined ? { size } : {})
    });
  }
  return attachments;
}
