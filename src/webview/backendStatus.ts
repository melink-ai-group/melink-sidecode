import type { BackendAvailability } from '../backends/types';

/**
 * The provider status as a surface renders it, kept pure so the mapping from the
 * four-state availability to a tone/label/action is unit-testable and shared by
 * the empty state, the model panel, and the settings screen.
 *
 * `unavailable` is deliberately `actionable: false` and has no distinct visual
 * error: a missing binary is data that keeps Codex out of an Ollama-only
 * sidebar, not a broken-looking provider. `incompatible` is the opposite: it is
 * surfaced precisely so a protocol-version drift is diagnosable, carrying the
 * server-reported version. `auth-mismatch` is likewise surfaced: the CLI has a
 * usable credential, but it is an API key where the ChatGPT login was expected.
 */
export type BackendStatusTone = 'available' | 'unauthenticated' | 'incompatible' | 'auth-mismatch' | 'unavailable';

export interface BackendStatusView {
  tone: BackendStatusTone;
  /** Short label, e.g. for a chip beside the provider name. */
  label: string;
  /** Plain-language sentence; never a raw protocol id or a stack. */
  detail: string;
  /** The server-reported version, present only for `incompatible` when known. */
  version?: string;
  /** The provider-reported auth mode, present when the provider named one. */
  authMode?: string;
  /** True when the user can act on the state (sign in, update the CLI). */
  actionable: boolean;
}

/** Project one provider's availability into the shared view. */
export function backendStatusView(
  backend: Pick<BackendAvailability, 'status' | 'detail' | 'version' | 'authMode'>
): BackendStatusView {
  switch (backend.status) {
    case 'available':
      return { tone: 'available', label: 'Ready', detail: 'Usable now.', actionable: false };
    case 'unauthenticated':
      return {
        tone: 'unauthenticated',
        label: 'Signed out',
        detail: backend.detail ?? 'No usable credential.',
        actionable: true
      };
    case 'incompatible':
      return {
        tone: 'incompatible',
        label: 'Protocol mismatch',
        detail: backend.detail ?? 'The CLI is installed but its protocol version is not supported.',
        ...(backend.version ? { version: backend.version } : {}),
        actionable: true
      };
    case 'auth-mismatch':
      // A usable credential of the wrong kind: the mismatch is named rather than
      // reported as a healthy ready state or a plain sign-out.
      return {
        tone: 'auth-mismatch',
        label: 'Wrong sign-in',
        detail:
          backend.detail ??
          'Codex is signed in with an API key, not the ChatGPT login. Sign in with the ChatGPT option.',
        ...(backend.authMode ? { authMode: backend.authMode } : {}),
        actionable: true
      };
    case 'unavailable':
    default:
      return {
        tone: 'unavailable',
        label: 'Not installed',
        detail: backend.detail ?? 'Not installed or not on PATH.',
        actionable: false
      };
  }
}

/**
 * The providers a Codex-incompatibility notice should name. Empty unless at
 * least one provider reported `incompatible`, so the notice only renders when
 * there is something specific to say and a missing binary never triggers it.
 */
export function incompatibleBackends(availability: readonly BackendAvailability[]): BackendAvailability[] {
  return availability.filter((backend) => backend.status === 'incompatible');
}

/**
 * The providers an auth-mismatch notice should name. Empty unless at least one
 * provider reported the wrong kind of credential, so the notice only renders
 * when there is something specific to say.
 */
export function authMismatchBackends(availability: readonly BackendAvailability[]): BackendAvailability[] {
  return availability.filter((backend) => backend.status === 'auth-mismatch');
}
