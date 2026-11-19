import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { clearHostMessages, hostMessages, sendHostMessage } from './domSetup';
import { readClipboardFile } from './composer/attachments';
import type { PlanArtifact } from '../backends/types';

beforeEach(() => vi.stubGlobal('CSS', { escape: (value: string) => value }));
afterEach(() => vi.unstubAllGlobals());

it('clipboard text and PDF files retain their bytes as well as their names', async () => {
  for (const [name, type, content] of [['notes.txt', 'text/plain', 'Attached notes'], ['document.pdf', 'application/pdf', '%PDF-1.4']]) {
    const attachment = await readClipboardFile(new File([content], name, { type }));
    expect(attachment?.dataUrl).toBe(`data:${type};base64,${btoa(content)}`);
    expect(attachment?.name).toBe(name);
  }
  const inferred = await readClipboardFile(new File(['Notes'], 'notes.txt'));
  expect(inferred?.mimeType).toBe('text/plain');
  expect(inferred?.dataUrl).toBe('data:text/plain;base64,Tm90ZXM=');
  const failedRead = vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(() => { throw new Error('unreadable'); });
  try {
    expect(await readClipboardFile(new File(['unreadable'], 'notes.txt', { type: 'text/plain' }))).toBeUndefined();
  } finally { failedRead.mockRestore(); }
});

interface SendTurnMessage {
  type: 'sendTurn';
  text: string;
  quick?: boolean;
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
  afterEach(() => vi.useRealTimers());

  it.each(['ask', 'plan'] as const)('sends immediately without quick send in %s mode', (mode) => {
    vi.useFakeTimers();
    const composer = renderComposer();
    act(() => sendHostMessage({
      type: 'conversation', backendId: 'codex', threadId: 'thread-composer', replay: [], mode
    }));
    fireEvent.change(composer, { target: { value: 'Explain the requested changes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.queryByRole('button', { name: 'Send quick request' })).toBeNull();
    expect(sendTurnMessages()).toHaveLength(1);
    expect(sendTurnMessages()[0]?.quick).toBeUndefined();
    act(() => vi.advanceTimersByTime(700));
    expect(sendTurnMessages()).toHaveLength(1);
  });

  it('offers quick send for 600 ms before sending normally', () => {
    vi.useFakeTimers();
    const composer = renderComposer();
    fireEvent.change(composer, { target: { value: 'Implement the requested changes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('button', { name: 'Send quick request' })).toBeTruthy();
    act(() => vi.advanceTimersByTime(599));
    expect(sendTurnMessages()).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    expect(sendTurnMessages()).toHaveLength(1);
    expect(sendTurnMessages()[0]?.quick).toBeUndefined();
  });

  it('sends exactly one quick request on the second activation', () => {
    vi.useFakeTimers();
    const composer = renderComposer();
    fireEvent.change(composer, { target: { value: 'Implement the requested changes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    act(() => vi.advanceTimersByTime(250));
    fireEvent.click(screen.getByRole('button', { name: 'Send quick request' }));
    act(() => vi.advanceTimersByTime(1000));
    expect(sendTurnMessages()).toHaveLength(1);
    expect(sendTurnMessages()[0]).toMatchObject({ text: 'Implement the requested changes', quick: true });
  });

  it('cancels a pending send when the draft changes or the host becomes busy', () => {
    vi.useFakeTimers();
    const composer = renderComposer();
    fireEvent.change(composer, { target: { value: 'original draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.change(composer, { target: { value: 'edited draft' } });
    act(() => vi.advanceTimersByTime(600));
    expect(sendTurnMessages()).toHaveLength(0);
    expect(composer.value).toBe('edited draft');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    act(() => sendHostMessage({ type: 'busy', value: true, backendId: 'codex', threadId: 'thread-composer' }));
    act(() => vi.advanceTimersByTime(600));
    expect(sendTurnMessages()).toHaveLength(0);
  });

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

it('uses the Build Plan button only for an empty linked Plan composer and scopes toggles to the chat', () => {
  const composer = renderComposer();
  const plan: PlanArtifact = {
    path: '.melink/plans/task.md', title: 'Task', updatedAt: 1,
    steps: [{ text: 'Complete the task', status: 'pending' }]
  };
  const tab = { id: 'plan-tab', title: 'Plan chat', active: true, backendId: 'codex', threadId: 'thread-composer' };
  const publishPlan = () => sendHostMessage({
    type: 'conversation', backendId: tab.backendId, threadId: tab.threadId, replay: [], mode: 'plan', plan
  });
  const build = () => screen.queryByRole('button', { name: 'Build Plan' });
  act(() => {
    sendHostMessage({ type: 'chatTabs', tabs: [tab] });
    publishPlan();
  });
  expect(build()?.hasAttribute('disabled')).toBe(false);
  fireEvent.click(build()!);
  expect(hostMessages()).toContainEqual({
    type: 'buildPlan', composer: { tabId: tab.id, threadId: tab.threadId }
  });
  const chip = screen.getByRole('button', { name: plan.path });
  fireEvent.click(chip);
  expect(hostMessages()).toContainEqual({ type: 'openPlanFile' });
  fireEvent.change(composer, { target: { value: 'Revise the plan' } });
  expect(build()).toBeNull();
  expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  fireEvent.change(composer, { target: { value: '' } });
  act(() => sendHostMessage({
    type: 'attachmentsAdded', tabId: tab.id,
    attachments: [{ id: 'note', kind: 'text', name: 'note.txt', mimeType: 'text/plain', path: '/workspace/note.txt' }]
  }));
  expect(build()).toBeNull();
  expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Remove note.txt' }));
  expect(build()).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Remove ' + plan.path + ' from context' }));
  expect(hostMessages()).toContainEqual({
    type: 'setPlanContext', tabId: tab.id, threadId: tab.threadId, included: false
  });
  act(() => sendHostMessage({ type: 'chatTabs', tabs: [{ ...tab, planContextExcluded: true }] }));
  expect(build()).toBeNull();
  expect(screen.getByRole('button', { name: 'Dictate a message' })).toBeTruthy();
  const add = screen.getByRole('button', { name: 'Add ' + plan.path + ' to context' });
  expect(add.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(add);
  expect(hostMessages()).toContainEqual({
    type: 'setPlanContext', tabId: tab.id, threadId: tab.threadId, included: true
  });
  act(() => sendHostMessage({ type: 'chatTabs', tabs: [{ ...tab, id: 'other-tab', threadId: 'other-thread' }] }));
  expect(screen.queryByRole('button', { name: plan.path })).toBeNull();
});

it('keeps Stop while a plan is running and disables Build for a completed plan', async () => {
  renderComposer();
  const threadId = 'thread-composer';
  const plan: PlanArtifact = {
    path: '.melink/plans/task.md', title: 'Task', updatedAt: 1, built: true,
    steps: [{ text: 'One step', status: 'pending' }]
  };
  act(() => {
    sendHostMessage({ type: 'chatTabs', tabs: [{ id: 'tab', title: 'Plan chat', active: true, threadId }] });
    sendHostMessage({ type: 'conversation', backendId: 'codex', threadId, replay: [], mode: 'plan', plan });
    sendHostMessage({ type: 'busy', value: true, backendId: 'codex', threadId });
  });
  expect(screen.queryByRole('button', { name: 'Build Plan' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  act(() => {
    sendHostMessage({ type: 'busy', value: false, backendId: 'codex', threadId });
    sendHostMessage({ type: 'plan', plan: { ...plan, steps: [{ text: 'One step', status: 'completed' }] } });
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Build Plan' }).hasAttribute('disabled')).toBe(true));
});
