import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { App } from './App';
import { sendHostMessage } from './domSetup';

const availableBackend = {
  id: 'codex',
  label: 'Codex',
  badge: 'CLI',
  status: 'available' as const
};

describe('webview smoke', () => {
  it('renders the composer from the default host state', () => {
    render(<App />);

    const composer = screen.getByLabelText('Message the agent') as HTMLTextAreaElement;
    expect(composer.tagName).toBe('TEXTAREA');
    expect(composer.id).toBe('prompt');
    expect(composer.disabled).toBe(true);
    expect(screen.getByRole('log', { name: 'Conversation transcript' })).toBeTruthy();
    expect(screen.getByText('Restoring conversation...')).toBeTruthy();
  });

  it('renders a replayed reasoning panel without crashing', () => {
    render(<App />);

    act(() => {
      sendHostMessage({ type: 'snapshot', availability: [availableBackend] });
      sendHostMessage({ type: 'restoring', value: false });
      sendHostMessage({
        type: 'conversation',
        backendId: 'codex',
        threadId: 'thread-smoke',
        replay: [
          {
            id: 'reason-smoke',
            kind: 'reasoning',
            title: 'Reasoning',
            text: 'Checking the request before acting.'
          }
        ]
      });
    });

    expect(screen.getByRole('button', { name: 'Show Reasoning' })).toBeTruthy();
    expect(screen.getByText('Checking the request before acting.')).toBeTruthy();
  });
});
