import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { OrchestrationFields, type OrchestrationFieldValues } from './OrchestrationFields';

const DEFAULT_VALUES: OrchestrationFieldValues = {
  testing: 'on',
  reviewing: 'auto',
  styling: 'auto',
  doubleCheck: 'auto',
  quickTask: 'off',
  planning: 'auto'
};

function renderFields(
  values: Partial<OrchestrationFieldValues> = {},
  legacy: { legacyTesting?: boolean; legacyReviewing?: boolean } = {},
  dictation = true
): { onChange: ReturnType<typeof vi.fn>; onDictationChange: ReturnType<typeof vi.fn> } {
  const onChange = vi.fn();
  const onDictationChange = vi.fn();
  render(
    <OrchestrationFields
      values={{ ...DEFAULT_VALUES, ...values }}
      dictation={dictation}
      legacyTesting={legacy.legacyTesting ?? false}
      legacyReviewing={legacy.legacyReviewing ?? false}
      onChange={onChange}
      onDictationChange={onDictationChange}
    />
  );
  return { onChange, onDictationChange };
}

describe('OrchestrationFields', () => {
  it('renders the default tri-state summary with dictation On', () => {
    renderFields();
    expect(screen.getByRole('status').textContent).toBe(
      'Effective policy: testing On, reviewing Auto, styling Auto, double-check Auto and plan autopilot Auto. Quick bypass always applies; quick notice Off; dictation On.'
    );
  });

  it('renders the intro, the Auto explanation, and the dictation switch once', () => {
    renderFields();
    expect(screen.getAllByText('Changes apply from the next turn.')).toHaveLength(1);
    expect(
      screen.getByText(
        'Auto runs a pass only when this turn is relevant; On runs it whenever its mode applies; Off never runs it.'
      )
    ).toBeTruthy();
    const toggle = screen.getByRole('checkbox', { name: /Dictation for orchestration/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByText(/Uses the dictation model when one is set/)).toBeTruthy();
  });

  it('reports the dictation switch through onDictationChange and explains Off', () => {
    const { onDictationChange } = renderFields({}, {}, false);
    const toggle = screen.getByRole('checkbox', { name: /Dictation for orchestration/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByText('Off keeps the fixed Auto, On, and Off rules and makes no decision call.')).toBeTruthy();
    fireEvent.click(toggle);
    expect(onDictationChange.mock.calls).toEqual([[true]]);
  });

  it('shows one select per role with the three choices and the stored value', () => {
    renderFields();
    const selects = screen.getAllByRole('combobox');
    expect(selects).toHaveLength(6);
    expect((screen.getByRole('combobox', { name: /Testing/ }) as HTMLSelectElement).value).toBe('on');
    expect((screen.getByRole('combobox', { name: /Reviewing/ }) as HTMLSelectElement).value).toBe('auto');
    expect((screen.getByRole('combobox', { name: /Quick tasks/ }) as HTMLSelectElement).value).toBe('off');
    for (const select of selects) {
      expect(Array.from((select as HTMLSelectElement).options).map((option) => option.value)).toEqual([
        'auto',
        'on',
        'off'
      ]);
    }
  });

  it('reports every tri-state change through onChange', () => {
    const { onChange } = renderFields();
    fireEvent.change(screen.getByRole('combobox', { name: /Testing/ }), { target: { value: 'off' } });
    fireEvent.change(screen.getByRole('combobox', { name: /Reviewing/ }), { target: { value: 'on' } });
    fireEvent.change(screen.getByRole('combobox', { name: /Styling check/ }), { target: { value: 'off' } });
    fireEvent.change(screen.getByRole('combobox', { name: /Double-check/ }), { target: { value: 'on' } });
    fireEvent.change(screen.getByRole('combobox', { name: /Quick tasks/ }), { target: { value: 'auto' } });
    fireEvent.change(screen.getByRole('combobox', { name: /Plan autopilot/ }), { target: { value: 'off' } });
    expect(onChange.mock.calls).toEqual([
      ['testing', 'off'],
      ['reviewing', 'on'],
      ['styling', 'off'],
      ['doubleCheck', 'on'],
      ['quickTask', 'auto'],
      ['planning', 'off']
    ]);
  });

  it('keeps Quick editable when every other pass is Off', () => {
    renderFields({
      testing: 'off',
      reviewing: 'off',
      styling: 'off',
      doubleCheck: 'off',
      quickTask: 'off'
    });
    const quick = screen.getByRole('combobox', { name: /Quick tasks/ }) as HTMLSelectElement;
    expect(quick.disabled).toBe(false);
    expect(quick.value).toBe('off');
    expect(screen.getByRole('status').textContent).toBe(
      'Effective policy: testing Off, reviewing Off, styling Off, double-check Off and plan autopilot Auto. Quick bypass always applies; quick notice Off; dictation On.'
    );
  });

  it('explains a legacy source instead of the normal help', () => {
    renderFields({ testing: 'on', reviewing: 'on' }, { legacyTesting: true, legacyReviewing: true });
    expect(
      screen.getByText('On from `melink.review.checks.enabled`; saving takes over.')
    ).toBeTruthy();
    expect(
      screen.getByText('On from `melink.review.diffReview`; saving takes over.')
    ).toBeTruthy();
  });
});
