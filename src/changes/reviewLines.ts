import type { ChangeHunkView } from './changeStore.ts';

/** How many hunk lines one expanded file shows inline. */
export const REVIEW_HUNK_LINE_LIMIT = 120;

/**
 * Keep an inline review to the first `limit` hunk lines.
 *
 * The host-free helper is shared by the change panel (on-demand hunk loading)
 * and the diff-review input builder, so both surfaces bound a file the same way
 * and a large turn cannot flood either one.
 */
export function capReviewLines(
  hunks: readonly ChangeHunkView[],
  limit: number
): { hunks: ChangeHunkView[]; truncated: boolean } {
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
