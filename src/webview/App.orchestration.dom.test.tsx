import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { App } from './App';
import { sendHostMessage } from './domSetup';

const availableBackend = {
  id: 'codex',
  label: 'Codex',
  badge: 'CLI',
  status: 'available' as const
};

const THREAD_ID = 'thread-orchestration';
const ORCHESTRATION_TEXT =
  'Continue the remaining steps of this plan. Do not stop to ask whether to continue.\n\n- [ ] Fix the ring';

function openConversation(replay: Parameters<typeof conversationMessage>[0]): void {
  render(<App />);
  act(() => {
    sendHostMessage({ type: 'snapshot', availability: [availableBackend] });
    sendHostMessage({ type: 'restoring', value: false });
    sendHostMessage(conversationMessage(replay));
  });
}

function conversationMessage(
  replay: Array<{
    id: string;
    kind: 'message';
    role: 'user' | 'assistant';
    text: string;
    orchestration?: boolean;
  }>
) {
  return {
    type: 'conversation' as const,
    backendId: 'codex',
    threadId: THREAD_ID,
    replay
  };
}

describe('orchestration transcript entries', () => {
  it('renders an injected continuation as a collapsed tagged line, not as You', () => {
    openConversation([
      { id: 'user-1', kind: 'message', role: 'user', text: 'Build the ring' },
      {
        id: 'orch-1',
        kind: 'message',
        role: 'user',
        text: ORCHESTRATION_TEXT,
        orchestration: true
      },
      { id: 'reply-1', kind: 'message', role: 'assistant', text: 'Working on it.' }
    ]);

    const details = document.querySelector<HTMLDetailsElement>('.turn--orchestration');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.querySelector('.orchestration-tag')?.textContent).toBe('Orchestration');
    expect(details?.querySelector('.orchestration-line')?.textContent).toContain(
      'Continue the remaining steps of this plan.'
    );
    // Only the user's own line says You.
    expect(screen.getAllByText('You')).toHaveLength(1);
  });

  it('expands and collapses the orchestration entry on click', () => {
    openConversation([
      {
        id: 'orch-1',
        kind: 'message',
        role: 'user',
        text: ORCHESTRATION_TEXT,
        orchestration: true
      }
    ]);

    const details = document.querySelector<HTMLDetailsElement>('.turn--orchestration');
    const summary = details?.querySelector('summary');
    expect(details?.open).toBe(false);

    act(() => {
      fireEvent.click(summary as HTMLElement);
    });
    expect(details?.open).toBe(true);

    act(() => {
      fireEvent.click(summary as HTMLElement);
    });
    expect(details?.open).toBe(false);
  });

  it('keeps the turn change card anchored when a continuation opens the turn', async () => {
    openConversation([
      {
        id: 'orch-1',
        kind: 'message',
        role: 'user',
        text: ORCHESTRATION_TEXT,
        orchestration: true
      },
      { id: 'reply-1', kind: 'message', role: 'assistant', text: 'Changed it.' }
    ]);

    act(() => {
      sendHostMessage({
        type: 'changes/changed',
        backendId: 'codex',
        threadId: THREAD_ID,
        turnId: 'turn-1',
        messageId: 'orch-1',
        entries: [
          {
            absPath: '/workspace/src/ring.ts',
            path: 'src/ring.ts',
            status: 'modified',
            source: 'reported'
          }
        ]
      });
    });

    // `changes/changed` is a coalesced message, so let the pump flush.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(screen.getByLabelText('Changed files')).toBeTruthy();
  });

  it('adds a live orchestration row when the host dispatches a continuation', () => {
    openConversation([
      { id: 'user-1', kind: 'message', role: 'user', text: 'Build the ring' },
      { id: 'reply-1', kind: 'message', role: 'assistant', text: 'Planning.' }
    ]);

    act(() => {
      sendHostMessage({
        type: 'userMessageSent',
        backendId: 'codex',
        threadId: THREAD_ID,
        messageId: 'orch-live',
        text: ORCHESTRATION_TEXT,
        sentAt: Date.now(),
        orchestration: true
      });
    });

    const details = document.querySelector<HTMLDetailsElement>('.turn--orchestration');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(screen.queryByText('You')).toBeTruthy();
  });

  it('does not show the Starting row while an orchestration turn begins', async () => {
    openConversation([
      {
        id: 'orch-1',
        kind: 'message',
        role: 'user',
        text: ORCHESTRATION_TEXT,
        orchestration: true
      }
    ]);

    act(() => {
      sendHostMessage({
        type: 'agentEvent',
        event: { type: 'turn/started', backendId: 'codex', threadId: THREAD_ID, turnId: 'turn-1' }
      });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(screen.queryByText('Starting')).toBeNull();
  });

  it('still shows the Starting row for a normal user turn', async () => {
    openConversation([
      { id: 'user-1', kind: 'message', role: 'user', text: 'Build the ring' }
    ]);

    act(() => {
      sendHostMessage({
        type: 'agentEvent',
        event: { type: 'turn/started', backendId: 'codex', threadId: THREAD_ID, turnId: 'turn-1' }
      });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(screen.getByText('Starting')).toBeTruthy();
  });
});
