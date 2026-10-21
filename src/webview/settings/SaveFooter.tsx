import { useRef, type JSX } from 'react';

/** The host's busy/success/failure state for one settings save. */
export interface SettingsSaveState {
  pending: boolean;
  ok?: boolean;
  message?: string;
}

export interface SaveFooterProps {
  dirty: boolean;
  target: 'global' | 'workspace' | 'folder';
  /**
   * The effective scope the primary action writes. The screen passes the
   * snapshot's `target`, so a workspace or folder override is saved where it
   * controls the displayed value instead of writing a user value the override
   * still hides.
   */
  save?: SettingsSaveState;
  /** Set when local validation refused part of the draft. */
  blocked?: { message: string; actionLabel?: string };
  onSave: (target: 'global' | 'workspace' | 'folder') => void;
  onReset: () => void;
  onJumpToProblem?: () => void;
}

/**
 * The settings footer: one primary action, an explicit busy state, and one
 * place for the outcome.
 *
 * The save button is disabled while the host reports `pending`, carries
 * `aria-busy`, and shows a spinner, so a slow save cannot look like a no-op and
 * a second click cannot send the same patch twice. A local validation refusal
 * and a host failure are both shown here; neither is allowed to leave the
 * footer claiming a successful save.
 */
export function SaveFooter({
  dirty,
  target,
  save,
  blocked,
  onSave,
  onReset,
  onJumpToProblem
}: SaveFooterProps): JSX.Element {
  const pending = save?.pending === true;
  const lockRef = useRef(false);

  // Two clicks in the same tick must post once. The lock is released on the
  // next microtask, so a blocked/refused attempt can be retried immediately.
  const submit = (scope: 'global' | 'workspace' | 'folder'): void => {
    if (pending || !dirty || lockRef.current) {
      return;
    }
    lockRef.current = true;
    queueMicrotask(() => {
      lockRef.current = false;
    });
    onSave(scope);
  };

  const failed = !pending && save?.ok === false;
  const saved = !pending && !dirty && save?.ok === true;
  const scoped = target !== 'global';
  const primaryLabel =
    target === 'folder'
      ? 'Save to folder settings'
      : target === 'workspace'
        ? 'Save to workspace'
        : 'Save settings';
  const note = pending
    ? 'Saving settings...'
    : blocked
      ? 'Some changes were not saved.'
      : dirty
        ? 'Changes apply to your next turn.'
        : 'No unsaved changes.';

  return (
    <footer className="settings-foot" aria-busy={pending}>
      <span className="dirty-note">
        <span className="dirty-dot" aria-hidden="true" />
        {note}
      </span>
      {blocked ? (
        <span className="save-outcome save-outcome--alert" role="alert">
          <span>{blocked.message}</span>
          {blocked.actionLabel && onJumpToProblem ? (
            <button className="link-btn" type="button" onClick={onJumpToProblem}>
              {blocked.actionLabel}
            </button>
          ) : null}
        </span>
      ) : failed ? (
        <span className="save-outcome save-outcome--alert" role="alert">
          {save?.message ?? 'Settings were not saved. Check the marked fields and try again.'}
        </span>
      ) : saved ? (
        <span className="save-outcome save-outcome--ok" role="status">
          Settings saved.
        </span>
      ) : null}
      <span className="spacer" />
      <button className="btn" type="button" disabled={!dirty || pending} onClick={onReset}>
        Reset
      </button>
      {scoped ? (
        <button
          className="btn"
          type="button"
          disabled={!dirty || pending}
          onClick={() => submit('global')}
          title="Writes the model names, toggles and context settings to your user settings. Credential hosts, CLI paths and the permission default are always user-scoped."
        >
          Save user settings
        </button>
      ) : null}
      <button
        className="btn btn--primary"
        type="button"
        disabled={!dirty || pending}
        aria-busy={pending}
        onClick={() => submit(target)}
        title={
          target === 'folder'
            ? "Saves to this workspace folder's settings, where a folder override controls the value. Credential hosts, CLI paths and the permission default are always saved to your user settings."
            : target === 'workspace'
              ? "Saves to this workspace's .vscode/settings.json, where a workspace override controls the value. Credential hosts, CLI paths and the permission default are always saved to your user settings."
              : undefined
        }
      >
        {pending ? <span className="spinner save-spinner" aria-hidden="true" /> : null}
        {pending ? 'Saving...' : primaryLabel}
      </button>
    </footer>
  );
}
