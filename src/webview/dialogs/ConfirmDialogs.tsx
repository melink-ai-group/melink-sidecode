import { useEffect, useRef, type JSX } from 'react';
import type { DefaultMode } from '../../backends/types';
import { modeDescriptor } from '../../backends/modes.ts';
import type { RestorePreview } from '../../protocol';
import { AlertIcon } from '../Icons';
import { isSubmitEnter } from '../keys';

/** The labelled confirmation before the unrestricted level can be applied. */
export function UnrestrictedConfirmation({
  onConfirm,
  onCancel
}: {
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div className="confirm-gate" role="alertdialog" aria-label="Confirm unrestricted permission">
      <div className="confirm-gate__head">
        <span className="confirm-gate__icon" aria-hidden="true">
          <AlertIcon />
        </span>
        <div>
          <p className="confirm-gate__title">Turn off the safety net?</p>
          <p className="confirm-gate__text">
            Unrestricted removes the sandbox and stops asking before commands and edits. The agent acts
            without approval. Choose this only for a task you trust.
          </p>
        </div>
      </div>
      <div className="confirm-gate__actions">
        <button className="btn" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn--danger" type="button" onClick={onConfirm}>
          Enable unrestricted
        </button>
      </div>
    </div>
  );
}

/**
 * Confirmation before a turn moves into a mode that can do more than the one
 * already selected. Dismissing it keeps the current mode and still sends.
 */
export function ModeSwitchModal({
  from,
  to,
  onAccept,
  onDecline
}: {
  from: DefaultMode;
  to: DefaultMode;
  onAccept: () => void;
  onDecline: () => void;
}): JSX.Element {
  const fromLabel = modeDescriptor(from).label;
  const toLabel = modeDescriptor(to).label;
  const declineRef = useRef(onDecline);
  const acceptRef = useRef(onAccept);
  declineRef.current = onDecline;
  acceptRef.current = onAccept;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        declineRef.current();
        return;
      }
      // Enter on a dialog button activates that button. Enter from the composer
      // would otherwise insert a newline under the dialog, so it confirms instead.
      if (isSubmitEnter(event) && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        event.stopPropagation();
        acceptRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      // The chat surface can be replaced (settings, for example) while the
      // host is still waiting. Treat that as a dismiss so the turn continues.
      declineRef.current();
    };
  }, []);

  return (
    <div className="mode-modal" role="presentation" onClick={() => declineRef.current()}>
      <div
        className="mode-modal__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mode-switch-title"
        aria-describedby="mode-switch-text"
        onClick={(event) => event.stopPropagation()}
      >
        <p id="mode-switch-title" className="mode-modal__title">
          Switch to {toLabel} mode?
        </p>
        <p id="mode-switch-text" className="mode-modal__text">
          This request sounds like it needs {toLabel} mode. Switch from {fromLabel} and continue?
        </p>
        <div className="mode-modal__actions">
          <button className="btn btn--secondary" type="button" onClick={() => declineRef.current()}>
            Stay in {fromLabel}
          </button>
          <button className="btn btn--primary" type="button" autoFocus onClick={() => acceptRef.current()}>
            Switch and continue
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The confirmation before a checkpoint restore. This chat's later messages are
 * removed. When other chats would lose file, todo, or plan work, they are
 * listed before anything is written. Their messages stay.
 */
export function RestoreConfirmation({
  preview,
  onConfirm,
  onCancel
}: {
  preview: RestorePreview;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const messageCount = preview.thisChat.messages.length;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="restore-modal" role="presentation" onClick={onCancel}>
      <div
        className="restore-modal__dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm checkpoint restore"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="restore-modal__title">Restore to before this message?</p>
        <p className="restore-modal__text">
          This chat goes back to the moment before the message was sent.
          {messageCount > 0
            ? ` ${messageCount} message${messageCount === 1 ? '' : 's'} in this chat will be removed.`
            : ''}{' '}
          Files, todos, and plans return to that point. You can undo the restore afterwards.
        </p>
        <PreviewList messages={preview.thisChat.messages} paths={preview.thisChat.paths} planChanges={preview.thisChat.planChanges} />
        {preview.otherChats.length > 0 ? (
          <div className="restore-modal__warn">
            <p className="restore-modal__warn-title">Other chats will also lose work</p>
            <p className="restore-modal__text">
              These chats keep their messages, but the file, todo, and plan changes below will be undone.
            </p>
            <ul className="restore-modal__chats">
              {preview.otherChats.map((chat) => (
                <li key={`${chat.backendId}:${chat.threadId}`}>
                  <p className="restore-modal__chat-title">{chat.title}</p>
                  <PreviewList messages={chat.messages} paths={chat.paths} planChanges={chat.planChanges} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="restore-modal__actions">
          <button className="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn--danger" type="button" onClick={onConfirm}>
            Restore
          </button>
        </div>
      </div>
    </div>
  );
}

export function PreviewList({
  messages,
  paths,
  planChanges
}: {
  messages: RestorePreview['thisChat']['messages'];
  paths: string[];
  planChanges: boolean;
}): JSX.Element | null {
  const shownMessages = messages.slice(0, 6);
  const shownPaths = paths.slice(0, 8);
  if (shownMessages.length === 0 && shownPaths.length === 0 && !planChanges) {
    return null;
  }
  return (
    <div className="restore-modal__detail">
      {shownMessages.length > 0 ? (
        <ul className="restore-modal__messages">
          {shownMessages.map((message) => (
            <li key={message.id}>{message.preview}</li>
          ))}
          {messages.length > shownMessages.length ? <li>and {messages.length - shownMessages.length} more</li> : null}
        </ul>
      ) : null}
      {shownPaths.length > 0 ? (
        <ul className="restore-modal__paths">
          {shownPaths.map((path) => (
            <li key={path}>{path}</li>
          ))}
          {paths.length > shownPaths.length ? <li>and {paths.length - shownPaths.length} more</li> : null}
        </ul>
      ) : null}
      {planChanges ? <p className="restore-modal__text">The plan and todos will change.</p> : null}
    </div>
  );
}
