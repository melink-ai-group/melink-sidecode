import { useLayoutEffect, useRef, type RefObject } from 'react';

export const POPUP_PREFERRED_WIDTH = 440;

/**
 * Place a composer popup on the side of its trigger that has room.
 * A trigger near the right edge opens the card to the left.
 */
export function usePopupSide(open: boolean): { ref: RefObject<HTMLDivElement>; className: string } {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const root = ref.current;
    if (!root) {
      return;
    }
    const place = (): void => {
      const anchor = root.getBoundingClientRect();
      const margin = 8;
      const spaceRight = window.innerWidth - anchor.left - margin;
      const spaceLeft = anchor.right - margin;
      const alignEnd = spaceRight < POPUP_PREFERRED_WIDTH && spaceLeft > spaceRight;
      const available = Math.max(160, alignEnd ? spaceLeft : spaceRight);
      root.style.setProperty('--popup-left', alignEnd ? 'auto' : '0');
      root.style.setProperty('--popup-right', alignEnd ? '0' : 'auto');
      root.style.setProperty('--popup-max', `${available}px`);
    };
    place();
    const frame = requestAnimationFrame(place);
    const observer = new ResizeObserver(place);
    observer.observe(document.documentElement);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [open]);
  return { ref, className: 'mode-menu' };
}
