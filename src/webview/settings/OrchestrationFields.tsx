import type { JSX } from 'react';
import {
  ORCHESTRATION_CHOICES,
  isOrchestrationChoice,
  type OrchestrationChoice,
  type OrchestrationChoices
} from '../../orchestration/settings.ts';
import {
  AUTO_EXPLANATION,
  ORCHESTRATION_FIELDS,
  ORCHESTRATION_INTRO,
  choiceLabel,
  orchestrationFieldHelp,
  orchestrationSummary,
  type OrchestrationFieldKey
} from './orchestrationCopy';

/**
 * The Orchestration tab's field group.
 *
 * The settings screen owns the draft and passes the effective choices down, so
 * this component stays presentational: it renders the summary and one tri-state
 * control per role and reports every change through `onChange`.
 */
export type OrchestrationFieldValues = OrchestrationChoices;

export interface OrchestrationFieldsProps {
  values: OrchestrationFieldValues;
  legacyTesting: boolean;
  legacyReviewing: boolean;
  onChange: (key: OrchestrationFieldKey, value: OrchestrationChoice) => void;
}

export function OrchestrationFields({
  values,
  legacyTesting,
  legacyReviewing,
  onChange
}: OrchestrationFieldsProps): JSX.Element {
  const copy = { ...values, legacyTesting, legacyReviewing };
  return (
    <div className="field">
      <p className="field-help">{ORCHESTRATION_INTRO}</p>
      <p className="chip orchestration-summary" role="status">
        {orchestrationSummary(copy)}
      </p>
      <p className="field-help orchestration-auto-help">{AUTO_EXPLANATION}</p>
      {ORCHESTRATION_FIELDS.map((field) => {
        const helpId = `orchestration-${field.key}-help`;
        return (
          <div className="orchestration-row" key={field.key}>
            <div className="check-body">
              <label className="check-label" htmlFor={`orchestration-${field.key}`}>
                {field.label}
              </label>
              <span className="check-text" id={helpId}>
                {orchestrationFieldHelp(field.key, copy)}
              </span>
            </div>
            <select
              className="select orchestration-choice"
              id={`orchestration-${field.key}`}
              value={values[field.key]}
              aria-describedby={helpId}
              onChange={(event) => {
                const choice = event.target.value;
                if (isOrchestrationChoice(choice)) {
                  onChange(field.key, choice);
                }
              }}
            >
              {ORCHESTRATION_CHOICES.map((choice) => (
                <option value={choice} key={choice}>
                  {choiceLabel(choice)}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}
