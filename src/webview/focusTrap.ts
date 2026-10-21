/**
 * The controls a dialog may hand focus to, in document order. Disabled and
 * hidden controls, and anything explicitly removed from the tab order
 * (`tabindex="-1"`), are excluded so a trap never lands on an unreachable node.
 */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

/**
 * The next focus position for a wrapping Tab/Shift+Tab cycle.
 *
 * `currentIndex` may be outside the controls (for example when focus is still
 * in the chat behind the dialog); forward then starts at the first control and
 * backward at the last. A zero-control dialog has no position to move to.
 */
export function nextFocusIndex(count: number, currentIndex: number, shift: boolean): number {
  if (count <= 0) {
    return -1;
  }
  if (currentIndex < 0 || currentIndex >= count) {
    return shift ? count - 1 : 0;
  }
  if (shift) {
    return currentIndex === 0 ? count - 1 : currentIndex - 1;
  }
  return currentIndex === count - 1 ? 0 : currentIndex + 1;
}

/**
 * Where focus goes when a destructive confirmation closes. A still-usable
 * trigger gets focus back; a trigger that the follow-up review repaint disabled
 * (or removed) hands off to the always-enabled dialog header instead.
 */
export function confirmRestoreTarget(triggerUsable: boolean): 'trigger' | 'header' {
  return triggerUsable ? 'trigger' : 'header';
}

/** The visible, enabled controls of a dialog, in document order. */
export function focusableControls(root: Element | null): HTMLElement[] {
  if (!root) {
    return [];
  }
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return nodes.filter((node) => {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    if (node.tabIndex < 0) {
      return false;
    }
    return node.getClientRects().length > 0;
  });
}

/**
 * Keep Tab and Shift+Tab inside `root`, wrapping at the edges. Returns true
 * when the event was a Tab that the trap handled, so callers can stop there.
 */
export function trapTab(event: KeyboardEvent, root: Element | null): boolean {
  if (event.key !== 'Tab') {
    return false;
  }
  const controls = focusableControls(root);
  const active = document.activeElement;
  const currentIndex = active instanceof HTMLElement ? controls.indexOf(active) : -1;
  const target = nextFocusIndex(controls.length, currentIndex, event.shiftKey);
  event.preventDefault();
  if (target < 0) {
    if (root instanceof HTMLElement) {
      root.focus();
    }
    return true;
  }
  controls[target].focus();
  return true;
}
