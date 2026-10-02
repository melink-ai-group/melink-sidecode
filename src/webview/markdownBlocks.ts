/**
 * Block parser for agent markdown.
 *
 * Covers the subset the transcript needs: paragraphs, fenced code, headings,
 * lists, blockquotes, and tables. Inline marks stay as text so the renderer
 * can turn them into nodes without building an HTML string.
 */

export type MarkdownBlock =
  | { kind: 'code'; language: string; lines: string[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; headers: string[]; rows: string[][] };

const FENCE = /^\s*```\s*([\w.+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const language = fence[1] ?? '';
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: 'code', language, lines: body });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        body.push(QUOTE.exec(lines[index])?.[1] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'quote', lines: body });
      continue;
    }

    const table = readTable(lines, index);
    if (table) {
      blocks.push(table.block);
      index = table.next;
      continue;
    }

    if (UL.test(line) || OL.test(line)) {
      const ordered = OL.test(line);
      const items: string[] = [];
      const pattern = ordered ? OL : UL;
      while (index < lines.length && pattern.test(lines[index])) {
        items.push((pattern.exec(lines[index]) as RegExpExecArray)[1]);
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && continuesParagraph(lines, index)) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }

  return blocks;
}

function continuesParagraph(lines: readonly string[], index: number): boolean {
  const line = lines[index];
  if (line.trim() === '') {
    return false;
  }
  return (
    !FENCE.test(line) &&
    !HEADING.test(line) &&
    !QUOTE.test(line) &&
    !UL.test(line) &&
    !OL.test(line) &&
    !isTableStart(lines, index)
  );
}

function isTableStart(lines: readonly string[], index: number): boolean {
  return isTableRow(lines[index] ?? '') && isTableDelimiter(lines[index + 1] ?? '');
}

function readTable(
  lines: readonly string[],
  index: number
): { block: Extract<MarkdownBlock, { kind: 'table' }>; next: number } | undefined {
  if (!isTableStart(lines, index)) {
    return undefined;
  }
  const headers = splitTableCells(lines[index]);
  const width = headers.length;
  let next = index + 2;
  const rows: string[][] = [];
  while (next < lines.length && lines[next].trim() !== '' && isTableRow(lines[next]) && !isTableDelimiter(lines[next])) {
    rows.push(fitCells(splitTableCells(lines[next]), width));
    next += 1;
  }
  return {
    block: { kind: 'table', headers: fitCells(headers, width), rows },
    next
  };
}

function isTableRow(line: string): boolean {
  return splitTableCells(line).length >= 2 && line.includes('|');
}

function isTableDelimiter(line: string): boolean {
  const cells = splitTableCells(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function splitTableCells(line: string): string[] {
  let text = line.trim();
  if (!text.includes('|')) {
    return [text];
  }
  if (text.startsWith('|')) {
    text = text.slice(1);
  }
  if (text.endsWith('|')) {
    text = text.slice(0, -1);
  }
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\' && text[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (text[i] === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += text[i];
  }
  cells.push(current.trim());
  return cells;
}

function fitCells(cells: readonly string[], width: number): string[] {
  const next = cells.slice(0, width);
  while (next.length < width) {
    next.push('');
  }
  return next;
}
