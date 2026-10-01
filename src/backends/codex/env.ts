/**
 * Child-environment scrubbing and auth-preference arguments for the Codex
 * app-server spawn.
 *
 * Codex reads ChatGPT OAuth credentials from `$CODEX_HOME/auth.json`, but it
 * also accepts credentials and endpoint overrides from the environment. The
 * extension host's environment is inherited by every child process, so an
 * `OPENAI_API_KEY` set for an unrelated tool would be visible to Codex. A 401
 * against the ChatGPT Codex backend usually means a credential arrived that is
 * not the one the user logged in with, so these variables are removed from the
 * child env before spawn. The variables Codex needs to find `auth.json` and to
 * run (`HOME`, `USERPROFILE`, `PATH`, `CODEX_HOME`) are deliberately not
 * touched.
 *
 * The auth preference is made explicit rather than inherited: Codex 0.156.1
 * uses `forced_login_method` (verified against the installed binary; there is
 * no `preferred_auth_method` key), with accepted values `chatgpt` and `api`.
 * It is passed as a per-invocation `-c` override so behaviour does not depend
 * on the user's `~/.codex/config.toml`. An unrecognized key is ignored by the
 * CLI rather than fatal, so this stays safe across the supported version window.
 *
 * This module is pure and host-free so the rule is unit-testable and a future
 * credential variable is a one-line addition here rather than a change buried
 * in the spawn call. It never logs, echoes, or interpolates a value.
 */

/**
 * Environment variables that can supply a credential or redirect the endpoint
 * Codex talks to. Scrubbed from the inherited environment so the ChatGPT
 * `auth.json` login is the only credential the CLI can see.
 */
export const CODEX_CREDENTIAL_ENV_VARS: readonly string[] = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_ORGANIZATION',
  'OPENAI_API_BASE',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
  'OPENAI_IDENTITY_TOKEN_FILE',
  'OPENAI_WORKLOAD_IDENTITY_CONTEXT',
  'OPENAI_FEDERATION_RULE_ID'
];

/**
 * The per-invocation override that pins the ChatGPT login method. Passed to
 * every Codex invocation as `-c 'forced_login_method="chatgpt"'`, ahead of the
 * `app-server` subcommand. No credential is carried here: the value is the
 * literal name of an auth method.
 */
export const CODEX_AUTH_PREFERENCE_ARGS: readonly string[] = [
  '-c',
  'forced_login_method="chatgpt"'
];

/**
 * A copy of `base` with every credential/base-URL variable removed. Matching is
 * case-insensitive because Windows environment lookups are, so `Openai_Api_Key`
 * cannot slip through. Nothing is added: `HOME`, `USERPROFILE`, `PATH`, and
 * `CODEX_HOME` survive untouched because they are not in the block list.
 */
export function scrubbedCodexEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const blocked = new Set(CODEX_CREDENTIAL_ENV_VARS);
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (blocked.has(key.toUpperCase())) {
      delete env[key];
    }
  }
  return env;
}

/** A fresh copy of the ChatGPT auth-preference arguments, ready to prepend. */
export function codexAuthPreferenceArgs(): string[] {
  return [...CODEX_AUTH_PREFERENCE_ARGS];
}
