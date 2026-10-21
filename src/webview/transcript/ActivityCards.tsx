import { memo, useState, type JSX } from 'react';
import { isStatusText, toolCardPresentation } from '../../backends/toolLabel.ts';
import { activitySections, activitySummary, groupTranscript, toolBursts, type ActivityFamily } from '../activityGroups';
import { ChevronDownIcon, FileIcon, SearchIcon, SparkIcon, TerminalIcon } from '../Icons';
import { plainRowText } from '../plainRowText';
import type { TranscriptItemView } from '../state';
import { visibleTranscriptText } from '../visibleTranscript';
import { FileChangeCard } from './FileChangeCard';
import { ReasoningCard } from './Reasoning';
import { CardLines, StatusChip, StatusMark, sameItems } from './shared';

export const NarrationRow = memo(function NarrationRow({
  message,
  items,
  showSpeaker,
  providerId,
  hideQuestions
}: {
  message: TranscriptItemView;
  items: TranscriptItemView[];
  showSpeaker: boolean;
  providerId: string;
  hideQuestions?: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const text = plainRowText(visibleTranscriptText(message.text, { hideQuestions }));
  const running = items.some((item) => item.status === 'streaming' || item.status === 'pending') || message.status === 'streaming';
  return (
    <article className={`narration${expanded ? ' narration--open' : ''}`}>
      {showSpeaker ? (
        <div className="turn-meta">
          <span className={`provider-dot provider-dot--${providerId}`} aria-hidden="true" />
          <span className="meta-strong">melink</span>
        </div>
      ) : null}
      <button
        type="button"
        className="narration__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={`activity-group__chevron${expanded ? ' activity-group__chevron--open' : ''}`} aria-hidden="true">
          <ChevronDownIcon />
        </span>
        <span className="narration__text">
          {text}
          {message.status === 'streaming' ? <span className="caret" aria-hidden="true" /> : null}
        </span>
        <span className="status-slot">
          {running ? <StatusMark tone="running" label="Working" /> : null}
        </span>
      </button>
      {expanded ? (
        <div className="narration__details">
          {groupTranscript(items).map((entry) =>
            entry.kind === 'group' ? (
              <ActivityGroup key={entry.id} family={entry.family} items={entry.items} />
            ) : entry.kind === 'item' ? (
              entry.item.kind === 'reasoning' ? (
                <ReasoningCard key={entry.item.id} item={entry.item} />
              ) : (
                <GroupChild key={entry.item.id} item={entry.item} />
              )
            ) : null
          )}
        </div>
      ) : null}
    </article>
  );
}, (prev, next) =>
  prev.message === next.message &&
  prev.showSpeaker === next.showSpeaker &&
  prev.providerId === next.providerId &&
  prev.hideQuestions === next.hideQuestions &&
  sameItems(prev.items, next.items)
);

export const ActivityGroup = memo(function ActivityGroup({ family, items }: { family: ActivityFamily; items: TranscriptItemView[] }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const summary = activitySummary(items);
  const Icon = family === 'command' ? TerminalIcon : family === 'change' ? FileIcon : family === 'work' ? SparkIcon : SearchIcon;
  const nested = family === 'work' || items.some((item) => item.kind === 'reasoning');
  const label = summary.detail ? `${summary.label} ${summary.detail}` : summary.label;
  return (
    <div className={`item-card activity-group${expanded ? ' activity-group--open' : ''}`}>
      <button
        type="button"
        className="activity-group__toggle item-head"
        aria-expanded={expanded}
        aria-label={label}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={`activity-group__chevron${expanded ? ' activity-group__chevron--open' : ''}`} aria-hidden="true">
          <ChevronDownIcon />
        </span>
        <span className="item-icon" aria-hidden="true">
          <Icon />
        </span>
        <CardLines title={summary.label} detail={summary.detail} />
        <StatusChip status={summary.status} doneLabel={family === 'change' ? 'Applied' : 'Passed'} />
      </button>
      {expanded ? (
        <div className="activity-group__items">
          {nested ? (
            activitySections(items).map((section) => (
              <div className="activity-section" key={section.id}>
                {section.reasoning ? <ReasoningCard item={section.reasoning} /> : null}
                {toolBursts(section.tools).map((burst) =>
                  burst.items.length === 1 ? (
                    <GroupChild key={burst.id} item={burst.items[0]} />
                  ) : (
                    <NestedBurst key={burst.id} family={burst.family} items={burst.items} />
                  )
                )}
              </div>
            ))
          ) : (
            items.map((item) => <GroupChild key={item.id} item={item} />)
          )}
        </div>
      ) : null}
    </div>
  );
}, (prev, next) => prev.family === next.family && sameItems(prev.items, next.items));

export function NestedBurst({ family, items }: { family: ActivityFamily; items: TranscriptItemView[] }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const summary = activitySummary(items);
  const Icon = family === 'command' ? TerminalIcon : family === 'change' ? FileIcon : SearchIcon;
  return (
    <div className={`item-card activity-group activity-group--nested${expanded ? ' activity-group--open' : ''}`}>
      <button
        type="button"
        className="activity-group__toggle item-head"
        aria-expanded={expanded}
        aria-label={summary.label}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={`activity-group__chevron${expanded ? ' activity-group__chevron--open' : ''}`} aria-hidden="true">
          <ChevronDownIcon />
        </span>
        <span className="item-icon" aria-hidden="true">
          <Icon />
        </span>
        <CardLines title={summary.label} detail={summary.detail} />
        <StatusChip status={summary.status} doneLabel="Passed" />
      </button>
      {expanded ? (
        <div className="activity-group__items">
          {items.map((item) => (
            <GroupChild key={item.id} item={item} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function GroupChild({ item }: { item: TranscriptItemView }): JSX.Element {
  if (item.kind === 'file-change') {
    return <FileChangeCard item={item} />;
  }
  if (item.kind === 'tool') {
    return <ToolCard item={item} />;
  }
  return (
    <div className="item-card" aria-label="Web search item">
      <div className="item-head">
        <span className="item-icon" aria-hidden="true">
          <SearchIcon />
        </span>
        <CardLines title={item.title || 'Web search'} detail={item.text || undefined} />
        <StatusChip status={item.status} doneLabel="Passed" />
      </div>
    </div>
  );
}

export function ToolCard({ item }: { item: TranscriptItemView }): JSX.Element {
  const presentation = toolCardPresentation(item);
  const output = toolOutput(item, presentation.detail);
  return (
    <details className="item-card item-card--command">
      <summary className="item-head" aria-label="Command item">
        <span className="item-icon" aria-hidden="true">
          <TerminalIcon />
        </span>
        <CardLines title={presentation.title} detail={presentation.detail} />
        <StatusChip status={item.status} doneLabel="Passed" />
      </summary>
      {output ? (
        <div className="item-body">
          <code>{output}</code>
        </div>
      ) : null}
    </details>
  );
}

/** Expanded tool output. Status words and the summary target are not output. */
export function toolOutput(item: TranscriptItemView, summary?: string): string | undefined {
  const text = item.text.trim();
  if (text && !isStatusText(text) && text !== summary) {
    return text;
  }
  const detail = item.detail?.trim();
  if (detail && !isStatusText(detail) && detail !== summary) {
    return detail;
  }
  return undefined;
}
