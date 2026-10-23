/**
 * The inline error for the browser tab's address bar, or an empty string.
 *
 * Pure and self-contained so the same source can be serialized into the
 * panel's script. It mirrors the host's http(s)-only preflight, so an obvious
 * typo is reported in the tab instead of being posted and refused later.
 */
export function urlInputError(value: string): string {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url) {
    return 'Enter an http or https address.';
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? ''
      : 'Only http and https addresses can be opened.';
  } catch {
    return 'Only http and https addresses can be opened.';
  }
}
