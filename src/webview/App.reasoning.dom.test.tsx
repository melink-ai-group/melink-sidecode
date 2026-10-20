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
