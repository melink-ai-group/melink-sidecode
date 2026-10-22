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

describe('injected orchestration entries', () => {
  it('never renders an injected continuation in the transcript', () => {
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

    expect(document.querySelector('.turn--orchestration')).toBeNull();
    expect(screen.queryByText(/Continue the remaining steps/)).toBeNull();
    // Only the user's own line says You.
    expect(screen.getAllByText('You')).toHaveLength(1);
    expect(screen.getByText('Working on it.')).toBeTruthy();
  });

  it('hides a transcript that is only orchestration rows', () => {
    openConversation([
      {
        id: 'orch-1',
        kind: 'message',
        role: 'user',
        text: ORCHESTRATION_TEXT,
        orchestration: true
      }
    ]);

    expect(document.querySelector('.turn--orchestration')).toBeNull();
    expect(screen.queryByText('You')).toBeNull();
    expect(screen.queryByText(/Continue the remaining steps/)).toBeNull();
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

  it('does not draw a live instruction row when the host dispatches it', () => {
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

    expect(document.querySelector('.turn--orchestration')).toBeNull();
    expect(screen.queryByText(/Continue the remaining steps/)).toBeNull();
    expect(screen.getAllByText('You')).toHaveLength(1);
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
