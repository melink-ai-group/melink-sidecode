/** Keep the inline review to the first lines of an expanded file. */
export { capReviewLines } from '../changes/reviewLines';

export function messagePreview(text: string | undefined, fallback: string): string {
  const line = (text ?? '').trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!line) {
    return fallback;
  }
  return line.length > 80 ? `${line.slice(0, 80)}...` : line;
}

export function userMessageTime(id: string): number | undefined {
  const match = /^user_(\d+)_/.exec(id);
  return match ? Number(match[1]) : undefined;
}
