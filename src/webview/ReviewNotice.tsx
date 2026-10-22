import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Portal keeps review tooltips outside the scrolling file panel. */
export function ReviewNotice({ label, message, tone, children }: {
  label: string;
  message: string;
  tone?: string;
  children: ReactNode;
}): JSX.Element {
  const id = useId();
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelHide = (): void => clearTimeout(hideTimer.current);
  const hideSoon = (): void => {
    cancelHide();
    hideTimer.current = setTimeout(() => setAnchor(undefined), 150);
  };
  const [anchor, setAnchor] = useState<{ left: number; top?: number; bottom?: number }>();
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  useEffect(() => {
    if (!anchor) return;
    const close = (event: Event): void => {
      if (event.target instanceof Element && event.target.closest('.review-notice__tooltip')) return;
      setAnchor(undefined);
    };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [anchor]);
  return (
    <span className="review-notice" onMouseLeave={hideSoon}>
      <button
        type="button"
        className={`btn changes-review__icon-btn changes-review__notice changes-review__diff-review--${tone ?? 'info'}`}
        aria-label={label}
        aria-describedby={anchor ? id : undefined}
        onMouseEnter={(event) => show(event.currentTarget)}
        onFocus={(event) => show(event.currentTarget)}
        onBlur={() => setAnchor(undefined)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setAnchor(undefined);
        }}
      >
        {children}
      </button>
      {anchor ? createPortal(
        <span id={id} role="tooltip" className="review-notice__tooltip" style={anchor}
          onMouseEnter={cancelHide} onMouseLeave={hideSoon}>
          {message}
        </span>, document.body
      ) : null}
    </span>
  );

  function show(target: HTMLElement): void {
    cancelHide();
    const rect = target.getBoundingClientRect();
    setAnchor({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)),
      ...(rect.bottom > window.innerHeight / 2
        ? { bottom: window.innerHeight - rect.top + 6 }
        : { top: rect.bottom + 6 })
    });
  }
}
