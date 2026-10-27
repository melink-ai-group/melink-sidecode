import { useState, type JSX } from 'react';
import { ChevronDownIcon } from '../Icons';
import { Markdown } from '../Markdown';
import { openFileReference, openWebLink } from '../navigation';
import { plainRowText } from '../plainRowText';
import { shouldToggleReasoningBody } from '../reasoningClick';
import type { TranscriptItemView } from '../state';
import { StatusMark } from './shared';

export function reasoningSnippet(text: string): string {
  return plainRowText(text);
}

/** One dot, then two, then three, then none, then it repeats. */
export function ReasoningWaitDots(): JSX.Element {
  return (
    <span className="reasoning-wait" aria-hidden="true">
      <span>.</span>
      <span>.</span>
      <span>.</span>
    </span>
  );
}

export function ReasoningCard({ item }: { item: TranscriptItemView }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const text = item.text.trim();
  const label = item.title || 'Reasoning';
  const incomplete = item.status === 'failed' || item.status === 'canceled' || item.status === 'warning';
  const snippet = reasoningSnippet(text);
  const waiting = item.status === 'streaming' && !snippet;
  const preview = waiting
    ? ''
    : snippet || (incomplete ? 'Thinking stopped early; this section may be incomplete.' : '');
  const showEllipsis = !expanded && !waiting && Boolean(preview || !text);
  const toggle = (): void => setExpanded((value) => !value);

  return (
    <article
      className={`turn turn--reasoning${expanded ? '' : ' turn--reasoning--collapsed'}`}
      aria-live="off"
    >
      <button
        type="button"
        className="reasoning-toggle"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Hide' : 'Show'} ${label}`}
        onClick={toggle}
      >
        <span className="reasoning-lead">
          <span className="meta-strong">{label}</span>
          {waiting && !expanded ? <ReasoningWaitDots /> : null}
          {showEllipsis ? (
            <span className="reasoning-snippet__sep" aria-hidden="true">
              ...
            </span>
          ) : null}
        </span>
        {!expanded && preview ? (
          <span className="reasoning-snippet__text" title={preview}>
            {preview}
          </span>
        ) : null}
        <span className="status-slot" aria-hidden="true">
          {item.status === 'streaming' ? <StatusMark tone="running" label="Thinking" /> : null}
        </span>
        <span
          className={`reasoning-toggle__chevron${expanded ? ' reasoning-toggle__chevron--open' : ''}`}
          aria-hidden="true"
        >
          <ChevronDownIcon />
        </span>
      </button>
      {expanded && (text || item.status === 'streaming' || incomplete) ? (
        <div
          className="turn-body md"
          onClick={(event) => {
            const selectionText = window.getSelection()?.toString() ?? '';
            const target = event.target instanceof Element ? event.target : null;
            if (shouldToggleReasoningBody({ selectionText, target })) toggle();
          }}
        >
          {text ? (
            <Markdown text={item.text} onOpenLink={openWebLink} onOpenFile={openFileReference} />
          ) : item.status === 'streaming' ? (
            <ReasoningWaitDots />
          ) : null}
          {item.status === 'streaming' && text ? <span className="caret" aria-hidden="true" /> : null}
          {incomplete ? (
            <p className="reasoning-incomplete">
              Thinking stopped early; this section may be incomplete.
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
