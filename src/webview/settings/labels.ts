import type { BackendModel } from '../../backends/types';
import type { ConnectionTestResult, SettingsSnapshot } from '../../protocol';
import { CODEX_VERSION_VALIDATION_HINT } from '../../backends/appserver/version.ts';

export function outcomeLabel(outcome: ConnectionTestResult['outcome']): string {
  switch (outcome) {
    case 'invalid-key':
      return 'invalid API key';
    case 'host':
      return 'host unreachable';
    case 'network':
      return 'network problem';
    case 'unavailable':
      return 'provider unavailable';
    default:
      return 'request refused';
  }
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function flattenModels(models: Record<string, BackendModel[]>): Array<BackendModel & { backendId: string }> {
  return Object.entries(models).flatMap(([backendId, list]) =>
    list.map((model) => ({ ...model, backendId }))
  );
}

export function ollamaLabel(settings: SettingsSnapshot): string {
  return settings.ollama.status === 'available' ? 'Ollama Cloud' : 'Ollama Cloud';
}

export function codexLabel(settings: SettingsSnapshot): string {
  if (settings.codex.status === 'unavailable') {
    return 'Codex (not installed)';
  }
  if (settings.codex.status === 'incompatible') {
    return 'Codex (protocol mismatch)';
  }
  if (settings.codex.status === 'auth-mismatch') {
    return 'Codex (wrong sign-in)';
  }
  return 'Codex';
}

export function codexAuthLabel(settings: SettingsSnapshot): string {
  if (settings.codex.status === 'available') {
    return 'Signed in';
  }
  if (settings.codex.status === 'unavailable') {
    return 'Not installed';
  }
  if (settings.codex.status === 'incompatible') {
    return 'Incompatible';
  }
  if (settings.codex.status === 'auth-mismatch') {
    return 'API key, not ChatGPT';
  }
  return 'Signed out';
}

export function codexAuthDetail(settings: SettingsSnapshot): string {
  if (settings.codex.status === 'available') {
    return settings.codex.detail ?? 'Signed in. Codex models are ready.';
  }
  if (settings.codex.status === 'unavailable') {
    return 'Not installed or not on PATH. Set the CLI path above, then test again.';
  }
  if (settings.codex.status === 'incompatible') {
    return (
      settings.codex.detail ??
      `The Codex CLI is installed but its protocol version is not supported. ${CODEX_VERSION_VALIDATION_HINT}`
    );
  }
  if (settings.codex.status === 'auth-mismatch') {
    return (
      settings.codex.detail ??
      'Codex is signed in with an API key, not the ChatGPT login. Run the Codex CLI sign-in with the ChatGPT option and remove any API-key setting from the environment.'
    );
  }
  return 'Not signed in. Codex models stay hidden until the CLI sign-in succeeds.';
}

