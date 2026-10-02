/**
 * The last sentence of a settled reply is the result the user should read.
 * When that sentence follows other content, lift it out so it is not buried
 * in the checklist, table, or notes above it.
 */

import { parseMarkdownBlocks } from './markdownBlocks.ts';

export interface ReplyParts {
  body: string;
  close?: string;
}

const SENTENCE_BREAK = /(?<!\d)[.!?]\s+(?=[A-Z])/g;
const MIN_CLOSE = 12;
const MAX_CLOSE = 320;

/**
 * Split a trailing result sentence off a reply. A reply that is only that
 * sentence, or that ends on a list, table, or code block, stays whole.
 */
export function splitReplyClose(source: string): ReplyParts {
  const normalized = source.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
  if (!normalized) {
    return { body: source };
  }
  const blocks = parseMarkdownBlocks(normalized);
  const last = blocks[blocks.length - 1];
  if (!last || last.kind !== 'paragraph') {
    return { body: source };
  }
  const paragraph = last.text.trim();
  const flat = paragraph.replace(/\s*\n\s*/g, ' ').trim();
  const close = trailingSentence(flat);
  if (!close) {
    return { body: source };
  }
  const earlierBlocks = blocks.length > 1;
  const earlierInParagraph = flat !== close;
  if (!earlierBlocks && !earlierInParagraph) {
    return { body: source };
  }
  if (!normalized.endsWith(paragraph)) {
    return { body: source };
  }
  if (!earlierInParagraph) {
    const body = normalized.slice(0, normalized.length - paragraph.length).trim();
    if (!body) {
      return { body: source };
    }
    return { body, close };
  }
  const kept = flat.slice(0, flat.length - close.length).trim();
  if (!kept) {
    return { body: source };
  }
  const body = (normalized.slice(0, normalized.length - paragraph.length) + kept).trim();
  if (!body) {
    return { body: source };
  }
  return { body, close };
}

function trailingSentence(flat: string): string | undefined {
  if (!/[.!?]$/.test(flat)) {
    return undefined;
  }
  SENTENCE_BREAK.lastIndex = 0;
  const breaks = [...flat.matchAll(SENTENCE_BREAK)];
  const lastBreak = breaks[breaks.length - 1];
  const start = lastBreak?.index === undefined ? 0 : lastBreak.index + lastBreak[0].length;
  const sentence = flat.slice(start).trim();
  if (sentence.length < MIN_CLOSE || sentence.length > MAX_CLOSE) {
    return undefined;
  }
  if (start === 0 && flat.length > MAX_CLOSE) {
    return undefined;
  }
  return sentence;
}
