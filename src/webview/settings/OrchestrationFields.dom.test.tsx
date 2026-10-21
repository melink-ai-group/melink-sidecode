import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { OrchestrationFields, type OrchestrationFieldValues } from './OrchestrationFields';

const DEFAULT_VALUES: OrchestrationFieldValues = {
  testing: false,
  reviewing: false,
  doubleCheck: true,
  quickTask: true,
  planning: true
};

function renderFields(
  values: Partial<OrchestrationFieldValues> = {},
  legacy: { legacyTesting?: boolean; legacyReviewing?: boolean } = {}
): ReturnType<typeof vi.fn> {
  const onChange = vi.fn();
  render(
    <OrchestrationFields
      values={{ ...DEFAULT_VALUES, ...values }}
      legacyTesting={legacy.legacyTesting ?? false}
      legacyReviewing={legacy.legacyReviewing ?? false}
      onChange={onChange}
    />
  );
  return onChange;
}

describe('OrchestrationFields', () => {
  it('renders the effective summary from the values', () => {
    renderFields();
    expect(
      screen.getByRole('status').textContent
    ).toBe(
      'Effective policy: double-check and plan autopilot on · testing and reviewing off · quick tasks skip these passes.'
    );
  });

  it('renders the intro sentence exactly once', () => {
    renderFields();
    expect(screen.getAllByText('Changes apply from the next turn.')).toHaveLength(1);
  });

  it('reports every toggle change through onChange', () => {
    const onChange = renderFields({ testing: true });
    fireEvent.click(screen.getByRole('checkbox', { name: /Testing/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Reviewing/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Double-check/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Plan autopilot/ }));
    expect(onChange.mock.calls).toEqual([
      ['testing', false],
      ['reviewing', true],
      ['doubleCheck', false],
      ['planning', false]
    ]);
  });

  it('disables and unchecks quick tasks when every pass is off', () => {
    renderFields({ testing: false, reviewing: false, doubleCheck: false, quickTask: true });
    const quick = screen.getByRole('checkbox', { name: /Quick tasks/ }) as HTMLInputElement;
    expect(quick.disabled).toBe(true);
    expect(quick.checked).toBe(false);
    expect(screen.getByText('Enable at least one pass first.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(
      'Effective policy: plan autopilot on · testing, reviewing and double-check off.'
    );
  });

  it('saves quick tasks off when the last pass is turned off', () => {
    const onChange = renderFields({
      testing: true,
      reviewing: false,
      doubleCheck: false,
      quickTask: true
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Testing/ }));
    expect(onChange.mock.calls).toEqual([
      ['testing', false],
      ['quickTask', false]
    ]);
  });

  it('explains a legacy source instead of the normal help', () => {
    renderFields({ testing: true, reviewing: true }, { legacyTesting: true, legacyReviewing: true });
    expect(
      screen.getByText('On from `melink.review.checks.enabled`; saving takes over.')
    ).toBeTruthy();
    expect(
      screen.getByText('On from `melink.review.diffReview`; saving takes over.')
    ).toBeTruthy();
  });
});
