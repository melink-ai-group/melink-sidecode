/** How the mic button should look while a dictation status is current. */
export type DictationVisual = 'idle' | 'starting' | 'listening' | 'downloading' | 'working';

export function dictationVisual(status: string | undefined, listening: boolean, cleaning: boolean): DictationVisual {
  const text = status ?? '';
  if (/download/i.test(text)) {
    return 'downloading';
  }
  if (cleaning || /transcrib|prepar|clean|finish|speech model|recording limit/i.test(text)) {
    return 'working';
  }
  if (listening && /listen/i.test(text)) {
    return 'listening';
  }
  if (listening || /start/i.test(text)) {
    return 'starting';
  }
  return 'idle';
}

/** Append a cleaned or raw dictation line without dropping text already in the draft. */
export function appendDraft(current: string, addition: string): string {
  const extra = addition.trim();
  if (!extra) {
    return current;
  }
  const base = current.trimEnd();
  return base ? `${base}\n${extra}` : extra;
}
