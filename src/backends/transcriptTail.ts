import type { TranscriptItem } from './types.ts';

/**
 * The workspace-state copy of a transcript is only a fallback for when the
 * full file under the storage directory cannot be read. Tool output in that
 * copy used to grow without a bound and made opening the sidebar rewrite tens
 * of megabytes before any message could be painted.
 */
export const WORKSPACE_TAIL_ITEMS = 16;
const MAX_TAIL_STRING = 1_000;
const MAX_TAIL_ARRAY = 30;
const MAX_TAIL_DEPTH = 6;
const DROPPED_KEYS = new Set(['dataUrl', 'lines']);

/** The recent rows kept in workspace state, with bulky text removed. */
export function workspaceTranscriptTail(items: readonly TranscriptItem[]): TranscriptItem[] {
  return items.slice(-WORKSPACE_TAIL_ITEMS).map((item) => slim(item, 0) as TranscriptItem);
}

/**
 * Tails for threads whose full transcript is safely on disk. A thread that
 * could not be written keeps `previous` when that is the only copy, so a
 * failed file write does not discard the chat.
 */
export function workspaceTranscriptIndex(
  current: Readonly<Record<string, readonly TranscriptItem[]>>,
  writtenKeys: ReadonlySet<string>,
  previous: Readonly<Record<string, readonly TranscriptItem[]>> = {}
): Record<string, TranscriptItem[]> {
  const next: Record<string, TranscriptItem[]> = {};
  for (const [key, items] of Object.entries(current)) {
    if (writtenKeys.has(key)) {
      next[key] = workspaceTranscriptTail(items);
    } else if (previous[key]) {
      next[key] = previous[key].slice();
    } else {
      next[key] = items.slice();
    }
  }
  return next;
}

function slim(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_TAIL_STRING ? value.slice(0, MAX_TAIL_STRING) : value;
  }
  if (value === null || typeof value !== 'object' || depth >= MAX_TAIL_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_TAIL_ARRAY).map((entry) => slim(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (DROPPED_KEYS.has(key)) {
      continue;
    }
    out[key] = slim(entry, depth + 1);
  }
  return out;
}
