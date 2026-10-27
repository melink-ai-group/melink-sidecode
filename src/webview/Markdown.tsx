import { memo, type JSX, type ReactNode } from 'react';
import { statusForMarker } from '../backends/plan';
import type { TodoStepStatus } from '../backends/types';
import { stepStatusKind, stepStatusLabel } from '../planStepIcon';
import { parseFileReference, type FileReference } from './fileReferences';
import { parseMarkdownBlocks } from './markdownBlocks';

/**
 * Minimal markdown renderer for agent output.
 *
 * This deliberately covers the subset the transcript needs - paragraphs,
 * fenced code blocks, headings, lists, tables, blockquotes and inline
 * code/emphasis/links - and returns React nodes. It never builds an HTML
 * string, so provider output cannot inject markup into the webview.
 */

const LEADING_STEP = /^\[([ xX~-])\]\s*/;

function parseLeadingStep(text: string): { status: TodoStepStatus; text: string } | undefined {
  const match = LEADING_STEP.exec(text);
  if (!match) {
    return undefined;
  }
  return { status: statusForMarker(match[1]), text: text.slice(match[0].length) };
}

const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]])/g;

interface InlineActions {
  onOpenLink?: (url: string) => void;
  onOpenFile?: (reference: FileReference) => void;
}

function isWebUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function fileButton(
  reference: FileReference,
  content: ReactNode,
  className: string,
  key: string,
  actions: InlineActions
): ReactNode {
  return (
    <button
      type="button"
      className={className}
      key={key}
      title={`Open ${reference.path}`}
      aria-label={`Open ${reference.path}`}
      onClick={() => actions.onOpenFile?.(reference)}
    >
      {content}
    </button>
  );
}

function renderInline(text: string, keyPrefix: string, actions: InlineActions): ReactNode[] {
  const lines = text.split('\n');
  const nodes: ReactNode[] = [];
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) {
      nodes.push(<br key={`${keyPrefix}-br${lineIndex}`} />);
    }
    nodes.push(...renderInlineLine(line, `${keyPrefix}-L${lineIndex}`, actions));
  });
  return nodes;
}

function renderInlineLine(text: string, keyPrefix: string, actions: InlineActions): ReactNode[] {
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
      const code = token.slice(1, -1);
      const reference = actions.onOpenFile ? parseFileReference(code) : undefined;
      nodes.push(
        reference
          ? fileButton(reference, <code className="md__code">{code}</code>, 'md__file', tokenKey, actions)
          : <code className="md__code" key={tokenKey}>{code}</code>
      );
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={tokenKey}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={tokenKey}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (!link) {
        nodes.push(token);
      } else {
        const href = link[2];
        const reference = actions.onOpenFile ? parseFileReference(href) : undefined;
        if (reference) {
          nodes.push(fileButton(reference, link[1], 'md__file-link', tokenKey, actions));
        } else if (actions.onOpenLink && isWebUrl(href)) {
          nodes.push(
            <a
              className="md__link"
              href={href}
              key={tokenKey}
              rel="noreferrer noopener"
              onClick={(event) => {
                event.preventDefault();
                actions.onOpenLink?.(href);
              }}
            >
              {link[1]}
            </a>
          );
        } else {
          nodes.push(
            <a className="md__link" href={href} key={tokenKey} rel="noreferrer noopener">
              {link[1]}
            </a>
          );
        }
      }
    } else if (isWebUrl(token)) {
      nodes.push(
        <a
          className="md__link"
          href={token}
          key={tokenKey}
          rel="noreferrer noopener"
          onClick={(event) => {
            if (!actions.onOpenLink) {
              return;
            }
            event.preventDefault();
            actions.onOpenLink(token);
          }}
        >
          {token}
        </a>
      );
    } else {
      nodes.push(token);
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
  /** Open an http(s) link in the host's internal browser. */
  onOpenLink?: (url: string) => void;
  /** Open a file reference in the editor. */
  onOpenFile?: (reference: FileReference) => void;
}

export const Markdown = memo(function Markdown({ text, renderCodeHeader, onOpenLink, onOpenFile }: MarkdownProps): JSX.Element {
  const actions: InlineActions = { onOpenLink, onOpenFile };
  const blocks = parseMarkdownBlocks(text);
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
                {renderInline(block.text, key, actions)}
              </Tag>
            );
          }
          case 'quote':
            return (
              <blockquote className="md__quote" key={key}>
                {renderInline(block.lines.join('\n'), key, actions)}
              </blockquote>
            );
          case 'table':
            return (
              <div className="md__table-wrap" key={key}>
                <table className="md__table">
                  <thead>
                    <tr>
                      {block.headers.map((header, cellIndex) => (
                        <th key={`${key}-h${cellIndex}`}>{renderInline(header, `${key}-h${cellIndex}`, actions)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={`${key}-r${rowIndex}`}>
                        {row.map((cell, cellIndex) => (
                          <td key={`${key}-r${rowIndex}-c${cellIndex}`}>
                            {renderInline(cell, `${key}-r${rowIndex}-c${cellIndex}`, actions)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'list': {
            const items = block.items.map((item, itemIndex) => {
              const step = parseLeadingStep(item);
              if (!step) {
                return <li key={`${key}-l${itemIndex}`}>{renderInline(item, `${key}-l${itemIndex}`, actions)}</li>;
              }
              return (
                <li className={`md__step md__step--${stepStatusKind(step.status)}`} key={`${key}-l${itemIndex}`}>
                  <span
                    className={`melink-step melink-step--${stepStatusKind(step.status)}`}
                    role="img"
                    aria-label={stepStatusLabel(step.status)}
                  />
                  <span className="md__step-text">{renderInline(step.text, `${key}-l${itemIndex}`, actions)}</span>
                </li>
              );
            });
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
                {renderInline(block.text, key, actions)}
              </p>
            );
        }
      })}
    </div>
  );
}, (prev, next) => prev.text === next.text);
