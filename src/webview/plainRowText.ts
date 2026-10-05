/**
 * Words for a one-line chat row. Bold, code, and link markers stay in the
 * expanded reply; the title line shows the text without them.
 */
export function plainRowText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1 ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
