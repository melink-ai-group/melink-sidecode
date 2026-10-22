import { expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReviewNotice } from './ReviewNotice';

it('exposes the complete message on keyboard focus outside the scrolling container and dismisses with Escape', () => {
  const { container, rerender } = render(
    <ReviewNotice label="Styling: clean" message="No styling-consistency findings.">icon</ReviewNotice>
  );
  expect(screen.queryByRole('tooltip')).toBeNull();
  const button = screen.getByRole('button', { name: 'Styling: clean' });
  fireEvent.focus(button);
  const tooltip = screen.getByRole('tooltip');
  expect(tooltip.textContent).toBe('No styling-consistency findings.');
  expect(container.contains(tooltip)).toBe(false);
  expect(button.getAttribute('aria-describedby')).toBe(tooltip.id);
  rerender(<ReviewNotice label="Styling unavailable" message="The styling check timed out.">icon</ReviewNotice>);
  expect(screen.getByRole('tooltip').textContent).toBe('The styling check timed out.');
  fireEvent.keyDown(button, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).toBeNull();
});

it('shows messages on hover and dismisses on blur or a viewport change', () => {
  render(<ReviewNotice label="Styling check details" message="No brand kit was found.">icon</ReviewNotice>);
  const button = screen.getByRole('button');
  fireEvent.mouseEnter(button);
  expect(screen.getByRole('tooltip').textContent).toBe('No brand kit was found.');
  fireEvent.resize(window);
  expect(screen.queryByRole('tooltip')).toBeNull();
  fireEvent.focus(button);
  fireEvent.blur(button);
  expect(screen.queryByRole('tooltip')).toBeNull();
});
