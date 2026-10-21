import type { JSX } from 'react';
import { AlertIcon, CheckIcon, InfoIcon } from '../Icons';
import { FieldTip } from './primitives';
import {
  chipClass,
  type SkillChipState
} from './skillState';

/**
 * One Skills panel, shared by ast-grep and zvec-grep.
 *
 * The enable toggle sits directly under the heading so it is never below the
 * fold on a 390 px sidebar. Source, path, connection and actions are one
 * grouped block below it. zvec-grep adds the explicit Build index action; no
 * action here writes the workspace except that one.
 */

export interface SkillPanelProps {
  id: 'ast-grep' | 'zvec-grep';
  title: string;
  about: string;
  oneLineHelp: string;
  checked: boolean;
  toggleLabel: string;
  toggleTip: string;
  togglePending: boolean;
  onToggle: (value: boolean) => void;
  chip: SkillChipState;
  statusText: string;
  detail?: string;
  cliSource: 'local' | 'bundled';
  onCliSource: (value: 'local' | 'bundled') => void;
  sourceHelp: string;
  sourceNotice?: string;
  pathLabel: string;
  pathValue: string;
  onPath: (value: string) => void;
  pathError?: string;
  pathNotice?: string;
  bundledPath?: string;
  probeStatus: 'detected' | 'missing' | 'not-runnable';
  probeVersion?: string;
  installLabel: string;
  installPending: boolean;
  onInstall: () => void;
  installResult?: { ok?: boolean; message?: string };
  testPending: boolean;
  testResult?: { ok?: boolean; message?: string };
  onTest: () => void;
  indexState?: 'ready' | 'missing' | 'building' | 'unknown';
  indexPending?: boolean;
  onBuildIndex?: () => void;
  indexResult?: { ok?: boolean; message?: string };
}

export function SkillPanel(props: SkillPanelProps): JSX.Element {
  const id = props.id;
  const busy = props.togglePending || props.installPending || props.testPending || Boolean(props.indexPending);
  return (
    <div className="field skill-panel" data-skill={id}>
      <div className="field__head skill-head">
        <span className="provider-name">{props.title}</span>
        <span className="spacer" />
        <span className={chipClass(props.chip.tone)} data-skill-chip={id}>
          {props.chip.label}
        </span>
        <FieldTip label={`About ${props.title}`} text={props.about} />
      </div>
      <p className="field-help skill-one-line">{props.oneLineHelp}</p>

      <div className="skill-enable" aria-busy={props.togglePending ? true : undefined}>
        <label className="check" htmlFor={`${id}-enabled`}>
          <input
            className="check-input"
            id={`${id}-enabled`}
            type="checkbox"
            checked={props.checked}
            disabled={props.togglePending}
            aria-describedby={`${id}-status`}
            onChange={(event) => props.onToggle(event.target.checked)}
          />
          <span className="check-box" aria-hidden="true">
            <CheckIcon />
          </span>
          <span className="check-body">
            <span className="check-label">{props.toggleLabel}</span>
          </span>
        </label>
        <FieldTip label={`About ${props.toggleLabel}`} text={props.toggleTip} />
      </div>
      <p className="field-help skill-status-line" id={`${id}-status`}>
        {props.statusText}
      </p>
      {props.detail && props.chip.tone === 'error' ? (
        <p className="field-msg field-msg--error" role="alert">
          <AlertIcon />
          <span>{props.detail}</span>
        </p>
      ) : null}

      <div className="skill-controls">
        <label className="field-label" htmlFor={`${id}-cli-source`}>
          CLI source
        </label>
        <select
          className="select"
          id={`${id}-cli-source`}
          value={props.cliSource}
          aria-describedby={`${id}-cli-source-help`}
          onChange={(event) =>
            props.onCliSource(event.target.value === 'bundled' ? 'bundled' : 'local')
          }
        >
          <option value="local">Local machine</option>
          <option value="bundled">Bundled (extension storage)</option>
        </select>
        <p className="field-help" id={`${id}-cli-source-help`}>
          {props.sourceHelp}
        </p>
        <ScopeNotice id={`${id}-cli-source-notice`} notice={props.sourceNotice} />

        {props.cliSource === 'local' ? (
          <>
            <label className="field-label" htmlFor={`${id}-path`}>
              {props.pathLabel}
            </label>
            <input
              className="input"
              id={`${id}-path`}
              type="text"
              value={props.pathValue}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={props.pathError ? true : undefined}
              aria-describedby={props.pathError ? `${id}-path-error` : undefined}
              onChange={(event) => props.onPath(event.target.value)}
            />
            {props.pathError ? (
              <p className="field-msg field-msg--error" id={`${id}-path-error`} role="alert">
                <AlertIcon />
                <span>{props.pathError}</span>
              </p>
            ) : (
              <ScopeNotice id={`${id}-path-notice`} notice={props.pathNotice} />
            )}
          </>
        ) : (
          <p className="field-help skill-path" title={props.bundledPath}>
            Bundled path
            <FieldTip label={`Bundled ${props.title} path`} text={props.bundledPath ?? ''} />
          </p>
        )}

        <p
          className={`runtime-status runtime-status--${
            props.probeStatus === 'detected'
              ? 'detected'
              : props.probeStatus === 'not-runnable'
                ? 'not-runnable'
                : 'missing'
          }`}
          role="status"
        >
          <span className="runtime-dot" aria-hidden="true" />
          <span>
            {props.probeStatus === 'detected'
              ? 'Detected'
              : props.probeStatus === 'not-runnable'
                ? 'Installed but not runnable'
                : 'Not installed'}
          </span>
          {props.probeStatus === 'detected' && props.probeVersion ? (
            <span className="runtime-version">{props.probeVersion}</span>
          ) : null}
        </p>

        <div className="skill-actions" role="group" aria-label={`${props.title} actions`}>
          <button
            className="btn btn--secondary"
            type="button"
            disabled={busy}
            aria-busy={props.installPending ? true : undefined}
            onClick={props.onInstall}
          >
            {props.installPending ? 'Working...' : props.installLabel}
          </button>
          <button
            className="btn btn--secondary"
            type="button"
            disabled={busy}
            aria-busy={props.testPending ? true : undefined}
            onClick={props.onTest}
          >
            {props.testPending ? 'Testing...' : 'Test'}
          </button>
          {props.onBuildIndex ? (
            <button
              className="btn btn--secondary"
              type="button"
              disabled={busy}
              aria-busy={props.indexPending ? true : undefined}
              onClick={props.onBuildIndex}
            >
              {props.indexPending ? 'Building index...' : 'Build index'}
            </button>
          ) : null}
        </div>
        <ActionResult result={props.installResult} />
        <ActionResult result={props.testResult} />
        <ActionResult result={props.indexResult} />

        {props.indexState === 'missing' ? (
          <p className="field-help skill-index-hint" role="status">
            zvec-grep needs a workspace index. Build index reads this workspace and writes
            `.zvec-grep/` once; until then searches return INDEX_MISSING.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ActionResult({
  result
}: {
  result?: { ok?: boolean; message?: string };
}): JSX.Element | null {
  if (!result?.message) {
    return null;
  }
  return (
    <p
      className={`runtime-result ${result.ok ? 'runtime-result--ok' : 'runtime-result--error'}`}
      role={result.ok ? 'status' : 'alert'}
    >
      {result.ok ? <CheckIcon /> : <AlertIcon />}
      <span>{result.message}</span>
    </p>
  );
}

function ScopeNotice({ id, notice }: { id: string; notice?: string }): JSX.Element | null {
  if (!notice) {
    return null;
  }
  return (
    <p className="field-msg field-msg--notice" id={id} role="status">
      <InfoIcon />
      <span>{notice}</span>
    </p>
  );
}
