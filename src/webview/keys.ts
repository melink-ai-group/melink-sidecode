/**
 * Minimal structural view of a keyboard event. It intentionally avoids DOM
 * types so this helper stays host-free and testable without jsdom.
 */
export interface EnterLikeEvent {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
}

/**
 * True only for a plain Enter that should submit/save.
 *
 * Enter pressed while an IME (Japanese, Chinese, Korean, …) is composing must
 * commit the candidate instead of submitting. Browsers report that state as
 * `isComposing` (modern) or `keyCode === 229` (legacy fallback); Shift+Enter is
 * reserved for a newline.
 */
export function isSubmitEnter(event: EnterLikeEvent): boolean {
  if (event.key !== 'Enter') {
    return false;
  }
  if (event.shiftKey) {
    return false;
  }
  if (event.isComposing === true || event.nativeEvent?.isComposing === true) {
    return false;
  }
  if (event.keyCode === 229 || event.nativeEvent?.keyCode === 229) {
    return false;
  }
  return true;
}
