import type { JSX } from 'react';
import { useHostActivity } from '../hostActivity';

/** Small corner spinner. It subscribes on its own so a click does not repaint the chat. */
export function BusyCorner({ busy, overlay = false }: { busy: boolean; overlay?: boolean }): JSX.Element {
  const hostBusy = useHostActivity();
  const active = busy || hostBusy;
  return (
    <div className={overlay ? 'busy-corner-slot busy-corner-slot--overlay' : 'busy-corner-slot'}>
      {active ? (
        <div className="busy-corner" role="status" aria-label="Working">
          <span className="spinner" aria-hidden="true" />
        </div>
      ) : null}
    </div>
  );
}
