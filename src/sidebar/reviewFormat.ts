import type { ChangeHunkView } from '../changes/changeStore';

/** Keep the inline review to the first lines of an expanded file. */
export function capReviewLines(hunks: ChangeHunkView[], limit: number): { hunks: ChangeHunkView[]; truncated: boolean } {
  let remaining = limit;
  let truncated = false;
  const capped: ChangeHunkView[] = [];
  for (const hunk of hunks) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const lines = hunk.lines.slice(0, remaining);
    if (lines.length < hunk.lines.length) {
      truncated = true;
    }
    remaining -= lines.length;
    capped.push({ ...hunk, lines });
  }
  return { hunks: capped, truncated };
}

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
