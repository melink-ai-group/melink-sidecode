import type { JSX, ReactNode } from 'react';

/**
 * Minimal markdown renderer for agent output.
 *
 * This deliberately covers the subset the transcript needs - paragraphs,
 * fenced code blocks, headings, lists, blockquotes and inline code/emphasis/
 * links - and returns React nodes. It never builds an HTML string, so provider
 * output cannot inject markup into the webview.
 */

type Block =
  | { kind: 'code'; language: string; lines: string[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: string[] };

const FENCE = /^\s*```\s*([\w.+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
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
      index += 1; // consume closing fence (or run out cleanly)
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
    while (
      index < lines.length &&
      lines[index].trim() !== '' &&
      !FENCE.test(lines[index]) &&
      !HEADING.test(lines[index]) &&
      !QUOTE.test(lines[index]) &&
      !UL.test(lines[index]) &&
      !OL.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }

  return blocks;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  INLINE.lastIndex = 0;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    const token = match[0];
    const tokenKey = `${keyPrefix}-i${key++}`;
    if (token.startsWith('`')) {
      nodes.push(
        <code className="md__code" key={tokenKey}>
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={tokenKey}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={tokenKey}>{token.slice(1, -1)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (link) {
        nodes.push(
          <a className="md__link" href={link[2]} key={tokenKey} rel="noreferrer noopener">
            {link[1]}
          </a>
        );
      } else {
        nodes.push(token);
      }
    }
    last = match.index + token.length;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes;
}

export interface MarkdownProps {
  text: string;
  /** Rendered language label and copy affordance on fenced blocks. */
  renderCodeHeader?: (language: string, code: string) => ReactNode;
}

export function Markdown({ text, renderCodeHeader }: MarkdownProps): JSX.Element {
  const blocks = parseBlocks(text);
  return (
    <div className="md">
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case 'code': {
            const code = block.lines.join('\n');
            return (
              <figure className="code-block" key={key}>
                <figcaption className="code-head">
                  <span>{block.language || 'text'}</span>
                  {renderCodeHeader?.(block.language, code)}
                </figcaption>
                <pre>
                  <code>{code}</code>
                </pre>
              </figure>
            );
          }
          case 'heading': {
            const level = Math.min(block.level + 2, 6);
            const Tag = `h${level}` as 'h3';
            return (
              <Tag className="md__heading" key={key}>
                {renderInline(block.text, key)}
              </Tag>
            );
          }
          case 'quote':
            return (
              <blockquote className="md__quote" key={key}>
                {renderInline(block.lines.join('\n'), key)}
              </blockquote>
            );
          case 'list': {
            const items = block.items.map((item, itemIndex) => (
              <li key={`${key}-l${itemIndex}`}>{renderInline(item, `${key}-l${itemIndex}`)}</li>
            ));
            return block.ordered ? (
              <ol className="md__list" key={key}>
                {items}
              </ol>
            ) : (
              <ul className="md__list" key={key}>
                {items}
              </ul>
            );
          }
          default:
            return (
              <p className="md__p" key={key}>
                {renderInline(block.text, key)}
              </p>
            );
        }
      })}
    </div>
  );
}
