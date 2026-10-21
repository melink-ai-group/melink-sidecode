import type { TranscriptItem } from './types.ts';

/** OpenCode updates a call under the same id as it acquires paths and output. */
export function mergeTranscriptTool(item: TranscriptItem, incoming: TranscriptItem): TranscriptItem {
  return {
    ...item,
    ...Object.fromEntries(Object.entries(incoming).filter(([, value]) => value !== undefined)),
    files: incoming.files?.length ? incoming.files : item.files,
    text: incoming.text || item.text
  };
}
