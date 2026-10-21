import type { ConnectionTestResult } from './types.ts';
import { PROVIDER_PROBE_TIMEOUT_MS, isProbeTimeoutError } from './probeTimeout.ts';

/**
 * Health and compatibility checks for a local Ollama server.
 *
 * A local server has no credential, so the cloud probe's key classification is
 * meaningless here. What matters instead is that the host answers the native
 * API *and* exposes the OpenAI-compatible `/v1` endpoint OpenCode uses for
 * turns. Each failure is a distinct, actionable message: a stopped server says
 * how to start it, a timeout names the deadline, and a server without `/v1`
 * says to update Ollama rather than silently failing on every turn.
 *
 * Host-free: the request function is injected (the adapter's transport seam),
 * so the whole matrix is unit-testable without a network.
 */

export const OLLAMA_LOCAL_PROVIDER = 'Ollama Local';

export const OLLAMA_LOCAL_NO_KEY_MESSAGE =
  'This endpoint requires an API key. Ollama Local does not support keys; use Ollama Cloud instead.';

export const OLLAMA_LOCAL_MISSING_V1_MESSAGE =
  'Ollama is running but `/v1` is missing. Update Ollama so OpenCode can send turns.';

/** One request the adapter owns; the path is appended to its base URL. */
export type OllamaLocalRequest = (path: string, init?: RequestInit) => Promise<Response>;

export interface OllamaLocalProbeOptions {
  baseUrl: string;
  request: OllamaLocalRequest;
  timeoutMs?: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function causeCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) {
    return undefined;
  }
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code.toUpperCase() : undefined;
}

/** Host failure (DNS/refused) vs network failure (offline/timeout/reset). */
function isDnsOrRefused(error: unknown): boolean {
  const code = causeCode(error);
  if (code) {
    return code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN';
  }
  const message = messageOf(error).toLowerCase();
  return message.includes('getaddrinfo') || message.includes('enotfound');
}

/** True when the body looks like Ollama's native `/api/tags` response. */
export function isOllamaTagsBody(body: unknown): body is { models?: unknown[] } {
  return (
    typeof body === 'object' &&
    body !== null &&
    Array.isArray((body as { models?: unknown }).models)
  );
}

function result(
  outcome: ConnectionTestResult['outcome'],
  message: string
): ConnectionTestResult {
  return { backendId: 'ollama-local', outcome, message };
}

function startHint(baseUrl: string): string {
  return `Start Ollama (\`ollama serve\`) at ${baseUrl}, or change the base URL, then test again.`;
}

/**
 * Probe the configured local server: native `/api/tags` for identity, then
 * `/v1/models` for the OpenCode path.
 *
 * Never throws: every failure is a `ConnectionTestResult`.
 */
export async function probeOllamaLocal(options: OllamaLocalProbeOptions): Promise<ConnectionTestResult> {
  const { baseUrl } = options;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return result('host', 'The base URL is not a full http or https address. Fix it, then test again.');
    }
  } catch {
    return result('host', 'The base URL is not a full http or https address. Fix it, then test again.');
  }

  let tags: Response;
  try {
    tags = await options.request('/api/tags');
  } catch (error) {
    if (isProbeTimeoutError(error)) {
      return result('unavailable', timeoutCopy(options.timeoutMs));
    }
    if (isDnsOrRefused(error)) {
      return result('host', startHint(baseUrl));
    }
    return result(
      'network',
      `The request to ${baseUrl} did not complete. Check that the server is running and reachable, then test again.`
    );
  }

  if (tags.status === 401 || tags.status === 403) {
    return result('provider', OLLAMA_LOCAL_NO_KEY_MESSAGE);
  }
  if (!tags.ok) {
    return result('provider', `Ollama Local answered with ${tags.status}. Check the base URL, then test again.`);
  }

  let body: unknown;
  try {
    body = await tags.json();
  } catch {
    return result(
      'provider',
      `The server at ${baseUrl} did not answer like Ollama. Check the base URL, then test again.`
    );
  }
  if (!isOllamaTagsBody(body)) {
    return result(
      'provider',
      `The server at ${baseUrl} did not answer like Ollama. Check the base URL, then test again.`
    );
  }

  let v1: Response;
  try {
    v1 = await options.request('/v1/models');
  } catch (error) {
    if (isProbeTimeoutError(error)) {
      return result('unavailable', timeoutCopy(options.timeoutMs));
    }
    if (isDnsOrRefused(error)) {
      return result('host', startHint(baseUrl));
    }
    return result(
      'network',
      `The request to ${baseUrl}/v1/models did not complete. Check that the server is running and reachable, then test again.`
    );
  }
  if (v1.status === 401 || v1.status === 403) {
    return result('provider', OLLAMA_LOCAL_NO_KEY_MESSAGE);
  }
  if (v1.status === 404 || v1.status === 405) {
    return result('unavailable', OLLAMA_LOCAL_MISSING_V1_MESSAGE);
  }
  if (!v1.ok) {
    return result(
      'provider',
      `Ollama answered \`/v1/models\` with ${v1.status}. Check the server version, then test again.`
    );
  }

  return result('ok', `Connected to ${baseUrl}.`);
}

function timeoutCopy(timeoutMs: number | undefined): string {
  const seconds = (timeoutMs ?? PROVIDER_PROBE_TIMEOUT_MS) / 1000;
  const shown = Number.isInteger(seconds) ? seconds : Number(seconds.toFixed(3));
  return `Ollama Local did not answer within ${shown}s. Check that the server is running, then test again.`;
}
