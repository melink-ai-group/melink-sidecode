/**
 * Click guard for the expanded reasoning body. The body toggles on click, but
 * a click that ends a text selection (select-then-release) or lands on an
 * interactive/code element must not collapse the card.
 *
 * `selectionText` is treated as a selection whenever it is non-empty, including
 * whitespace-only text. The caller passes the live selection string; this
 * helper stays DOM-free so it can be unit tested.
 */
export interface ReasoningClickInput {
  selectionText?: string;
  target?: { closest?: (selector: string) => unknown } | null;
}

export function shouldToggleReasoningBody(input: ReasoningClickInput): boolean {
  if (input.selectionText) return false;
  if (input.target?.closest) {
    const interactive = input.target.closest('a, button, code');
    if (interactive) return false;
  }
  return true;
}
