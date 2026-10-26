import type { JSX } from 'react';
import type { QueuedTurnEntryView } from '../../protocol';
import { ArrowIcon, CrossIcon, PaperclipIcon } from '../Icons';

/**
 * Queued user turns for the visible chat, above the composer. A queued turn is
 * not a transcript message yet: it has no bubble until the host starts it.
 */
export function QueuedTurns({
  entries,
  onCancel,
  onEscalate,
  canEscalate = false
}: {
  entries: QueuedTurnEntryView[];
  onCancel: (id: string) => void;
  onEscalate?: (id: string) => void;
  canEscalate?: boolean;
}): JSX.Element {
  const several = entries.length !== 1;
  return (
    <div className="composer-queue" role="region" aria-label="Queued messages">
      <p className="composer-queue__count" role="status" aria-live="polite">
        {entries.length} queued
      </p>
      <ul className="composer-queue__list">
        {entries.map((entry) => (
          <li className="composer-queue__item" key={entry.id}>
            <span className="composer-queue__badge">Queued</span>
            <span className="composer-queue__text" title={entry.textPreview}>
              {entry.textPreview || 'Attachment only'}
            </span>
            {entry.attachmentCount > 0 ? (
              <span
                className="composer-queue__files"
                title={entry.attachmentNames?.join(', ') ?? `${entry.attachmentCount} files`}
              >
                <PaperclipIcon className="ico ico--xs" />
                {attachmentLabel(entry)}
              </span>
            ) : null}
            {onEscalate ? (
              <button
                className="composer-queue__remove composer-queue__escalate"
                type="button"
                aria-label={`Send queued message now: ${entry.textPreview || 'attachment only'}`}
                title={entry.attachmentCount > 0 ? 'Messages with attachments send when the turn ends' : 'Send now to the active turn'}
                disabled={!canEscalate || entry.attachmentCount > 0}
                onClick={() => onEscalate(entry.id)}
              >
                <ArrowIcon className="ico ico--xs" />
              </button>
            ) : null}
            <button
              className="composer-queue__remove"
              type="button"
              aria-label={`Remove queued message: ${entry.textPreview || 'attachment only'}`}
              title="Remove from queue"
              onClick={() => onCancel(entry.id)}
            >
              <CrossIcon className="ico ico--xs" />
            </button>
          </li>
        ))}
      </ul>
      <span className="sr-only">
        {several ? 'These messages send in the order shown.' : 'This message sends when the turn ends.'}
        {onEscalate ? ' Use Send queued message now to add a text message to the active turn.' : ''}
      </span>
    </div>
  );
}

function attachmentLabel(entry: QueuedTurnEntryView): string {
  const names = entry.attachmentNames ?? [];
  if (names.length === 1) {
    return names[0] ?? '1 file';
  }
  return `${entry.attachmentCount} files`;
}
