import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { App } from './App';
import { clearHostMessages, hostMessages, sendHostMessage } from './domSetup';
import type { Attachment } from '../backends/types';

const ATTACHMENT: Attachment = {
  id: 'att-1',
  name: 'guard.png',
  mimeType: 'image/png',
  size: 1024,
  kind: 'image',
  dataUrl: 'data:image/png;base64,AAAA'
};

interface SendTurnMessage {
  type: 'sendTurn';
  text: string;
  queue?: boolean;
  attachments?: Attachment[];
}

function messagesOf(type: string): Array<Record<string, unknown>> {
  return hostMessages().filter(
    (message): message is Record<string, unknown> =>
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: unknown }).type === type
  );
}

function sendTurns(): SendTurnMessage[] {
  return messagesOf('sendTurn') as unknown as SendTurnMessage[];
}

const AVAILABILITY = [
  { id: 'ollama', label: 'Ollama Cloud', badge: 'Ollama', status: 'available' },
  { id: 'ollama-local', label: 'Ollama Local', badge: 'Ollama', status: 'available' },
  { id: 'codex', label: 'OpenAI Codex CLI', badge: 'Codex', status: 'available' },
  { id: 'opencode', label: 'OpenCode Zen', badge: 'Zen', status: 'available' }
];

function renderComposer(backendId = 'codex'): HTMLTextAreaElement {
  render(<App />);
  act(() => {
    sendHostMessage({ type: 'snapshot', availability: AVAILABILITY });
    sendHostMessage({ type: 'restoring', value: false });
    sendHostMessage({ type: 'conversation', backendId, threadId: 'thread-queue', replay: [] });
  });
  const composer = screen.getByLabelText('Message the agent') as HTMLTextAreaElement;
  expect(composer.disabled).toBe(false);
  clearHostMessages();
  return composer;
}

function attachFile(): void {
  fireEvent.click(screen.getByLabelText('Attach files'));
  const request = messagesOf('attachFiles')[0] as { requestId?: string } | undefined;
  expect(request?.requestId).toBeTruthy();
  act(() => {
    sendHostMessage({
      type: 'attachmentsPicked',
      requestId: request?.requestId,
      attachments: [ATTACHMENT]
    });
  });
  expect(screen.getByLabelText('Attachments')).toBeTruthy();
}

function setBusy(backendId = 'codex'): void {
  act(() => {
    sendHostMessage({ type: 'busy', value: true, backendId, threadId: 'thread-queue' });
  });
}

describe('busy composer queueing', () => {
  it('queues a busy send with an attachment and keeps the draft until the echo', () => {
    const composer = renderComposer('codex');
    attachFile();
    fireEvent.change(composer, { target: { value: 'send this after the turn' } });
    setBusy();

    fireEvent.keyDown(composer, { key: 'Enter' });

    const sent = sendTurns();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.queue).toBe(true);
    expect(sent[0]?.text).toBe('send this after the turn');
    expect(sent[0]?.attachments).toHaveLength(1);
    // No optimistic loss: the text and chip stay until the host confirms.
    expect(composer.value).toBe('send this after the turn');
    expect(screen.getByLabelText('Attachments')).toBeTruthy();

    act(() => {
      sendHostMessage({
        type: 'queuedTurns',
        entries: [
          {
            id: 'q1',
            textPreview: 'send this after the turn',
            attachmentCount: 1,
            attachmentNames: ['guard.png']
          }
        ]
      });
    });

    expect(composer.value).toBe('');
    expect(screen.queryByLabelText('Attachments')).toBeNull();
    expect(within(screen.getByLabelText('Queued messages')).getByText('Queued')).toBeTruthy();
  });

  it('renders multiple queued turns in host order with a count', () => {
    renderComposer('codex');
    setBusy();
    act(() => {
      sendHostMessage({
        type: 'queuedTurns',
        entries: [
          { id: 'q1', textPreview: 'first message', attachmentCount: 0 },
          { id: 'q2', textPreview: 'second message', attachmentCount: 2, attachmentNames: ['a.png', 'b.pdf'] }
        ]
      });
    });

    const queue = screen.getByLabelText('Queued messages');
    expect(within(queue).getByText('2 queued')).toBeTruthy();
    const items = within(queue).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('first message');
    expect(items[1]?.textContent).toContain('second message');
    expect(items[1]?.textContent).toContain('2 files');
  });

  it('keeps text and attachments when the host rejects the queue', () => {
    const composer = renderComposer('codex');
    attachFile();
    fireEvent.change(composer, { target: { value: 'retry me' } });
    setBusy();
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(sendTurns()).toHaveLength(1);

    act(() => {
      sendHostMessage({
        type: 'attachmentError',
        message: 'One file could not be queued because it was unreadable, unsupported, or too large.'
      });
    });

    expect(composer.value).toBe('retry me');
    expect(screen.getByLabelText('Attachments')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('could not be queued');
  });

  it('removes a queued turn and tells the host', () => {
    renderComposer('codex');
    setBusy();
    act(() => {
      sendHostMessage({
        type: 'queuedTurns',
        entries: [
          { id: 'q1', textPreview: 'first message', attachmentCount: 0 },
          { id: 'q2', textPreview: 'second message', attachmentCount: 0 }
        ]
      });
    });

    fireEvent.click(screen.getByRole('button', { name: /Remove queued message: first message/ }));

    expect(messagesOf('cancelQueuedTurn')).toEqual([{ type: 'cancelQueuedTurn', id: 'q1' }]);
    expect(screen.queryByText('first message')).toBeNull();
    expect(screen.getByText('second message')).toBeTruthy();
  });

  it('shows a dispatched queued turn at once and does not duplicate it on replay', () => {
    renderComposer('codex');
    const text = 'send this after the turn';

    act(() => {
      sendHostMessage({
        type: 'queuedTurns',
        entries: [{ id: 'q1', textPreview: text, attachmentCount: 1, attachmentNames: ['guard.png'] }]
      });
    });
    expect(within(screen.getByLabelText('Queued messages')).getByText(text)).toBeTruthy();

    act(() => {
      // The host starts the queued turn: the chip goes away and the stored user
      // message is posted for the open chat before any reply streams.
      sendHostMessage({ type: 'queuedTurns', entries: [] });
      sendHostMessage({
        type: 'userMessageSent',
        backendId: 'codex',
        threadId: 'thread-queue',
        messageId: 'user_1_0',
        text,
        attachments: [ATTACHMENT],
        sentAt: 1_700_000_000_000
      });
    });

    expect(screen.queryByLabelText('Queued messages')).toBeNull();
    expect(document.querySelectorAll('.turn--user')).toHaveLength(1);
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByLabelText('View guard.png')).toBeTruthy();

    act(() => {
      // The later snapshot replay carries the same stored row, so it replaces
      // the posted bubble instead of adding a second one.
      sendHostMessage({
        type: 'conversation',
        backendId: 'codex',
        threadId: 'thread-queue',
        replay: [
          {
            id: 'user_1_0',
            kind: 'message',
            role: 'user',
            text,
            attachments: [ATTACHMENT],
            status: 'completed',
            sentAt: 1_700_000_000_000
          }
        ]
      });
    });

    expect(document.querySelectorAll('.turn--user')).toHaveLength(1);
  });

  it('sends normally with an attachment when the composer is idle', () => {
    const composer = renderComposer('codex');
    attachFile();
    fireEvent.change(composer, { target: { value: 'idle attachment send' } });

    fireEvent.keyDown(composer, { key: 'Enter' });

    const sent = sendTurns();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.queue).toBeUndefined();
    expect(sent[0]?.attachments).toHaveLength(1);
    expect(composer.value).toBe('');
  });

  it('keeps the text-only steer path unchanged', () => {
    const composer = renderComposer('codex');
    fireEvent.change(composer, { target: { value: 'steer this turn' } });
    setBusy();

    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(sendTurns()).toHaveLength(0);
    expect(messagesOf('steerTurn')).toEqual([{ type: 'steerTurn', text: 'steer this turn' }]);
    expect(composer.value).toBe('');
  });

  it('locks provider, model and permission controls while busy or queued', () => {
    renderComposer('codex');
    act(() => {
      sendHostMessage({
        type: 'permissions',
        permissions: {
          backendId: 'codex',
          hasApprovalChannel: true,
          options: [
            { level: 'read-only', label: 'Read only', description: 'Read files only.', requiresConfirmation: false },
            { level: 'default', label: 'Ask first', description: 'Ask before writes.', requiresConfirmation: false }
          ],
          selected: 'default',
          epoch: 0,
          rules: []
        }
      });
      sendHostMessage({
        type: 'modes',
        modes: {
          backendId: 'codex',
          options: [
            { mode: 'agent', label: 'Agent', description: 'Do the work.' },
            { mode: 'plan', label: 'Plan', description: 'Plan first.' }
          ],
          selected: 'agent'
        }
      });
    });
    const model = screen.getByLabelText(/^Model:/) as HTMLButtonElement;
    const permission = screen.getByLabelText(/^Permission level:/) as HTMLButtonElement;
    const mode = screen.getByLabelText(/^Mode:/) as HTMLButtonElement;
    for (const control of [model, permission, mode]) {
      expect(control.disabled).toBe(false);
    }

    setBusy();
    for (const control of [model, permission, mode]) {
      expect(control.disabled).toBe(true);
    }
    expect(model.title).toContain('queued messages finish');

    act(() => {
      sendHostMessage({ type: 'busy', value: false, backendId: 'codex', threadId: 'thread-queue' });
    });
    expect(model.disabled).toBe(false);

    act(() => {
      sendHostMessage({
        type: 'queuedTurns',
        entries: [{ id: 'q1', textPreview: 'later', attachmentCount: 0 }]
      });
    });
    expect(model.disabled).toBe(true);

    act(() => {
      sendHostMessage({ type: 'queuedTurns', entries: [] });
    });
    expect(model.disabled).toBe(false);
  });

  it('keeps queued chips through a repaint of the same chat and clears them on a switch', () => {
    renderComposer('codex');
    setBusy();
    act(() => {
      sendHostMessage({
        type: 'queuedTurns',
        entries: [{ id: 'q1', textPreview: 'repaint survivor', attachmentCount: 0 }]
      });
    });
    expect(within(screen.getByLabelText('Queued messages')).getByText('repaint survivor')).toBeTruthy();

    act(() => {
      sendHostMessage({ type: 'conversation', backendId: 'codex', threadId: 'thread-queue', replay: [] });
    });
    expect(within(screen.getByLabelText('Queued messages')).getByText('repaint survivor')).toBeTruthy();

    act(() => {
      sendHostMessage({ type: 'conversation', backendId: 'codex', threadId: 'other-thread', replay: [] });
    });
    expect(screen.queryByLabelText('Queued messages')).toBeNull();
  });

  it('clears a stale-busy queue draft when the host dispatches it immediately', () => {
    vi.useFakeTimers();
    try {
      const composer = renderComposer('codex');
      attachFile();
      fireEvent.change(composer, { target: { value: 'race the finished turn' } });
      setBusy();
      fireEvent.keyDown(composer, { key: 'Enter' });
      expect(sendTurns()).toHaveLength(1);
      expect(sendTurns()[0]?.queue).toBe(true);

      act(() => {
        // No `queuedTurns` echo: the turn had already finished, so the host
        // dispatched the message normally and posted the stored row.
        sendHostMessage({
          type: 'userMessageSent',
          backendId: 'codex',
          threadId: 'thread-queue',
          messageId: 'user_stale_1',
          text: 'race the finished turn',
          attachments: [ATTACHMENT],
          sentAt: 1_700_000_000_000
        });
      });

      expect(composer.value).toBe('');
      expect(screen.queryByLabelText('Remove guard.png')).toBeNull();
      expect(document.querySelectorAll('.turn--user')).toHaveLength(1);
      expect(document.querySelector('.attachments--sent')).toBeTruthy();
      expect(screen.queryByLabelText('Queued messages')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(screen.queryByText(/Queue confirmation timed out/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the queueing guard and keeps the draft when the echo times out', () => {
    vi.useFakeTimers();
    try {
      const composer = renderComposer('codex');
      attachFile();
      fireEvent.change(composer, { target: { value: 'lost echo' } });
      setBusy();
      fireEvent.keyDown(composer, { key: 'Enter' });
      expect(sendTurns()).toHaveLength(1);

      const queueButton = screen.getByLabelText('Queue message') as HTMLButtonElement;
      expect(queueButton.disabled).toBe(true);

      act(() => {
        vi.advanceTimersByTime(4000);
      });

      expect(queueButton.disabled).toBe(false);
      expect(composer.value).toBe('lost echo');
      expect(screen.getByText(/Queue confirmation timed out/)).toBeTruthy();

      fireEvent.keyDown(composer, { key: 'Enter' });
      expect(sendTurns()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
