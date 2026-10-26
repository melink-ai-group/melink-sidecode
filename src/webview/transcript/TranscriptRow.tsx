import { memo, type JSX } from 'react';
import type { ApprovalDecision } from '../../backends/types';
import { Markdown } from '../Markdown';
import { splitReplyClose } from '../replyClose';
import { visibleTranscriptText } from '../visibleTranscript';
import { AlertIcon, CheckIcon, CopyIcon, PersonIcon, RestoreIcon, StopIcon } from '../Icons';
import { AttachmentList, type ViewableImage } from '../composer/attachments';
import { bridge } from '../hostBridge';
import { noticeActionLabel } from '../notices';
import type { CheckpointView } from '../../protocol';
import type { NoticeAction, TranscriptItemView } from '../state';
import { ApprovalPrompt, ApprovalResolvedCard } from './ApprovalCards';
import { ToolCard } from './ActivityCards';
import { FileChangeCard } from './FileChangeCard';
import { ReasoningCard } from './Reasoning';
import { AgentActivityCard } from './AgentActivityCard';
import { StatusMark, copyText } from './shared';

export const TranscriptRow = memo(function TranscriptRow({
  item,
  providerId,
  showSpeaker,
  pendingId,
  checkpoint,
  onDecide,
  onOpenRules,
  onRestore,
  onViewImage,
  onNoticeAction
}: {
  item: TranscriptItemView;
  providerId: string;
  /** The opening reply of a turn, and the closing one once that turn has settled. */
  showSpeaker?: boolean;
  pendingId?: string;
  /** The send-time snapshot for this message, when one was stored. */
  checkpoint?: CheckpointView;
  onDecide: (decision: ApprovalDecision) => void;
  onOpenRules: () => void;
  onRestore: (messageId: string) => void;
  onViewImage: (images: ViewableImage[], index: number) => void;
  onNoticeAction: (action: NoticeAction, noticeText?: string) => void;
}): JSX.Element | null {
  if (item.kind === 'message' && item.role === 'user') {
    // An injected instruction is provider input, not a message the user wrote.
    // It stays in state so a turn's change card keeps its anchor, but the chat
    // never shows the prompt itself.
    if (item.orchestration) {
      return null;
    }
    const text = visibleTranscriptText(item.text);
    if (!text && !(item.attachments && item.attachments.length > 0)) {
      return null;
    }
    return (
      <article className="turn turn--user" data-user-message={item.id}>
        <div className="turn-meta">
          <PersonIcon />
          <span className="meta-strong">You</span>
        </div>
        <div className="turn-user-box">
          <div className="turn-body">
            {item.attachments && item.attachments.length > 0 ? (
              <AttachmentList attachments={item.attachments} sent onView={onViewImage} />
            ) : null}
            {text ? <Markdown text={text} /> : null}
          </div>
          {checkpoint ? (
            <div className="turn-actions">
              <button
                type="button"
                className="checkpoint-restore"
                aria-label="Restore to before this message"
                title="Restore this chat to before this message. This stays available after you keep a turn's files."
                onClick={() => onRestore(checkpoint.messageId)}
              >
                <RestoreIcon />
              </button>
            </div>
          ) : null}
        </div>
      </article>
    );
  }

  if (item.kind === 'tool') {
    return <ToolCard item={item} />;
  }

  if (item.kind === 'file-change') {
    return <FileChangeCard item={item} />;
  }

  if (item.kind === 'approval-requested') {
    // The live request renders the decision card; a settled one renders the
    // compact resolved marker. This is what keeps exactly one prompt visible.
    return item.id === pendingId ? (
      <ApprovalPrompt item={item} onDecide={onDecide} />
    ) : (
      <ApprovalResolvedCard item={item} onOpenRules={onOpenRules} />
    );
  }

  if (item.kind === 'approval-decided') {
    return <ApprovalResolvedCard item={item} approved onOpenRules={onOpenRules} />;
  }

  if (item.kind === 'approval-denied') {
    return <ApprovalResolvedCard item={item} approved={false} onOpenRules={onOpenRules} />;
  }

  if (item.kind === 'notice' && item.agentActivity) {
    return <AgentActivityCard activity={item.agentActivity} />;
  }

  if (item.kind === 'notice' && item.detail === 'status') {
    const level = item.noticeLevel ?? 'info';
    const tone = level === 'error' ? 'error' : level === 'warning' ? 'interrupted' : 'ok';
    const Icon = tone === 'ok' ? CheckIcon : AlertIcon;
    return (
      <div className={`banner banner--${tone} banner--status`} role={level === 'error' ? 'alert' : 'status'}>
        <span className="banner-icon" aria-hidden="true">
          <Icon />
        </span>
        <p className="banner-text">{item.text}</p>
        {item.noticeAction ? (
          <div className="banner-actions">
            <button
              className="btn btn--primary"
              type="button"
              onClick={() => onNoticeAction(item.noticeAction ?? 'refresh', item.text)}
            >
              {noticeActionLabel(item.noticeAction)}
            </button>
            {item.noticeAction === 'refresh' ? null : (
              <button className="btn btn--quiet" type="button" onClick={() => onNoticeAction('refresh')}>
                Refresh backends
              </button>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  if (item.kind === 'notice') {
    return (
      <article className="turn turn--agent">
        {item.title ? <div className="turn-meta">{item.title}</div> : null}
        <div className="turn-body">
          <p>{item.text}</p>
        </div>
      </article>
    );
  }

  if (item.kind === 'reasoning') {
    return <ReasoningCard item={item} />;
  }

  // Assistant message: markdown output with a streaming caret.
  const assistantText = visibleTranscriptText(item.text);
  if (!assistantText && item.status !== 'failed') {
    return null;
  }
  const statusChip =
    item.status === 'streaming' ? (
      <StatusMark tone="running" label="Generating" />
    ) : item.status === 'canceled' ? (
      <StatusMark label="Stopped" icon={<StopIcon />} />
    ) : null;
  return (
    <article className="turn turn--agent" aria-live="polite">
      {showSpeaker || statusChip ? (
        <div className="turn-meta">
          {showSpeaker ? (
            <>
              <span className={`provider-dot provider-dot--${providerId}`} aria-hidden="true" />
              <span className="meta-strong">meLink</span>
              {item.title ? (
                <>
                  <span className="meta-sep" aria-hidden="true">
                    -
                  </span>
                  <span>{item.title}</span>
                </>
              ) : null}
            </>
          ) : null}
          {statusChip}
        </div>
      ) : null}
      <div className="turn-body">
        {assistantText ? (
          <AssistantReply
            text={assistantText}
            settled={item.status !== 'streaming' && item.status !== 'pending'}
          />
        ) : null}
        {item.status === 'streaming' ? <span className="caret" aria-hidden="true" /> : null}
        {item.status === 'failed' ? (
          <div className="banner banner--error" role="alert">
            <span className="banner-icon" aria-hidden="true">
              <AlertIcon />
            </span>
            <div>
              <p className="banner-title">Response incomplete</p>
              <p className="banner-text">The agent stopped before finishing this reply.</p>
              <div className="banner-actions">
                <button className="btn btn--primary" type="button" onClick={() => bridge.post({ type: 'refresh' })}>
                  Retry
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}, (prev, next) =>
  prev.item === next.item &&
  prev.providerId === next.providerId &&
  prev.showSpeaker === next.showSpeaker &&
  prev.pendingId === next.pendingId &&
  prev.checkpoint === next.checkpoint
);

export function AssistantReply({ text, settled }: { text: string; settled: boolean }): JSX.Element {
  const parts = settled ? splitReplyClose(text) : { body: text };
  const copyHeader = (_language: string, code: string): JSX.Element => (
    <button className="icon-btn" type="button" aria-label="Copy code" onClick={() => copyText(code)}>
      <CopyIcon />
    </button>
  );
  return (
    <>
      {parts.body ? <Markdown text={parts.body} renderCodeHeader={copyHeader} /> : null}
      {parts.close ? (
        <div className="reply-close">
          <Markdown text={parts.close} />
        </div>
      ) : null}
    </>
  );
}

