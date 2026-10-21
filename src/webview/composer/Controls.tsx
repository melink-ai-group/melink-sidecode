import { useEffect, useRef, type JSX } from 'react';
import type { DefaultMode, PermissionLevel } from '../../backends/types';
import type { ModeSnapshot, PermissionOption } from '../../protocol';
import { AlertIcon, CheckIcon, ChevronDownIcon, ShieldIcon } from '../Icons';

/**
 * The compact permission trigger that sits with the model and mode in the
 * composer. The button is the shield icon; the current level is its tooltip.
 * The options open in a floating panel above the composer.
 */
export function PermissionTrigger({
  options,
  selected,
  open,
  disabled,
  onToggle
}: {
  options: PermissionOption[];
  selected: PermissionLevel;
  open: boolean;
  disabled: boolean;
  onToggle: () => void;
}): JSX.Element {
  const current = options.find((option) => option.level === selected) ?? options[0];
  return (
    <button
      className="control-trigger control-trigger--permission"
      type="button"
      data-level={current?.level}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls="permission-panel"
      aria-label={`Permission level: ${current?.label ?? selected}`}
      title={current?.label ?? selected}
      disabled={disabled}
      onClick={onToggle}
    >
      <ShieldIcon className="ico ico--sm" />
    </button>
  );
}

/**
 * The permission level panel, listing each level with one plain sentence.
 * `unrestricted` is visually distinct and its row only opens the labelled
 * confirmation, so it can never be applied directly.
 */
export function PermissionPanel({
  options,
  selected,
  onSelect,
  onOpenRules,
  onClose
}: {
  options: PermissionOption[];
  selected: PermissionLevel;
  onSelect: (option: PermissionOption) => void;
  onOpenRules: () => void;
  onClose: () => void;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.querySelector<HTMLButtonElement>('.control-option')?.focus();
  }, []);
  return (
    <div
      className="control-panel"
      id="permission-panel"
      ref={panelRef}
      role="listbox"
      aria-label="Permission level"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="control-panel__head">
        <span>Permission level</span>
        <span className="spacer" />
        <span className="control-panel__note">Applies to this conversation</span>
      </div>
      {options.map((option) => (
        <button
          className={`control-option${option.requiresConfirmation ? ' control-option--danger' : ''}`}
          type="button"
          role="option"
          aria-selected={option.level === selected}
          key={option.level}
          onClick={() => onSelect(option)}
        >
          <span className="control-option__body">
            <span className="control-option__name">
              {option.requiresConfirmation ? (
                <AlertIcon className="ico ico--xs control-option__warn" />
              ) : null}
              {option.label}
              {option.requiresConfirmation ? <span className="chip chip--scope">Needs confirmation</span> : null}
            </span>
            <span className="control-option__desc">{option.description}</span>
          </span>
          {option.level === selected ? <CheckIcon className="control-check" /> : null}
        </button>
      ))}
      <div className="control-panel__foot">
        <button className="btn btn--link" type="button" onClick={onOpenRules}>
          Review and remove always-allow rules
        </button>
      </div>
    </div>
  );
}

/** Compact mode trigger. The menu opens upward from this button. */
export function ModeTrigger({
  snapshot,
  open,
  disabled,
  onToggle
}: {
  snapshot: ModeSnapshot;
  open: boolean;
  disabled: boolean;
  onToggle: () => void;
}): JSX.Element {
  const current = snapshot.options.find((option) => option.mode === snapshot.selected) ?? snapshot.options[0];
  const mode = current?.mode ?? snapshot.selected;
  return (
    <button
      className={`control-trigger control-trigger--mode control-trigger--${mode}`}
      type="button"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls="mode-menu"
      aria-label={`Mode: ${current?.label ?? snapshot.selected}`}
      disabled={disabled}
      onClick={onToggle}
    >
      <span className="control-label">{current?.label ?? snapshot.selected}</span>
      <ChevronDownIcon className="control-chevron" />
    </button>
  );
}

/** Short mode list anchored above the trigger. Names only, colored by mode. */
export function ModeMenu({
  snapshot,
  disabled,
  onSelect,
  onClose
}: {
  snapshot: ModeSnapshot;
  disabled: boolean;
  onSelect: (mode: DefaultMode) => void;
  onClose: () => void;
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('.mode-menu__option')?.focus();
  }, []);
  return (
    <div
      className="mode-menu__list"
      id="mode-menu"
      ref={menuRef}
      role="listbox"
      aria-label="Mode"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {snapshot.options.map((option) => (
        <button
          className={`mode-menu__option mode-menu__option--${option.mode}`}
          type="button"
          role="option"
          aria-selected={option.mode === snapshot.selected}
          disabled={disabled}
          key={option.mode}
          onClick={() => onSelect(option.mode)}
        >
          <span>{option.label}</span>
          {option.mode === snapshot.selected ? <CheckIcon className="control-check" /> : null}
        </button>
      ))}
    </div>
  );
}
