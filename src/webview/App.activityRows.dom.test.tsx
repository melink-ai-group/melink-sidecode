import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { App } from './App';
import { sendHostMessage } from './domSetup';
import type { TranscriptItemView } from './state';

const userMessage: TranscriptItemView = {
  id: 'u1',
  kind: 'message',
  role: 'user',
  text: 'Check the brand import.',
  status: 'completed'
};

function renderOpenCode(replay: TranscriptItemView[]): void {
  render(<App />);
  act(() => {
    sendHostMessage({
      type: 'snapshot',
      availability: [{ id: 'opencode', label: 'OpenCode Zen', badge: 'Zen', status: 'available' }]
    });
    sendHostMessage({ type: 'restoring', value: false });
    sendHostMessage({ type: 'conversation', backendId: 'opencode', threadId: 'thread-rows', replay });
  });
}

describe('activity rows', () => {
  it('renders an opencode investigation as one plain, expandable row', () => {
    renderOpenCode([
      userMessage,
      { id: 'think', kind: 'reasoning', title: 'Reasoning', text: 'Let me find the importer.', status: 'completed' },
      { id: 'read', kind: 'tool', tool: 'read', title: 'Reading brand.ts', text: '', status: 'completed' },
      { id: 'grep', kind: 'tool', tool: 'grep', title: 'Searching for brand', text: '', status: 'completed' }
    ]);

    const toggle = screen.getByRole('button', { name: /Let me find the importer/ });
    const row = toggle.closest('.activity-row');
    expect(row).not.toBeNull();
    expect(row?.classList.contains('item-card')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const burst = screen.getByRole('button', { name: 'Explored 1 file, 1 search' });
    expect(burst.closest('.activity-row')?.classList.contains('item-card')).toBe(false);

    fireEvent.click(burst);
    expect(screen.getByText('Reading brand.ts')).toBeTruthy();
    expect(screen.getByText('Searching for brand')).toBeTruthy();
  });

  it('leaves a tool with no output as plain text', () => {
    renderOpenCode([
      userMessage,
      { id: 'quiet', kind: 'tool', tool: 'read', title: 'Reading quiet.ts', text: '', status: 'completed' }
    ]);

    const row = screen.getByText('Reading quiet.ts').closest('.activity-row');
    expect(row).not.toBeNull();
    expect(row?.querySelector('.item-card')).toBeNull();
    expect(row?.querySelector('summary')).toBeNull();
  });

  it('gives tool output a panel under the plain row', () => {
    renderOpenCode([
      userMessage,
      { id: 'loud', kind: 'tool', tool: 'bash', title: 'Running npm test', text: 'All tests passed', status: 'completed' }
    ]);

    const row = screen.getByText('Running npm test').closest('details.activity-row');
    expect(row).not.toBeNull();
    expect(row?.classList.contains('item-card')).toBe(false);
    expect(row?.querySelector('.activity-row__head .item-card')).toBeNull();
    expect(row?.querySelector('.item-card .item-body')).not.toBeNull();
  });

  it('gives a file change a diff panel without boxing the row', () => {
    renderOpenCode([
      userMessage,
      {
        id: 'change',
        kind: 'file-change',
        title: 'Editing brand.ts',
        files: [
          {
            path: 'src/brand.ts',
            additions: 1,
            deletions: 1,
            lines: [
              { kind: 'del', text: 'const target = url;' },
              { kind: 'add', text: 'const target = resolve(url);' }
            ]
          }
        ],
        text: '',
        status: 'completed'
      }
    ]);

    const row = document.querySelector('details.activity-row--change');
    expect(row).not.toBeNull();
    expect(row?.classList.contains('item-card')).toBe(false);
    expect(row?.querySelector('.activity-row__head .item-card')).toBeNull();
    expect(row?.querySelector('.item-card.diff-body')).not.toBeNull();
  });
});
