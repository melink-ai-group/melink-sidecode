import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { App } from './App';
import { sendHostMessage, setSelectionText } from './domSetup';

const REASONING_BODY =
  'Checking the request with a [link](#reasoning) and `inline code` before acting.';

function openReasoning(): HTMLElement {
  render(<App />);

  act(() => {
    sendHostMessage({
      type: 'snapshot',
      availability: [{ id: 'codex', label: 'Codex', badge: 'CLI', status: 'available' }]
    });
    sendHostMessage({ type: 'restoring', value: false });
    sendHostMessage({
      type: 'conversation',
      backendId: 'codex',
      threadId: 'thread-reasoning',
      replay: [
        {
          id: 'reason-1',
          kind: 'reasoning',
          title: 'Reasoning',
          text: REASONING_BODY
        }
      ]
    });
  });

  fireEvent.click(screen.getByRole('button', { name: 'Show Reasoning' }));
  const body = document.querySelector<HTMLElement>('.turn-body');
  expect(body).not.toBeNull();
  return body as HTMLElement;
}

function isExpanded(): boolean {
  return (
    screen.queryByRole('button', { name: 'Hide Reasoning' })?.getAttribute('aria-expanded') === 'true'
  );
}

describe('reasoning select-to-collapse guard', () => {
  it('keeps the panel open while text is selected and collapses on a plain body click', () => {
    const body = openReasoning();
    expect(isExpanded()).toBe(true);

    setSelectionText('selected reasoning text');
    fireEvent.click(body);
    expect(isExpanded()).toBe(true);
    expect(document.querySelector('.turn-body')).not.toBeNull();

    setSelectionText('');
    fireEvent.click(body);
    expect(isExpanded()).toBe(false);
    expect(document.querySelector('.turn-body')).toBeNull();
  });

  it('does not toggle from clicks on links, buttons, or inline code in the body', () => {
    const body = openReasoning();
    const link = body.querySelector('a');
    const code = body.querySelector('code');
    expect(link).not.toBeNull();
    expect(code).not.toBeNull();

    link?.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link as HTMLAnchorElement);
    expect(isExpanded()).toBe(true);

    fireEvent.click(code as HTMLElement);
    expect(isExpanded()).toBe(true);

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'inner action';
    body.appendChild(button);
    fireEvent.click(button);
    expect(isExpanded()).toBe(true);
  });
});

describe.each(['opencode', 'ollama', 'ollama-local'])('%s live activity', (backendId) => {
  it('shows waiting thoughts, live exploration and settled activity', () => {
    render(<App />);
    const threadId = 'live-activity';
    const event = (value: Record<string, unknown>): void => {
      act(() => {
        sendHostMessage({ type: 'agentEvent', event: { ...value, backendId, threadId } });
        // An urgent host message flushes the stream's coalescing queue.
        sendHostMessage({ type: 'busy', value: true, backendId, threadId });
      });
    };
    act(() => {
      sendHostMessage({ type: 'snapshot', availability: [{ id: backendId, label: backendId, status: 'available' }] });
      sendHostMessage({ type: 'restoring', value: false });
      sendHostMessage({ type: 'conversation', backendId, threadId, replay: [] });
    });
    event({ type: 'turn/started', turnId: 'turn' });
    event({ type: 'item/started', item: { id: 'thought', kind: 'reasoning', title: 'Reasoning' } });
    expect(document.querySelector('.reasoning-wait')).not.toBeNull();
    const toggle = screen.getByRole('button', { name: 'Show Reasoning' });
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide Reasoning' }).getAttribute('aria-expanded')).toBe('true');
    event({ type: 'item/completed', itemId: 'thought', status: 'completed' });
    expect(document.querySelector('.reasoning-wait')).toBeNull();
    event({ type: 'item/started', item: { id: 'read', kind: 'tool', tool: 'read', title: 'Reading src/a.ts' } });
    event({ type: 'item/started', item: { id: 'grep', kind: 'tool', tool: 'grep', title: 'Searching tests' } });
    expect(screen.getByRole('button', { name: 'Exploring…' })).toBeTruthy();
    event({ type: 'item/completed', itemId: 'read', status: 'completed' });
    event({ type: 'item/completed', itemId: 'grep', status: 'completed' });
    expect(screen.queryByRole('button', { name: 'Exploring…' })).toBeNull();
    expect(screen.getByRole('button', { name: /Explored/ })).toBeTruthy();
  });
});
