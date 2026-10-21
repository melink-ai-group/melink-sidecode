import type { Dispatch, JSX } from 'react';
import logoUrl from '../../../media/melink-logo.png';
import { SparkIcon } from '../Icons';
import { authMismatchBackends, incompatibleBackends } from '../backendStatus';
import { bridge } from '../hostBridge';
import { runTokenAction } from '../notices';
import type { Action, AppState } from '../state';

export function EmptyState({
  state,
  dispatch,
  hasAvailable
}: {
  state: AppState;
  dispatch: Dispatch<Action>;
  hasAvailable: boolean;
}): JSX.Element {
  const needsToken = state.availability.find((backend) => backend.status === 'unauthenticated');
  const incompatible = incompatibleBackends(state.availability)[0];
  const authMismatch = authMismatchBackends(state.availability)[0];
  const unavailable = state.availability.filter((backend) => backend.status === 'unavailable');

  if (!hasAvailable) {
    // The most specific failure headlines: a protocol mismatch is diagnosable
    // and must not be masked by a generic "no backend is ready". The same is
    // true of an API-key-vs-ChatGPT mismatch. A missing binary is never
    // mentioned, so an Ollama-only sidebar stays quiet.
    const headline = incompatible
      ? 'Codex protocol mismatch'
      : authMismatch
        ? 'Codex is signed in with the wrong method'
        : 'No backend is ready';
    const message = incompatible
      ? incompatible.detail
      : authMismatch
        ? authMismatch.detail
        : needsToken
          ? `${needsToken.label} needs a token before you can chat.`
          : 'Set an Ollama Cloud token, or install the Codex CLI and sign in.';
    return (
      <div className="empty-state">
        <span className="empty-icon" aria-hidden="true">
          <SparkIcon />
        </span>
        <p className="empty-title">{headline}</p>
        <p className="empty-text">{message}</p>
        {incompatible ? (
          <div className="banner-actions">
            {incompatible.version ? (
              <span className="status-chip status-chip--warning">v{incompatible.version}</span>
            ) : null}
            <button className="btn" type="button" onClick={() => bridge.post({ type: 'showAppSettings', section: 'codex' })}>
              Open settings
            </button>
            <button className="btn" type="button" onClick={() => bridge.post({ type: 'refresh' })}>
              Retry
            </button>
          </div>
        ) : authMismatch ? (
          <div className="banner-actions">
            {authMismatch.authMode ? (
              <span className="status-chip status-chip--warning">{authMismatch.authMode}</span>
            ) : null}
            <button className="btn" type="button" onClick={() => bridge.post({ type: 'openSettings' })}>
              Open settings
            </button>
            <button className="btn" type="button" onClick={() => bridge.post({ type: 'refresh' })}>
              Retry
            </button>
          </div>
        ) : needsToken ? (
          <div className="banner-actions">
            <button className="btn btn--primary" type="button" onClick={() => runTokenAction(dispatch, state)}>
              Set token
            </button>
            <button className="btn" type="button" onClick={() => bridge.post({ type: 'refresh' })}>
              Retry
            </button>
          </div>
        ) : unavailable.length > 0 ? (
          <div className="banner-actions">
            <button className="btn" type="button" onClick={() => bridge.post({ type: 'refresh' })}>
              Retry
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="empty-state empty-state--welcome">
      <img className="empty-logo" src={logoUrl} alt="" />
      <p className="empty-title empty-title--brand">meLink SideCode</p>
      <p className="empty-text">
        On your side. Plan, Edit, or Ask anything.
      </p>
      <p className="empty-slogan">You've got this</p>
    </div>
  );
}

