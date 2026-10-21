/**
 * The two Ollama provider profiles.
 *
 * Ollama Cloud and Ollama Local share one adapter: the same thread handling,
 * approvals, cancellation, OpenCode runtime and compaction. They differ only in
 * identity, the setting keys they read, their default host, and whether a
 * credential exists. Those differences live here so the adapter never branches
 * on a hardcoded provider id.
 */

export type OllamaProviderId = 'ollama' | 'ollama-local';

export interface OllamaProfile {
  id: OllamaProviderId;
  /** The provider name every user-visible string uses. */
  label: string;
  /** The short badge shown in provider lists. */
  badge: string;
  /** The setting that holds the base URL (user-scoped for both). */
  baseUrlKey: string;
  defaultBaseUrl: string;
  /** The setting that holds the default model. */
  defaultModelKey: string;
  /**
   * `secret` reads the bearer token from SecretStorage. `none` sends no
   * Authorization header at all: a local server has no credential flow.
   */
  credential: 'secret' | 'none';
}

export const OLLAMA_CLOUD_PROFILE: OllamaProfile = {
  id: 'ollama',
  label: 'Ollama Cloud',
  badge: 'Ollama',
  baseUrlKey: 'melink.ollama.baseUrl',
  defaultBaseUrl: 'https://ollama.com',
  defaultModelKey: 'melink.ollama.defaultModel',
  credential: 'secret'
};

export const OLLAMA_LOCAL_PROFILE: OllamaProfile = {
  id: 'ollama-local',
  label: 'Ollama Local',
  badge: 'Ollama',
  baseUrlKey: 'melink.ollamaLocal.baseUrl',
  defaultBaseUrl: 'http://localhost:11434',
  defaultModelKey: 'melink.ollamaLocal.defaultModel',
  credential: 'none'
};

export function ollamaProfileFor(id: string): OllamaProfile | undefined {
  if (id === OLLAMA_CLOUD_PROFILE.id) {
    return OLLAMA_CLOUD_PROFILE;
  }
  if (id === OLLAMA_LOCAL_PROFILE.id) {
    return OLLAMA_LOCAL_PROFILE;
  }
  return undefined;
}
