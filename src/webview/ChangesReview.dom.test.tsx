import { expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ChangesReview, type ChangesReviewProps } from './ChangesReview';
import { App } from './App';
import { hostMessages, sendHostMessage } from './domSetup';
import type { ChangeView } from '../protocol';

const replay = [
  { id: 'user-1', kind: 'message', role: 'user', text: 'Build the view' },
  { id: 'reply-1', kind: 'message', role: 'assistant', text: 'Updated the view.' }
];

async function openReviewedConversation(): Promise<void> {
  render(<App />);
  act(() => {
    sendHostMessage({ type: 'snapshot', availability: [{ id: 'codex', label: 'Codex', badge: 'CLI', status: 'available' }] });
    sendHostMessage({ type: 'conversation', backendId: 'codex', threadId: 'thread-review', replay });
    sendHostMessage({ type: 'restoring', value: false });
    sendHostMessage({ type: 'changes/review', review: review() });
  });
  await screen.findByRole('button', { name: 'Fix' });
}

function review(): ChangeView {
  return {
    backendId: 'codex', threadId: 'thread-review', turnId: 'turn-review', messageId: 'user-1',
    additions: 1, deletions: 0, fullyDecided: false,
    files: [{ path: 'src/view.tsx', absPath: 'C:/project/src/view.tsx', status: 'modified', source: 'reported',
      binary: false, diffable: true, additions: 1, deletions: 0, decision: 'pending', hunks: [] }],
    stylingReview: { status: 'reviewed', findings: [
      { path: 'src/view.tsx', line: 3, severity: 'info', message: 'Use the shared spacing token.' },
      { path: 'src/view.tsx', line: 4, severity: 'warning', message: 'Add a visible focus state.' }
    ] },
    diffReview: { status: 'reviewed', findings: [
      { path: 'src/view.tsx', line: 8, severity: 'error', message: 'Handle the rejected request.' }
    ] },
    checks: { status: 'failed', startedAt: 1, summary: 'Checks failed', results: [
      { name: 'typecheck', command: 'npm run typecheck', status: 'error', durationMs: 100,
        reason: 'Compilation failed', output: 'src/view.tsx:8: missing property' }
    ] }
  };
}

function props(value = review()): ChangesReviewProps {
  return {
    review: value, busy: false, deciding: false, onFix: vi.fn(), onOpenFile: vi.fn(), onOpenDiff: vi.fn(),
    onOpenAllInEditor: vi.fn(), onRevealInSourceControl: vi.fn(), onKeep: vi.fn(), onRequestReject: vi.fn(),
    onCancelReject: vi.fn(), onConfirmReject: vi.fn(), onKeepAll: vi.fn(), onResolveConflict: vi.fn(), onLoadHunks: vi.fn()
  };
}

it('shows collapsed severity counts, expands the complete findings, and sends all issues to Fix', () => {
  const options = props();
  render(<ChangesReview {...options} />);
  expect(screen.getByRole('img', { name: '2 errors' })).toBeTruthy();
  expect(screen.getByRole('img', { name: '1 warning' })).toBeTruthy();
  expect(screen.getByRole('img', { name: '1 informational notice' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Files changed/ }));
  expect(screen.queryByRole('status', { name: 'Issues need attention' })).toBeNull();
  expect(screen.getByText('Use the shared spacing token.')).toBeTruthy();
  expect(screen.getByText('Handle the rejected request.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Fix' }));
  const text = vi.mocked(options.onFix).mock.calls[0][0];
  expect(text).not.toContain(options.review.turnId);
  for (const detail of ['Info: src/view.tsx:3', 'Warning: src/view.tsx:4',
    'Error: src/view.tsx:8', 'npm run typecheck', 'Compilation failed', 'missing property']) {
    expect(text).toContain(detail);
  }
});

it('disables Fix during a turn or decision and removes stale indicators when results clear', () => {
  const options = props();
  const { rerender } = render(<ChangesReview {...options} busy />);
  expect((screen.getByRole('button', { name: 'Fix' }) as HTMLButtonElement).disabled).toBe(true);
  rerender(<ChangesReview {...options} deciding />);
  expect((screen.getByRole('button', { name: 'Fix' }) as HTMLButtonElement).disabled).toBe(true);
  rerender(<ChangesReview {...options} fixDisabled />);
  expect((screen.getByRole('button', { name: 'Fix' }) as HTMLButtonElement).disabled).toBe(true);
  rerender(<ChangesReview {...options} review={{ ...options.review, checks: undefined,
    diffReview: { status: 'no-findings', findings: [] }, stylingReview: undefined }} />);
  expect(screen.queryByRole('button', { name: 'Fix' })).toBeNull();
  expect(screen.queryByRole('status', { name: 'Issues need attention' })).toBeNull();
});

it('shows an unavailable review inline and includes its reason in Fix', () => {
  const options = props({ ...review(), checks: undefined, diffReview: undefined,
    stylingReview: { status: 'failed', findings: [], notice: 'Styling review timed out.' } });
  render(<ChangesReview {...options} />);
  fireEvent.click(screen.getByRole('button', { name: /Files changed/ }));
  expect(screen.getByText('Styling review timed out.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Fix' }));
  expect(vi.mocked(options.onFix).mock.calls[0][0]).toContain('Styling review timed out.');
});

it('posts Fix as a user turn using the selected backend and preserves the composer draft', async () => {
  render(<App />);
  act(() => {
    sendHostMessage({ type: 'snapshot', availability: [{ id: 'codex', label: 'Codex', badge: 'CLI', status: 'available' }] });
    sendHostMessage({ type: 'restoring', value: false });
    sendHostMessage({ type: 'conversation', backendId: 'codex', threadId: 'thread-review', replay: [
      { id: 'user-1', kind: 'message', role: 'user', text: 'Build the view' }
    ] });
  });
  act(() => {
    sendHostMessage({ type: 'changes/changed', backendId: 'codex', threadId: 'thread-review', turnId: 'turn-review',
      messageId: 'user-1', entries: [{ path: 'src/view.tsx', absPath: 'C:/project/src/view.tsx', status: 'modified', source: 'reported' }] });
    sendHostMessage({ type: 'changes/review', review: review() });
  });
  const fix = await screen.findByRole('button', { name: 'Fix' });
  const composer = screen.getByLabelText('Message the agent') as HTMLTextAreaElement;
  fireEvent.change(composer, { target: { value: 'My next request' } });
  fireEvent.click(fix);
  const sent = hostMessages().filter((message) => (message as { type: string }).type === 'sendTurn') as Array<{ text: string; backendId: string }>;
  expect(sent).toHaveLength(1);
  expect(sent[0].backendId).toBe('codex');
  expect(sent[0].text).toContain('Handle the rejected request.');
  expect(composer.value).toBe('My next request');
  expect(screen.getAllByText(/Fix the following issues/).length).toBeGreaterThan(0);
});

it('keeps restored change cards and their findings through late hydration of the same conversation', async () => {
  await openReviewedConversation();
  fireEvent.click(screen.getByRole('button', { name: /Files changed/ }));
  const panel = screen.getByRole('region', { name: 'Files changed' });
  act(() => {
    sendHostMessage({ type: 'conversation', backendId: 'codex', threadId: 'thread-review', replay: [
      { id: 'older-user', kind: 'message', role: 'user', text: 'Earlier request' }, ...replay
    ] });
  });
  expect(screen.getByRole('region', { name: 'Files changed' })).toBe(panel);
  expect(screen.getByText('Add a visible focus state.')).toBeTruthy();
  expect(screen.getByRole('button', { name: /Files changed/ }).getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('button', { name: 'Fix' })).toBeTruthy();
});

it('keeps the final changes and findings when a turn finishes and its conversation is repainted', async () => {
  await openReviewedConversation();
  act(() => {
    sendHostMessage({ type: 'agentEvent', event: { type: 'turn/started', backendId: 'codex', threadId: 'thread-review', turnId: 'next-turn' } });
  });
  // Busy is urgent and flushes the queued lifecycle event before checking the panel.
  act(() => sendHostMessage({ type: 'busy', value: true, backendId: 'codex', threadId: 'thread-review' }));
  expect((screen.getByRole('button', { name: 'Fix' }) as HTMLButtonElement).disabled).toBe(true);
  act(() => {
    sendHostMessage({ type: 'changes/review', review: { ...review(), turnId: 'next-turn' } });
    sendHostMessage({ type: 'agentEvent', event: { type: 'turn/completed', backendId: 'codex', threadId: 'thread-review', turnId: 'next-turn' } });
    sendHostMessage({ type: 'busy', value: false, backendId: 'codex', threadId: 'thread-review' });
    sendHostMessage({ type: 'conversation', backendId: 'codex', threadId: 'thread-review', replay });
  });
  fireEvent.click(screen.getByRole('button', { name: /Files changed/ }));
  expect(screen.getByText('Handle the rejected request.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Fix' }) as HTMLButtonElement).disabled).toBe(false);
});

it('still clears stale cards on a conversation switch or an explicit host reset', async () => {
  await openReviewedConversation();
  act(() => sendHostMessage({ type: 'conversation', backendId: 'codex', threadId: 'another-thread', replay }));
  expect(screen.queryByRole('button', { name: /Files changed/ })).toBeNull();
  act(() => {
    sendHostMessage({ type: 'conversation', backendId: 'codex', threadId: 'thread-review', replay });
    sendHostMessage({ type: 'changes/review', review: review() });
  });
  await screen.findByRole('button', { name: 'Fix' });
  act(() => {
    sendHostMessage({ type: 'changes/changed', backendId: 'codex', threadId: 'thread-review', turnId: '', entries: [] });
    sendHostMessage({ type: 'restoring', value: false });
  });
  expect(screen.queryByRole('button', { name: /Files changed/ })).toBeNull();
});

it('preserves checkpoint anchors for restored cards that have no message id', async () => {
  await openReviewedConversation();
  act(() => {
    sendHostMessage({ type: 'changes/changed', backendId: 'codex', threadId: 'thread-review', turnId: '', entries: [] });
    sendHostMessage({ type: 'changes/checkpoints', checkpoints: [{ backendId: 'codex', threadId: 'thread-review',
      turnId: 'turn-review', messageId: 'user-1', createdAt: 1, fileCount: 1, paths: ['src/view.tsx'] }] });
    sendHostMessage({ type: 'changes/review', review: { ...review(), messageId: undefined } });
  });
  await screen.findByRole('button', { name: 'Fix' });
  act(() => sendHostMessage({ type: 'conversation', backendId: 'codex', threadId: 'thread-review', replay }));
  expect(screen.getByRole('button', { name: /Files changed/ })).toBeTruthy();
  act(() => sendHostMessage({ type: 'conversation', backendId: 'opencode', threadId: 'thread-review', replay }));
  expect(screen.queryByRole('button', { name: /Files changed/ })).toBeNull();
});
