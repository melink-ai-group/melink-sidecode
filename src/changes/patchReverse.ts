/**
 * Rebuild the pre-edit text of a file from its post-edit text and the unified
 * diffs a backend reported for that edit.
 *
 * A turn often learns about a file only after the write, so there is no
 * pre-turn snapshot. Diffing the finished file against empty content then
 * reports every line as added. Reversing the reported patch recovers the
 * bytes the edit actually replaced, and a patch that does not apply cleanly
 * returns `undefined` so the caller can keep its existing fallback.
 */

interface HunkLine {
  kind: 'context' | 'add' | 'del';
  text: string;
}

interface Hunk {
  /** 1-based start of this hunk in the post-edit file, when the header has one. */
  newStart?: number;
  lines: HunkLine[];
}

/**
 * The file text before a series of exact replacements, or `undefined` when
 * none of them can be undone uniquely.
 *
 * Replacements are undone last-to-first. A new string that occurs more than
 * once is skipped rather than applied at a guess, so a wrong baseline is not
 * stored as the pre-change snapshot.
 */
export function contentBeforeReplacements(
  after: string,
  replacements: readonly { before: string; after: string }[]
): string | undefined {
  let current = after;
  let changed = false;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const piece = replacements[index];
    if (!piece || piece.after.length === 0 || piece.before === piece.after) {
      continue;
    }
    const at = current.indexOf(piece.after);
    if (at < 0 || at !== current.lastIndexOf(piece.after)) {
      continue;
    }
    current = current.slice(0, at) + piece.before + current.slice(at + piece.after.length);
    changed = true;
  }
  return changed && current !== after ? current : undefined;
}

/** The file text before `diffs` were applied, or `undefined` when none apply. */
export function contentBeforePatches(after: string, diffs: readonly string[]): string | undefined {
  const unique: string[] = [];
  for (const diff of diffs) {
    if (diff.trim().length === 0 || unique.includes(diff)) {
      continue;
    }
    unique.push(diff);
  }
  if (unique.length === 0) {
    return undefined;
  }
  const combined = applyReverseAll(after, unique);
  if (combined !== undefined && combined !== after) {
    return combined;
  }
  // A later notification can repeat the same edit in a different patch shape.
  // Use the latest patch that actually applies rather than failing the set.
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const single = reverseApply(after, unique[index]);
    if (single !== undefined && single !== after) {
      return single;
    }
  }
  return undefined;
}

function applyReverseAll(after: string, diffs: readonly string[]): string | undefined {
  let current = after;
  for (let index = diffs.length - 1; index >= 0; index -= 1) {
    const previous = reverseApply(current, diffs[index]);
    if (previous === undefined) {
      return undefined;
    }
    current = previous;
  }
  return current;
}

function reverseApply(after: string, diff: string): string | undefined {
  const hunks = parseHunks(diff);
  if (hunks.length === 0) {
    return undefined;
  }
  const trailingNewline = after.endsWith('\n');
  const lines = splitLines(after);
  let cursor = 0;
  for (const hunk of hunks) {
    const needle = hunk.lines.filter((line) => line.kind !== 'del').map((line) => line.text);
    const replacement = hunk.lines.filter((line) => line.kind !== 'add').map((line) => line.text);
    if (needle.length === 0) {
      const at = hunk.newStart !== undefined ? Math.max(0, Math.min(lines.length, hunk.newStart - 1)) : -1;
      if (at < 0) {
        return undefined;
      }
      lines.splice(at, 0, ...replacement);
      cursor = at + replacement.length;
      continue;
    }
    const hint = hunk.newStart !== undefined ? hunk.newStart - 1 : cursor;
    const found = findSequence(lines, needle, hint);
    if (found < 0) {
      return undefined;
    }
    lines.splice(found, needle.length, ...replacement);
    cursor = found + replacement.length;
  }
  return joinLines(lines, trailingNewline && lines.length > 0);
}

function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const line of diff.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    if (line.startsWith('@@')) {
      current = { newStart: newStartOf(line), lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith('\\')) {
      continue;
    }
    if (line.startsWith('+')) {
      current.lines.push({ kind: 'add', text: line.slice(1) });
      continue;
    }
    if (line.startsWith('-')) {
      current.lines.push({ kind: 'del', text: line.slice(1) });
      continue;
    }
    if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', text: line.slice(1) });
      continue;
    }
    // A blank line, file header, or apply_patch wrapper ends the hunk. An
    // empty context line is a single space and is handled above.
    current = undefined;
  }
  return hunks.filter((hunk) => hunk.lines.some((line) => line.kind !== 'context'));
}

function newStartOf(header: string): number | undefined {
  const match = /@@ -\d+(?:,\d+)? \+(\d+)/.exec(header);
  if (!match) {
    return undefined;
  }
  const start = Number(match[1]);
  return Number.isFinite(start) ? start : undefined;
}

function findSequence(lines: readonly string[], needle: readonly string[], hint: number): number {
  const tryAt = (index: number): boolean => {
    if (index < 0 || index + needle.length > lines.length) {
      return false;
    }
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (lines[index + offset] !== needle[offset]) {
        return false;
      }
    }
    return true;
  };
  const start = Math.max(0, Math.min(hint, Math.max(0, lines.length - needle.length)));
  if (tryAt(start)) {
    return start;
  }
  for (let index = start + 1; index <= lines.length - needle.length; index += 1) {
    if (tryAt(index)) {
      return index;
    }
  }
  for (let index = start - 1; index >= 0; index -= 1) {
    if (tryAt(index)) {
      return index;
    }
  }
  return -1;
}

function splitLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const parts = normalized.split('\n');
  if (normalized.endsWith('\n')) {
    parts.pop();
  }
  return parts;
}

function joinLines(lines: readonly string[], trailingNewline: boolean): string {
  if (lines.length === 0) {
    return '';
  }
  const body = lines.join('\n');
  return trailingNewline ? `${body}\n` : body;
}
