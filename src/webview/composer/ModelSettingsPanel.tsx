import { useEffect, useRef, type JSX } from 'react';
import type { ModelSettingField } from '../../protocol';
import {
  MODEL_SETTING_LABELS,
  dropsEarlierTurns,
  formatContextTokens,
  formatExactTokens,
  type ContextControl,
  type ModelSettingsView,
  type ThinkingControl
} from '../modelControls';
import { AlertIcon, CrossIcon, InfoIcon, RefreshIcon, SlidersIcon } from '../Icons';
import type { AppState } from '../state';

/**
 * The floating per-model settings panel above the composer. It renders the host-resolved
 * capability snapshot for the selected model and posts each change back to the
 * host, which clamps and persists it. Nothing here mutates the transcript.
 */
export function ModelSettingsPanel({
  view,
  modelId,
  status,
  error,
  conversationTokens,
  onContextChange,
  onThinkingChange,
  onResetField,
  onResetAll,
  onRetry,
  onClose
}: {
  view?: ModelSettingsView;
  modelId: string;
  status: AppState['modelCapabilityStatus'];
  error?: string;
  conversationTokens: number;
  onContextChange: (value: number) => void;
  onThinkingChange: (value: string) => void;
  onResetField: (field: ModelSettingField) => void;
  onResetAll: () => void;
  onRetry: () => void;
  onClose: () => void;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, []);

  const ready = status === 'ready' && view !== undefined;
  return (
    <div
      className="control-panel model-settings-panel"
      id="model-settings-panel"
      ref={panelRef}
      role="dialog"
      aria-label="Model settings"
      aria-busy={status === 'loading'}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="control-panel__head">
        <SlidersIcon className="ico ico--sm" />
        <span>Model settings</span>
        {view?.isOverridden ? <span className="chip chip--scope">Modified</span> : null}
        <span className="spacer" />
        <span className="control-panel__note">{modelId}</span>
        <button className="icon-btn" type="button" aria-label="Close model settings" onClick={onClose}>
          <CrossIcon />
        </button>
      </div>

      {status === 'error' || status === 'loading' || (ready && view) ? (
        <div className="model-settings-panel__body">
          {status === 'error' ? (
            <div className="model-settings-error" role="alert">
              <AlertIcon className="ico ico--xs" />
              <div className="model-settings-error__body">
                <p className="model-settings-error__title">Could not load this model's limits</p>
                <p className="model-settings-error__text">
                  {error ?? 'The capability read did not complete, so no value is shown.'}
                </p>
                <button className="btn" type="button" onClick={onRetry}>
                  <RefreshIcon />
                  Retry
                </button>
              </div>
            </div>
          ) : null}

          {status === 'loading' ? (
            <div className="model-settings-loading" role="status" aria-live="polite">
              <span>Reading this model's limits…</span>
              <span className="skeleton-bar model-settings-loading__bar" aria-hidden="true" />
            </div>
          ) : null}

          {ready && view ? (
            <>
              <ContextField
                control={view.context}
                conversationTokens={conversationTokens}
                onChange={onContextChange}
                onReset={() => onResetField('contextWindow')}
              />
              <ThinkingField
                control={view.thinking}
                onChange={onThinkingChange}
                onReset={() => onResetField('thinking')}
              />
            </>
          ) : null}
        </div>
      ) : null}

      <div className="control-panel__foot model-settings-foot">
        <button className="btn btn--link" type="button" disabled={!view?.isOverridden} onClick={onResetAll}>
          Reset all to defaults
        </button>
        <span className="spacer" />
        <span className="model-settings-apply">Changes apply to the next turn</span>
      </div>
    </div>
  );
}

/** The bounded max-context control: a stepped slider with a readable readout. */
export function ContextField({
  control,
  conversationTokens,
  onChange,
  onReset
}: {
  control: ContextControl;
  conversationTokens: number;
  onChange: (value: number) => void;
  onReset: () => void;
}): JSX.Element {
  if (!control.available || control.value === undefined || control.ceiling === undefined) {
    return (
      <div className="model-settings-field">
        <div className="model-settings-field__head">
          <span className="model-settings-field__label">{MODEL_SETTING_LABELS.contextWindow}</span>
        </div>
        <p className="model-settings-unavailable">
          <InfoIcon className="ico ico--xs" />
          <span>{control.unavailableReason}</span>
        </p>
      </div>
    );
  }

  const { floor, ceiling, step, value, defaultValue, reportedMin } = control;
  const percent = ceiling > floor ? ((value - floor) / (ceiling - floor)) * 100 : 0;
  const defaultPercent =
    defaultValue !== undefined && ceiling > floor
      ? ((defaultValue - floor) / (ceiling - floor)) * 100
      : undefined;
  const drops = dropsEarlierTurns(value, conversationTokens);

  return (
    <div className="model-settings-field">
      <div className="model-settings-field__head">
        <label className="model-settings-field__label" htmlFor="model-context-range">
          {MODEL_SETTING_LABELS.contextWindow}
        </label>
        <span className="spacer" />
        <span className="model-settings-readout">
          <strong>{formatContextTokens(value)}</strong>{' '}
          <span className="model-settings-exact">{formatExactTokens(value)} tokens</span>
        </span>
      </div>

      <div className="model-settings-range-wrap">
        <input
          className="model-settings-range"
          id="model-context-range"
          type="range"
          data-autofocus
          min={floor}
          max={ceiling}
          step={step}
          value={value}
          aria-valuetext={`${formatContextTokens(value)}, ${formatExactTokens(value)} tokens`}
          aria-describedby="model-context-hint"
          onChange={(event) => onChange(Number(event.target.value))}
        />
        {defaultPercent !== undefined ? (
          <span
            className="model-settings-range__tick"
            style={{ ['--at' as string]: String(defaultPercent / 100) }}
            title={`Model default ${formatContextTokens(defaultValue ?? value)}`}
            aria-hidden="true"
          />
        ) : null}
      </div>
      <div className="model-settings-scale">
        <span>{formatContextTokens(floor)}</span>
        {percent > 0 && percent < 100 ? <span>{formatContextTokens(value)}</span> : null}
        <span>{formatContextTokens(ceiling)}</span>
      </div>

      <div className="model-settings-sub">
        <span>
          {defaultValue !== undefined
            ? `Default ${formatContextTokens(defaultValue)} · `
            : 'No reported default · '}
          range {formatContextTokens(floor)} to {formatContextTokens(ceiling)}
          {reportedMin === undefined ? ' (minimum not reported)' : ''}
        </span>
        <span className="spacer" />
        <button className="btn btn--link" type="button" disabled={!control.overridden} onClick={onReset}>
          Reset to default
        </button>
      </div>

      <p className={drops ? 'model-settings-warning' : 'model-settings-hint'} id="model-context-hint">
        {drops ? (
          <>
            <AlertIcon className="ico ico--xs" />
            <span>
              Below the ~{formatExactTokens(conversationTokens)} tokens already in this conversation. Earlier
              turns will be dropped from the next request.
            </span>
          </>
        ) : (
          <span>
            {conversationTokens > 0
              ? `The conversation uses about ${formatExactTokens(conversationTokens)} tokens.`
              : 'Applies to the whole conversation sent on the next turn.'}
          </span>
        )}
      </p>
    </div>
  );
}

/** The thinking selector: only the model's supported levels are offered. */
export function ThinkingField({
  control,
  onChange,
  onReset
}: {
  control: ThinkingControl;
  onChange: (value: string) => void;
  onReset: () => void;
}): JSX.Element {
  if (!control.available || control.value === undefined) {
    return (
      <div className="model-settings-field">
        <div className="model-settings-field__head">
          <span className="model-settings-field__label">{MODEL_SETTING_LABELS.thinking}</span>
        </div>
        <p className="model-settings-unavailable">
          <InfoIcon className="ico ico--xs" />
          <span>{control.unavailableReason}</span>
        </p>
      </div>
    );
  }

  return (
    <div className="model-settings-field">
      <div className="model-settings-field__head">
        <span className="model-settings-field__label" id="model-thinking-label">
          {MODEL_SETTING_LABELS.thinking}
        </span>
      </div>
      <div
        className="model-settings-segmented"
        role="radiogroup"
        aria-labelledby="model-thinking-label"
        style={{ ['--segments' as string]: String(control.offered.length) }}
      >
        {control.offered.map((level) => (
          <button
            className="model-settings-segment"
            type="button"
            role="radio"
            aria-checked={level === control.value}
            key={level}
            onClick={() => onChange(level)}
          >
            {level}
          </button>
        ))}
      </div>
      <div className="model-settings-sub">
        <span>
          {control.defaultValue !== undefined
            ? `Default ${control.defaultValue} · `
            : 'No reported default · '}
          supports {control.offered.join(', ')}
        </span>
        <span className="spacer" />
        <button className="btn btn--link" type="button" disabled={!control.overridden} onClick={onReset}>
          Reset to default
        </button>
      </div>
    </div>
  );
}
