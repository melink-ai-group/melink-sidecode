import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SaveFooter, type SaveFooterProps } from './SaveFooter';

function renderFooter(overrides: Partial<SaveFooterProps> = {}): {
  onSave: ReturnType<typeof vi.fn>;
  onReset: ReturnType<typeof vi.fn>;
  onJump: ReturnType<typeof vi.fn>;
} {
  const onSave = vi.fn();
  const onReset = vi.fn();
  const onJump = vi.fn();
  render(
    <SaveFooter
      dirty
      target="global"
      onSave={onSave}
      onReset={onReset}
      onJumpToProblem={onJump}
      {...overrides}
    />
  );
  return { onSave, onReset, onJump };
}

describe('SaveFooter', () => {
  it('shows a disabled Saving button, spinner and aria-busy while pending', () => {
    renderFooter({ save: { pending: true } });
    const button = screen.getByRole('button', { name: /Saving/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('.spinner')).toBeTruthy();
    expect(screen.getByText('Saving settings...')).toBeTruthy();
    const reset = screen.getByRole('button', { name: 'Reset' }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    expect(document.querySelector('.settings-foot')?.getAttribute('aria-busy')).toBe('true');
  });

  it('reports a successful save when the draft is clean', () => {
    renderFooter({ dirty: false, save: { pending: false, ok: true } });
    expect(screen.getByRole('status').textContent).toContain('Settings saved.');
    expect(document.querySelector('.settings-foot')?.getAttribute('aria-busy')).toBe('false');
  });

  it('keeps the failure visible and the action enabled for a retry', () => {
    const { onSave } = renderFooter({
      save: { pending: false, ok: false, message: 'One setting was not saved. Check the marked field and try again.' }
    });
    expect(screen.getByRole('alert').textContent).toContain('One setting was not saved');
    const button = screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('shows a local validation refusal as an alert with a jump back to the field', () => {
    const { onJump } = renderFooter({
      blocked: { message: 'Enter a whole number of kilobytes between 1 and 1024.', actionLabel: 'Go to Context' }
    });
    expect(screen.getByRole('alert').textContent).toContain('whole number of kilobytes');
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Go to Context' }));
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('prevents a double submit in the same tick', () => {
    const { onSave } = renderFooter();
    const button = screen.getByRole('button', { name: 'Save settings' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('offers the effective workspace save as primary and the user save as secondary', async () => {
    const { onSave } = renderFooter({ target: 'workspace' });
    fireEvent.click(screen.getByRole('button', { name: 'Save to workspace' }));
    expect(onSave).toHaveBeenLastCalledWith('workspace');
    await Promise.resolve();
    fireEvent.click(screen.getByRole('button', { name: 'Save user settings' }));
    expect(onSave).toHaveBeenLastCalledWith('global');
  });

  it('labels a folder-scoped save and keeps the user save available', async () => {
    const { onSave } = renderFooter({ target: 'folder' });
    fireEvent.click(screen.getByRole('button', { name: 'Save to folder settings' }));
    expect(onSave).toHaveBeenLastCalledWith('folder');
    await Promise.resolve();
    fireEvent.click(screen.getByRole('button', { name: 'Save user settings' }));
    expect(onSave).toHaveBeenLastCalledWith('global');
  });
});
