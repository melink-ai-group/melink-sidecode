import type { ChangeFileView, ChangeView } from '../changes/changeStore.ts';
import { REVIEW_HUNK_LINE_LIMIT, capReviewLines } from '../changes/reviewLines.ts';
import {
  boundDiffFiles,
  type DiffReviewFile,
  type DiffReviewInput
} from './diffReview.ts';
import type { StylingBrandKitFile, StylingReviewInput } from './stylingReview.ts';

/**
 * Turn a finished change review into the bounded input the diff reviewer sees.
 *
 * The input builder is host-free and deterministic. It renders the same first
 * {@link REVIEW_HUNK_LINE_LIMIT} lines per file the inline review shows, then
 * applies the diff-review caps, so a large turn cannot flood a local runner or
 * a future model prompt. The request is bounded too: only the opening message
 * text matters to this pass, not an unbounded transcript.
 */

/** Maximum characters of the user request included in a review prompt. */
export const DIFF_REVIEW_REQUEST_CHAR_LIMIT = 4_000;

/** Build the bounded reviewer input for one turn. */
export function buildTurnDiffReviewInput(view: ChangeView, request: string): DiffReviewInput {
  const files: DiffReviewFile[] = view.files.map((file) => ({
    path: file.path,
    diff: renderFileDiff(file)
  }));

  return {
    request: boundRequest(request),
    files: boundDiffFiles(files)
  };
}

/**
 * Build the styling reviewer input. The brand kit is bounded separately from
 * the diff so a large design document cannot crowd the changed code out of the
 * prompt; the local pass ignores it except for the token names it defines.
 */
export function buildTurnStylingReviewInput(
  view: ChangeView,
  request: string,
  brandKit: readonly StylingBrandKitFile[] = []
): StylingReviewInput {
  return {
    request: boundRequest(request),
    files: view.files.map((file) => ({
      path: file.path,
      diff: renderFileDiff(file)
    })),
    brandKit: brandKit.map((file) => ({
      path: file.path,
      text: file.text.length > 8_000 ? `${file.text.slice(0, 7_999)}…` : file.text
    }))
  };
}

function boundRequest(request: string): string {
  const text = request.trim();
  if (text.length <= DIFF_REVIEW_REQUEST_CHAR_LIMIT) {
    return text;
  }
  return `${text.slice(0, DIFF_REVIEW_REQUEST_CHAR_LIMIT - 1)}…`;
}

function renderFileDiff(file: ChangeFileView): string {
  if (file.hunks.length === 0) {
    if (file.binary) {
      return '[binary file changed; no diff text]';
    }
    return file.diffable
      ? '[file changed; no diff text]'
      : '[file changed; inline diff unavailable]';
  }

  const capped = capReviewLines(file.hunks, REVIEW_HUNK_LINE_LIMIT);
  const lines: string[] = [];
  for (const hunk of capped.hunks) {
    lines.push(hunk.header);
    for (const line of hunk.lines) {
      const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
      lines.push(`${prefix}${line.text}`);
      if (line.noNewline) {
        lines.push('\\ No newline at end of file');
      }
    }
  }
  if (capped.truncated) {
    lines.push('…');
  }
  return lines.join('\n');
}
