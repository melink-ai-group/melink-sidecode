import { useRef, type JSX, type KeyboardEvent, type ReactNode } from 'react';

/**
 * A compact tab switcher for the inline panel surfaces.
 *
 * It exists so the settings screen and the model switcher can show exactly one
 * major section at a time instead of stacking every section in a container with
 * no bounded height. The tablist follows the ARIA tabs pattern: `tablist` /
 * `tab` / `tabpanel`, roving `tabIndex`, and arrow/Home/End navigation.
 *
 * Panels are always mounted and toggled with the `hidden` attribute, so an
 * inactive section keeps any unsaved input (the parent owns the draft) and no
 * section is ever stacked and visible at once.
 */

export interface TabItem {
  /** Stable id used for `aria-controls`, `aria-labelledby`, and React keys. */
  id: string;
  label: string;
  /** Optional trailing text (a count, or a short state such as "Loading"). */
  meta?: string;
}

export interface TabListProps {
  /** Accessible name for the tablist, e.g. "Settings sections". */
  label: string;
  tabs: readonly TabItem[];
  /** The id of the visible tab. */
  active: string;
  onChange: (id: string) => void;
  className?: string;
}

export function TabList({ label, tabs, active, onChange, className }: TabListProps): JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  // Arrow keys move between tabs and focus the newly selected tab, so a
  // keyboard user can switch sections without leaving the tablist.
  const move = (target: number | 'first' | 'last'): void => {
    const index = Math.max(
      0,
      tabs.findIndex((tab) => tab.id === active)
    );
    const next =
      target === 'first'
        ? 0
        : target === 'last'
          ? tabs.length - 1
          : (index + target + tabs.length) % tabs.length;
    const nextTab = tabs[next];
    if (!nextTab) {
      return;
    }
    onChange(nextTab.id);
    refs.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        event.stopPropagation();
        move(1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        event.stopPropagation();
        move(-1);
        break;
      case 'Home':
        event.preventDefault();
        event.stopPropagation();
        move('first');
        break;
      case 'End':
        event.preventDefault();
        event.stopPropagation();
        move('last');
        break;
      default:
        break;
    }
  };

  return (
    <div
      className={className ? `tablist ${className}` : 'tablist'}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === active;
        return (
          <button
            className="tab"
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            key={tab.id}
            aria-selected={selected}
            aria-controls={`tabpanel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            ref={(node) => {
              refs.current[index] = node;
            }}
            onClick={() => onChange(tab.id)}
          >
            <span className="tab__label">{tab.label}</span>
            {tab.meta ? <span className="tab__meta">{tab.meta}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  /** Must match the `TabItem.id` it belongs to. */
  id: string;
  /** The id of the visible tab; every other panel is hidden but mounted. */
  active: string;
  children: ReactNode;
  className?: string;
}

export function TabPanel({ id, active, children, className }: TabPanelProps): JSX.Element {
  return (
    <div
      className={className ? `tabpanel ${className}` : 'tabpanel'}
      role="tabpanel"
      id={`tabpanel-${id}`}
      aria-labelledby={`tab-${id}`}
      hidden={id !== active}
      tabIndex={0}
    >
      {children}
    </div>
  );
}
