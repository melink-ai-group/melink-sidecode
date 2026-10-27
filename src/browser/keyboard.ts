/**
 * Key names for the browser panel's user input.
 *
 * The panel forwards each keydown/keyup with the DOM's `event.key`, so held
 * modifiers reach the same Playwright page as a click or shortcut. Composition
 * keys and dead keys produce text through `compositionend`/paste instead, so
 * they are not key presses.
 */

/**
 * A DOM `KeyboardEvent.key` as the key name Playwright's `keyboard.down` and
 * `keyboard.up` accept. Undefined means "do not forward this key".
 */
export function normalizeKey(key: string): string | undefined {
  const value = typeof key === 'string' ? key : '';
  if (!value) {
    return undefined;
  }
  if (value === ' ' || value === 'Spacebar') {
    return 'Space';
  }
  if (value === 'Esc') {
    return 'Escape';
  }
  if (value === 'Unidentified' || value === 'Dead' || value === 'Process' || value === 'AltGraph') {
    return undefined;
  }
  return value;
}
