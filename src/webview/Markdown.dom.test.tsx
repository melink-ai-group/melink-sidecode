import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Markdown } from './Markdown';

describe('Markdown navigation', () => {
  it('opens an inline file reference instead of leaving it as code text', () => {
    const onOpenFile = vi.fn();
    render(<Markdown text="See `src/webview/App.tsx:12` for the call." onOpenFile={onOpenFile} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open src/webview/App.tsx' }));

    expect(onOpenFile).toHaveBeenCalledWith({ path: 'src/webview/App.tsx', line: 12 });
  });

  it('opens an http link through the host and keeps the page from navigating', () => {
    const onOpenLink = vi.fn();
    render(<Markdown text="Run [the app](http://localhost:3000/app) and check." onOpenLink={onOpenLink} />);

    const link = screen.getByRole('link', { name: 'the app' });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);

    expect(onOpenLink).toHaveBeenCalledWith('http://localhost:3000/app');
    expect(event.defaultPrevented).toBe(true);
  });

  it('linkifies a bare project URL', () => {
    const onOpenLink = vi.fn();
    render(<Markdown text="The page is at http://localhost:5173/ now." onOpenLink={onOpenLink} />);

    fireEvent.click(screen.getByRole('link', { name: 'http://localhost:5173/' }));

    expect(onOpenLink).toHaveBeenCalledWith('http://localhost:5173/');
  });

  it('leaves ordinary inline code as code', () => {
    render(<Markdown text="Call `useState` here." onOpenFile={() => undefined} />);

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('useState').tagName).toBe('CODE');
  });
});
