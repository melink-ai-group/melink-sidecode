import type { JSX } from 'react';
import type { ConnectionTestResult } from '../../protocol';
import { AlertIcon, CheckIcon, CrossIcon, InfoIcon } from '../Icons';
import { summarizeOpencodeCliOutput } from '../../backends/opencode/upgradeText';
import { outcomeLabel } from './labels';

/**
 * One context category row: a checkbox, a name, and a plain-language sentence
 * about what the category means in practice. Kept as one component so all five
 * rows share the same structure and focus behaviour.
 */
export function ContextCategory({
  id,
  name,
  description,
  checked,
  onChange
}: {
  id?: string;
  name: string;
  description: string;
  checked: boolean;
  /** Absent for a category whose control lives in its own region below. */
  onChange?: (value: boolean) => void;
}): JSX.Element {
  // A read-only row states what is sent without offering a second control for a
  // setting that already has one: two checkboxes for one flag could desync.
  if (!onChange || !id) {
    return (
      <li className="context-category context-category--static">
        <span className={`context-mark ${checked ? 'context-mark--on' : 'context-mark--off'}`} aria-hidden="true">
          {checked ? <CheckIcon /> : <CrossIcon />}
        </span>
        <span className="check-body">
          <span className="check-label">{name}</span>
          <span className="check-text">{description}</span>
        </span>
      </li>
    );
  }
  return (
    <li className="context-category">
      <label className="check" htmlFor={id}>
        <input
          className="check-input"
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="check-box" aria-hidden="true">
          <CheckIcon />
        </span>
        <span className="check-body">
          <span className="check-label">{name}</span>
          <span className="check-text">{description}</span>
        </span>
      </label>
    </li>
  );
}

/** Compact info control: secondary detail lives in the native tooltip. */
export function FieldTip({ label, text }: { label: string; text: string }): JSX.Element {
  return (
    <button type="button" className="icon-btn field-tip" title={text} aria-label={label}>
      <InfoIcon />
    </button>
  );
}

/** One plain sentence for an install or update. Terminal color and progress bars are stripped. */
export function CliResult({ ok, message }: { ok?: boolean; message: string }): JSX.Element {
  const text = summarizeOpencodeCliOutput(message, ok === false ? 1 : 0);
  return (
    <p className={`runtime-result ${ok ? 'runtime-result--ok' : 'runtime-result--error'}`} role="status">
      {ok ? <CheckIcon /> : <AlertIcon />}
      <span>{text}</span>
    </p>
  );
}

/** The Test connection result strip; plain language, never a raw error. */
export function TestResult({
  backendLabel,
  test,
  onRetry
}: {
  backendLabel: string;
  test: { pending: boolean; result?: ConnectionTestResult };
  onRetry: () => void;
}): JSX.Element | null {
  if (test.pending) {
    return (
      <div className="test-result test-result--pending" role="status">
        <span className="spinner" aria-hidden="true" />
        <div className="test-body">
          <div className="test-title">Testing {backendLabel}</div>
          <div className="test-text">Sending a small authenticated request. This can take a few seconds.</div>
        </div>
      </div>
    );
  }
  const result = test.result;
  if (!result) {
    return null;
  }
  const ok = result.outcome === 'ok';
  return (
    <div
      className={`test-result ${ok ? 'test-result--ok' : 'test-result--error'}`}
      role={ok ? 'status' : 'alert'}
    >
      {ok ? <CheckIcon /> : <AlertIcon />}
      <div className="test-body">
        <div className="test-title">
          {ok ? `Connected to ${backendLabel}` : `Test failed - ${outcomeLabel(result.outcome)}`}
        </div>
        <div className="test-text">{result.message}</div>
        {!ok ? (
          <div className="test-actions">
            <button className="btn" type="button" onClick={onRetry}>
              Test connection
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function RefreshIconInline(): JSX.Element {
  return (
    <svg className="ico ico--xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-1.6 5" />
      <path d="M20 5v6h-6" />
    </svg>
  );
}

