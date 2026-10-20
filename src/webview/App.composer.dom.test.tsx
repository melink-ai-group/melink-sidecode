import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { App } from './App';
import { clearHostMessages, hostMessages, sendHostMessage } from './domSetup';

interface SendTurnMessage {
  type: 'sendTurn';
  text: string;
}

function sendTurnMessages(): SendTurnMessage[] {
  return hostMessages().filter(
    (message): message is SendTurnMessage =>
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: unknown }).type === 'sendTurn'
  );
}

function renderComposer(): HTMLTextAreaElement {
  render(<App />);

  act(() => {
    sendHostMessage({
      type: 'snapshot',
      availability: [{ id: 'codex', label: 'Codex', badge: 'CLI', status: 'available' }]
    });
    sendHostMessage({ type: 'restoring', value: false });
    sendHostMessage({ type: 'conversation', backendId: 'codex', threadId: 'thread-composer', replay: [] });
  });

  const composer = screen.getByLabelText('Message the agent') as HTMLTextAreaElement;
  expect(composer.disabled).toBe(false);
  clearHostMessages();
  return composer;
}

describe('composer Enter handling', () => {
  it('does not send or prevent default on Enter while an IME is composing', () => {
    const composer = renderComposer();
    fireEvent.change(composer, { target: { value: 'こんにちは' } });

    const notPrevented = fireEvent.keyDown(composer, { key: 'Enter', isComposing: true });

    expect(notPrevented).toBe(true);
    expect(sendTurnMessages()).toHaveLength(0);
    expect(composer.value).toBe('こんにちは');
  });

  it('sends on plain Enter', () => {
    const composer = renderComposer();
    fireEvent.change(composer, { target: { value: 'plain enter' } });

    const notPrevented = fireEvent.keyDown(composer, { key: 'Enter' });

    expect(notPrevented).toBe(false);
    expect(sendTurnMessages()).toHaveLength(1);
    expect(sendTurnMessages()[0]?.text).toBe('plain enter');
  });

  it('does not send on Shift+Enter', () => {
    const composer = renderComposer();
    fireEvent.change(composer, { target: { value: 'newline' } });

    const notPrevented = fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true });

    expect(notPrevented).toBe(true);
    expect(sendTurnMessages()).toHaveLength(0);
    expect(composer.value).toBe('newline');
  });
});
