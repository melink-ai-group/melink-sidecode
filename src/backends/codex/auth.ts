/**
 * Codex auth-mode interpretation, kept pure and host-free so the rules are
 * unit-testable and the wording lives in exactly one place.
 *
 * Codex's default provider reads ChatGPT OAuth credentials from
 * `$CODEX_HOME/auth.json` and reports the active credential through
 * `getAuthStatus`. A 401 against the ChatGPT Codex backend usually means a
 * credential arrived that is not the one the user logged in with, so the
 * adapter both (a) names the auth mode the CLI reports and (b) classifies a
 * failed-turn body into a distinct, non-secret status.
 *
 * Nothing here logs, echoes, or interpolates a token. The classification reads
 * provider wording only to choose a fixed sentence; the raw body (which can
 * contain an `sk-...` fragment) is never forwarded to the UI.
 */
import type { AuthMode } from '../../../schemas/AuthMode';
import type { GetAuthStatusResponse } from '../../../schemas/GetAuthStatusResponse';

/**
 * Auth modes that represent the ChatGPT OAuth login. A mode outside this set is
 * a credential the user did not choose in Codex when they believe they are on
 * ChatGPT.
 */
const CHATGPT_AUTH_MODES: ReadonlySet<AuthMode> = new Set<AuthMode>(['chatgpt', 'chatgptAuthTokens']);

/**
 * Auth modes that carry a literal API key. These are the modes that produce the
 * `Incorrect API key provided` failure the ticket targets.
 */
const API_KEY_AUTH_MODES: ReadonlySet<AuthMode> = new Set<AuthMode>(['apikey', 'bedrockApiKey']);

/** The interpreted `getAuthStatus` result. `mode` is the CLI's own vocabulary. */
export interface CodexAuthVerdict {
  /** True when the CLI reports a usable credential (or needs none). */
  authenticated: boolean;
  /** The CLI-reported auth method, or `null` when it reported none. */
  mode: AuthMode | null;
  /** True when the reported mode is an API key rather than the ChatGPT login. */
  apiKeyMode: boolean;
  /** Plain-language status detail naming the reported mode. Never a secret. */
  detail: string;
}

/** Interpret a `getAuthStatus` response into a status verdict. */
export function describeCodexAuth(status: GetAuthStatusResponse | undefined): CodexAuthVerdict {
  if (!status) {
    return {
      authenticated: false,
      mode: null,
      apiKeyMode: false,
      detail: 'The Codex CLI did not report an auth state.'
    };
  }
  const mode = status.authMethod ?? null;
  // A CLI that reports no method but does not require OpenAI auth is usable
  // (for example a locally configured non-OpenAI provider).
  const authenticated = mode !== null || status.requiresOpenaiAuth === false;
  const apiKeyMode = mode !== null && API_KEY_AUTH_MODES.has(mode);
  return { authenticated, mode, apiKeyMode, detail: authDetail(mode, authenticated) };
}

/** The plain-language sentence for one reported mode. Never a secret. */
function authDetail(mode: AuthMode | null, authenticated: boolean): string {
  if (!authenticated) {
    return 'Not signed in. Run the Codex CLI sign-in, then test again.';
  }
  if (mode === null) {
    return 'This Codex configuration does not require an OpenAI login.';
  }
  if (CHATGPT_AUTH_MODES.has(mode)) {
    return 'Signed in using ChatGPT.';
  }
  if (API_KEY_AUTH_MODES.has(mode)) {
    return 'Signed in with an API key, not the ChatGPT login.';
  }
  return `Signed in using ${mode}.`;
}

/**
 * The distinct auth failures a failed Codex turn can carry. The names match the
 * ticket's diagnosis table so a body maps to exactly one remedy.
 */
export type CodexAuthFailure = 'api-key-mismatch' | 'missing-credential' | 'refresh-failed';

/**
 * Classify a 401/failed-turn body. Returns `undefined` when the body is not one
 * of the recognized auth failures, so unrelated provider errors keep their own
 * handling. Only fixed sentences are derived; the body itself is never shown.
 */
export function classifyCodexAuthFailure(body: string | undefined): CodexAuthFailure | undefined {
  if (!body) {
    return undefined;
  }
  const value = body.toLowerCase();
  if (value.includes('incorrect api key provided')) {
    return 'api-key-mismatch';
  }
  if (value.includes('missing bearer or basic authentication')) {
    return 'missing-credential';
  }
  if (
    value.includes('could not be refreshed') ||
    value.includes('failed to refresh') ||
    value.includes('refresh token')
  ) {
    return 'refresh-failed';
  }
  // `Missing environment variable: 'X'` means no request was made at all; it is
  // not an auth failure of the kind this ticket names.
  return undefined;
}

/** The fixed, secret-free sentence for a classified failure. */
export function authFailureMessage(failure: CodexAuthFailure): string {
  switch (failure) {
    case 'api-key-mismatch':
      return 'Codex rejected an API key. The CLI is not using your ChatGPT login: sign in with the Codex CLI and remove any API-key setting from the environment.';
    case 'missing-credential':
      return 'Codex sent no credential. Sign in with the Codex CLI, then test again.';
    case 'refresh-failed':
      return 'Your ChatGPT session for Codex could not be refreshed. Run the Codex CLI sign-in again.';
  }
}
