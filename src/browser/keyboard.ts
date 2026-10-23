/**
 * Turn a webview keydown event into the chord Playwright's `keyboard.press`
 * accepts, such as `Control+Shift+ArrowLeft`. Pure and self-contained so the
 * same source can be serialized into the panel's script.
 */
export interface KeyEventLike {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export function composeKey(event: KeyEventLike): string {
  const key = typeof event.key === 'string' ? event.key : '';
  if (!key) {
    return '';
  }
  if (key === 'Control' || key === 'Alt' || key === 'Meta' || key === 'Shift') {
    return key;
  }
  const parts: string[] = [];
  if (event.ctrlKey) {
    parts.push('Control');
  }
  if (event.altKey) {
    parts.push('Alt');
  }
  if (event.metaKey) {
    parts.push('Meta');
  }
  if (event.shiftKey) {
    parts.push('Shift');
  }
  if (parts.length === 0) {
    return key;
  }
  return [...parts, key].join('+');
}
