import { useEffect, useRef, useState } from 'react';
import { QuickSendIcon, SendSolidIcon } from '../Icons';

/** A second activation within 600 ms opts this request out of orchestration. */
export function SendButton({ className, disabled, allowQuick, resetKey, onSend }: {
  className: string;
  disabled: boolean;
  allowQuick: boolean;
  resetKey: string;
  onSend: (quick: boolean) => void;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clear = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };

  useEffect(() => {
    clear();
    setArmed(false);
    return clear;
  }, [resetKey, disabled, allowQuick]);

  const activate = () => {
    if (timer.current !== undefined) {
      clear();
      setArmed(false);
      onSend(true);
    } else if (allowQuick) {
      setArmed(true);
      timer.current = setTimeout(() => {
        timer.current = undefined;
        setArmed(false);
        onSend(false);
      }, 600);
    } else {
      onSend(false);
    }
  };

  return (
    <button
      className={className}
      type="button"
      aria-label={armed ? 'Send quick request' : 'Send'}
      title={armed ? 'Click again to skip orchestration' : allowQuick ? 'Send (click twice for a quick request)' : 'Send'}
      disabled={disabled}
      onClick={activate}
    >
      {armed ? <QuickSendIcon /> : <SendSolidIcon />}
    </button>
  );
}
