/**
 * The line-based unified diff for the change review surface.
 *
 * This is deliberately in-repo and dependency-free: the extension ships as an
 * esbuild bundle served under a nonce-shaped CSP, so adding a runtime diff
 * package would mean another vendored dependency and another supply-chain
 * surface for a piece of well-understood logic. The algorithm is a compact
 * Myers O(ND) diff over lines, wrapped in the usual prefix/suffix trim so the
 * common case (a small change in a large file) never touches the quadratic
 * middle.
 *
 * ## Contracts
 *
 * - **Deterministic.** Identical inputs produce byte-identical output: no
 *   clocks, no locale, no random ids. Hunk ordering is the file's own order.
 * - **Line-ending tolerant.** A line is compared by its text with a trailing
 *   `\r` stripped, so a CRLF file and an LF file with the same content produce
 *   no hunks. A line-ending-only rewrite is therefore not reported as a change.
 * - **Trailing newline aware.** A file with no trailing newline is diffed
 *   honestly: the final line's newline flag is part of its identity, and the
 *   affected output line carries `noNewline: true`.
 * - **Targetable.** Every hunk has a stable `id` derived from its header and
 *   body, so a decision can name a hunk without an index that could drift.
 * - **Host-free.** No `vscode` import and no I/O, so `npm test` drives it with
 *   plain strings, and `applyRejectedHunks` can reverse a selected subset of
 *   hunks without a workspace.
 */

import { hashText } from './hash.ts';

export type DiffLineKind = 'context' | 'add' | 'del';

/** One rendered line of a hunk. */
export interface DiffLine {
  kind: DiffLineKind;
  /** The line's text, with any trailing `\r`/`\n` removed. */
  text: string;
  /** True on the last line of a side that has no trailing newline. */
  noNewline?: boolean;
}

/** One `@@` hunk, with its header and per-hunk counts. */
export interface DiffHunk {
  /** Stable identity: the same hunk content yields the same id across runs. */
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The literal `@@ -a,b +c,d @@` header. */
  header: string;
  lines: DiffLine[];
  additions: number;
  deletions: number;
}

/** The whole-file diff, including per-file added/removed line counts. */
export interface FileDiff {
  path: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

/**
 * Bound the Myers trace by its actual memory cost. A product-based cutoff makes
 * even a large file with just one or two edits appear as a full replacement;
 * sparse edits are cheap for Myers regardless of file length. For genuinely
 * very different middles, retain the bounded coarse fallback.
 */
const MAX_TRACE_CELLS = 2_000_000;

/** Default context lines shown around a change, matching `git diff -U3`. */
export const DEFAULT_CONTEXT = 3;

/**
 * A source line, kept with its exact raw bytes (so a CRLF file's `\r` survives
 * reconstruction) and whether it was terminated by a newline.
 */
interface TextLine {
  raw: string;
  newline: boolean;
}

type Edit =
  | { kind: 'equal'; a: number; b: number }
  | { kind: 'del'; a: number }
  | { kind: 'add'; b: number };

interface Row {
  kind: DiffLineKind;
  old?: number;
  new?: number;
  line: TextLine;
}

interface InternalHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  rows: Row[];
}

function lineText(line: TextLine): string {
  return line.raw.endsWith('\r') ? line.raw.slice(0, -1) : line.raw;
}

/** Split content into lines, capturing each raw line and its newline flag. */
function splitLines(content: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) !== 10) {
      continue;
    }
    lines.push({ raw: content.slice(start, i), newline: true });
    start = i + 1;
  }
  // A final segment without a newline is a real line that must not be dropped.
  if (start < content.length) {
    lines.push({ raw: content.slice(start), newline: false });
  }
  return lines;
}

/** Join raw lines back into content, preserving each line's ending. */
function joinLines(lines: readonly TextLine[]): string {
  return lines.map((line) => (line.newline ? `${line.raw}\n` : line.raw)).join('');
}

function sameLine(a: TextLine, b: TextLine): boolean {
  return lineText(a) === lineText(b) && a.newline === b.newline;
}

/**
 * The edit script between two line arrays. Common prefix and suffix are matched
 * for free, then Myers runs only on the differing middle.
 */
function editScript(a: TextLine[], b: TextLine[]): Edit[] {
  let start = 0;
  while (start < a.length && start < b.length && sameLine(a[start], b[start])) {
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && sameLine(a[endA - 1], b[endB - 1])) {
    endA -= 1;
    endB -= 1;
  }

  const edits: Edit[] = [];
  for (let i = 0; i < start; i += 1) {
    edits.push({ kind: 'equal', a: i, b: i });
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length === 0) {
    for (let j = 0; j < midB.length; j += 1) {
      edits.push({ kind: 'add', b: start + j });
    }
  } else if (midB.length === 0) {
    for (let i = 0; i < midA.length; i += 1) {
      edits.push({ kind: 'del', a: start + i });
    }
  } else {
    edits.push(...myers(midA, midB, start));
  }

  for (let i = endA; i < a.length; i += 1) {
    edits.push({ kind: 'equal', a: i, b: endB + (i - endA) });
  }
  return edits;
}

/**
 * Myers O(ND) shortest edit script for the differing middle, with original
 * indices re-based by `offset`. Falls back to a coarse block replacement when
 * the middle is too large to trace.
 */
function myers(a: TextLine[], b: TextLine[], offset: number): Edit[] {
  const n = a.length;
  const m = b.length;
  const traceWidth = 2 * (n + m) + 1;
  if (traceWidth > MAX_TRACE_CELLS) {
    const coarse: Edit[] = [];
    for (let i = 0; i < n; i += 1) {
      coarse.push({ kind: 'del', a: offset + i });
    }
    for (let j = 0; j < m; j += 1) {
      coarse.push({ kind: 'add', b: offset + j });
    }
    return coarse;
  }

  const max = n + m;
  const base = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  let foundD = -1;
  for (let d = 0; d <= max && foundD === -1; d += 1) {
    // The trace stores one full frontier per edit-distance layer. Stop before
    // that history grows without bound, while allowing sparse edits in large
    // files to complete with accurate counts.
    if (d > 0 && traceWidth * d > MAX_TRACE_CELLS) {
      const coarse: Edit[] = [];
      for (let i = 0; i < n; i += 1) coarse.push({ kind: 'del', a: offset + i });
      for (let j = 0; j < m; j += 1) coarse.push({ kind: 'add', b: offset + j });
      return coarse;
    }
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const index = base + k;
      let x: number;
      if (k === -d || (k !== d && v[index - 1] < v[index + 1])) {
        x = v[index + 1];
      } else {
        x = v[index - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && sameLine(a[x], b[y])) {
        x += 1;
        y += 1;
      }
      v[index] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break;
      }
    }
  }

  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = foundD; d > 0; d -= 1) {
    const previous = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && previous[base + k - 1] < previous[base + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = previous[base + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      edits.push({ kind: 'equal', a: offset + x - 1, b: offset + y - 1 });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      edits.push({ kind: 'add', b: offset + y - 1 });
    } else {
      edits.push({ kind: 'del', a: offset + x - 1 });
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    edits.push({ kind: 'equal', a: offset + x - 1, b: offset + y - 1 });
    x -= 1;
    y -= 1;
  }
  return edits.reverse();
}

function toRows(edits: Edit[], a: TextLine[], b: TextLine[]): Row[] {
  return edits.map((edit) => {
    if (edit.kind === 'equal') {
      return { kind: 'context', old: edit.a + 1, new: edit.b + 1, line: a[edit.a] };
    }
    if (edit.kind === 'del') {
      return { kind: 'del', old: edit.a + 1, line: a[edit.a] };
    }
    return { kind: 'add', new: edit.b + 1, line: b[edit.b] };
  });
}

/**
 * Group change rows into hunks with `context` lines around each group. Two
 * change groups merge when their context windows would touch, so a hunk always
 * shows every change it spans plus the configured context.
 */
function computeHunks(rows: Row[], context: number): InternalHunk[] {
  const changeIndices = rows
    .map((row, index) => (row.kind === 'context' ? -1 : index))
    .filter((index) => index !== -1);
  if (changeIndices.length === 0) {
    return [];
  }

  const groups: Array<{ first: number; last: number }> = [];
  for (const index of changeIndices) {
    const group = groups[groups.length - 1];
    // Merge when the rows between the two changes are no wider than the two
    // context windows combined; otherwise they are two separate hunks.
    if (group && index - group.last <= 2 * context + 1) {
      group.last = index;
    } else {
      groups.push({ first: index, last: index });
    }
  }

  return groups.map((group) => {
    const from = Math.max(0, group.first - context);
    const to = Math.min(rows.length - 1, group.last + context);
    const slice = rows.slice(from, to + 1);
    const oldLines = slice.filter((row) => row.kind !== 'add').length;
    const newLines = slice.filter((row) => row.kind !== 'del').length;
    const oldStart = slice.find((row) => row.kind !== 'add')?.old ?? 0;
    const newStart = slice.find((row) => row.kind !== 'del')?.new ?? 0;
    return {
      oldStart,
      oldLines,
      newStart,
      newLines,
      header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
      rows: slice
    };
  });
}

function rowToLine(row: Row): DiffLine {
  const line: DiffLine = { kind: row.kind, text: lineText(row.line) };
  if (!row.line.newline) {
    line.noNewline = true;
  }
  return line;
}

function hunkId(header: string, rows: readonly Row[]): string {
  const body = rows
    .map((row) => `${row.kind}\u0000${lineText(row.line)}\u0000${row.line.newline ? 1 : 0}`)
    .join('\n');
  return hashText(`${header}\n${body}`);
}

function toPublicHunk(hunk: InternalHunk): DiffHunk {
  const lines = hunk.rows.map(rowToLine);
  return {
    id: hunkId(hunk.header, hunk.rows),
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    header: hunk.header,
    lines,
    additions: lines.filter((line) => line.kind === 'add').length,
    deletions: lines.filter((line) => line.kind === 'del').length
  };
}

/**
 * Diff two file contents line by line. `path` is echoed on the result for a
 * caller that renders a list; it never affects the diff.
 */
export function diffLines(
  before: string,
  after: string,
  path = '',
  context: number = DEFAULT_CONTEXT
): FileDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  const hunks = computeHunks(toRows(editScript(a, b), a, b), Math.max(0, context)).map(toPublicHunk);
  const additions = hunks.reduce((sum, hunk) => sum + hunk.additions, 0);
  const deletions = hunks.reduce((sum, hunk) => sum + hunk.deletions, 0);
  return { path, hunks, additions, deletions };
}

/**
 * Reconstruct the file content that results from rejecting a subset of hunks:
 * each named hunk's post-turn lines are replaced with its pre-turn lines, in
 * place, leaving every other hunk applied. Hunk ids come from `diffLines` with
 * the same context, so the selection is stable across a render and a decision.
 *
 * An empty selection returns `after` byte-for-byte, and selecting every hunk
 * returns the pre-turn line spelling (which the caller replaces with the exact
 * stored before bytes). Used only for a hunk-scoped reject; a whole-file reject
 * always restores the exact pre-turn bytes instead.
 */
export function applyRejectedHunks(
  before: string,
  after: string,
  rejectedHunkIds: ReadonlySet<string>,
  context: number = DEFAULT_CONTEXT
): string {
  if (rejectedHunkIds.size === 0) {
    return after;
  }
  const a = splitLines(before);
  const b = splitLines(after);
  const hunks = computeHunks(toRows(editScript(a, b), a, b), Math.max(0, context));
  const rejected = hunks
    .map((hunk) => ({ hunk, id: hunkId(hunk.header, hunk.rows) }))
    .filter((entry) => rejectedHunkIds.has(entry.id))
    .sort((x, y) => y.hunk.newStart - x.hunk.newStart);

  const lines = b.slice();
  for (const { hunk } of rejected) {
    const start = Math.max(0, hunk.newStart - 1);
    const oldSide = hunk.rows.filter((row) => row.kind !== 'add').map((row) => row.line);
    lines.splice(start, hunk.newLines, ...oldSide);
  }
  return joinLines(lines);
}
