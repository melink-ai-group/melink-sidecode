/**
 * Secret-storage keys, defined in exactly one place.
 *
 * A credential is written with `secrets.store` and read with `secrets.get`
 * against these constants only. It must never be copied into settings,
 * output channels, log lines, or error text.
 */
export const OLLAMA_TOKEN_SECRET_KEY = 'melink.ollama.token';

/** OpenCode Zen API key (pay-as-you-go); free models work without it. */
export const OPENCODE_ZEN_TOKEN_SECRET_KEY = 'melink.opencode.zenToken';
