import type { JSX } from 'react';
import { CheckIcon } from '../Icons';
import {
  ORCHESTRATION_FIELDS,
  ORCHESTRATION_INTRO,
  effectiveQuickTask,
  orchestrationFieldHelp,
  orchestrationSummary,
  quickTasksAvailable,
  type OrchestrationFieldKey
} from './orchestrationCopy';

/**
 * The Orchestration tab's field group.
 *
 * The settings screen owns the draft and passes the effective values down, so
 * this component stays presentational: it renders the summary and the five
 * toggles and reports every change through `onChange`. The body is intentionally
 * small; the orchestration work owns its final copy and dependent states.
 */
export interface OrchestrationFieldValues {
  testing: boolean;
  reviewing: boolean;
  doubleCheck: boolean;
  quickTask: boolean;
  planning: boolean;
}

export interface OrchestrationFieldsProps {
  values: OrchestrationFieldValues;
  legacyTesting: boolean;
  legacyReviewing: boolean;
  onChange: (key: OrchestrationFieldKey, value: boolean) => void;
}

export function OrchestrationFields({
  values,
  legacyTesting,
  legacyReviewing,
  onChange
}: OrchestrationFieldsProps): JSX.Element {
  const copy = { ...values, legacyTesting, legacyReviewing };
  const quickAvailable = quickTasksAvailable(copy);
  const change = (key: OrchestrationFieldKey, value: boolean): void => {
    onChange(key, value);
    // Quick tasks only skip a pass. Turning off the last remaining pass also
    // turns the dependent toggle off in the draft, so a hidden `true` can never
    // be saved while the control is disabled.
    if (key !== 'quickTask' && values.quickTask) {
      const next = { ...values, [key]: value };
      if (!quickTasksAvailable(next)) {
        onChange('quickTask', false);
      }
    }
  };
  return (
    <div className="field">
      <p className="field-help">{ORCHESTRATION_INTRO}</p>
      <p className="chip orchestration-summary" role="status">
        {orchestrationSummary(copy)}
      </p>
      {ORCHESTRATION_FIELDS.map((field) => (
        <label className="check" htmlFor={`orchestration-${field.key}`} key={field.key}>
          <input
            className="check-input"
            id={`orchestration-${field.key}`}
            type="checkbox"
            checked={field.key === 'quickTask' ? effectiveQuickTask(copy) : values[field.key]}
            disabled={field.key === 'quickTask' && !quickAvailable}
            onChange={(event) => change(field.key, event.target.checked)}
          />
          <span className="check-box" aria-hidden="true">
            <CheckIcon />
          </span>
          <span className="check-body">
            <span className="check-label">{field.label}</span>
            <span className="check-text">
              {orchestrationFieldHelp(field.key, { ...values, legacyTesting, legacyReviewing })}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}
