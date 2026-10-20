import { trustedSetting, type InspectedSetting } from '../config/trust.ts';
import { BackendError } from './types.ts';

/**
 * Where the Ollama Cloud bearer token is sent, and how the request URL is
 * built from it.
 *
 * This module is host-free on purpose: the base URL is the single value that
 * decides which host receives the credential, so the rule that decides it
 * (the user's own setting, never the workspace's) and the URL it produces
 * must be testable without an extension host.
 *
 * `ollama.ts` reads the value through `inspect()` and hands the inspected
 * shape here; the transport seam below lets a test observe the exact URL a
 * request would go to.
 */

/** The default host the token is sent to when nothing is configured. */
export const DEFAULT_OLLAMA_BASE_URL = 'https://ollama.com';

/** A trimmed base URL without its trailing slashes. */
export function normalizeOllamaBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** True for the abort a canceled turn produces. */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError';
}

/** A base URL must be a full http(s) address, or the request never leaves. */
export function isHttpOllamaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The base URL the token is sent to.
 *
 * Only the user's own value (`globalValue`) or the contributed default is
 * used. A workspace override in `.vscode/settings.json` is ignored, so a
 * repository cannot redirect the bearer token to a host of its choosing.
 */
export function resolveOllamaBaseUrl(
  inspected: InspectedSetting<string> | undefined,
  fallback: string = DEFAULT_OLLAMA_BASE_URL
): string {
  const value = trustedSetting(inspected, fallback);
  return normalizeOllamaBaseUrl(typeof value === 'string' ? value : fallback);
}

/** The full URL one API path is requested from. */
export function ollamaRequestUrl(baseUrl: string, path: string): string {
  return `${normalizeOllamaBaseUrl(baseUrl)}${path}`;
}

/**
 * The transport a request goes through.
 *
 * A seam so a test can observe the exact URL and headers without a network
 * or an extension host. The default is the platform `fetch`.
 */
export type OllamaTransport = (url: string, init: RequestInit) => Promise<Response>;

/** The platform fetch, captured so a test can replace it. */
export function defaultOllamaTransport(): OllamaTransport {
  return (url, init) => fetch(url, init);
}

export interface OllamaRequestOptions {
  /** The already-resolved base URL (the user-scoped one). */
  baseUrl: string;
  /** The API path, e.g. `/api/tags`. */
  path: string;
  /** The bearer credential. Never logged, never put in the URL. */
  token: string;
  /** Extra request options merged under the credential headers. */
  init?: RequestInit;
  /** The transport seam; the platform fetch when absent. */
  transport?: OllamaTransport;
}

/**
 * One authenticated request to the configured host.
 *
 * The credential travels in the `Authorization` header only. The URL is built
 * from the resolved base URL, so the host that receives the token is exactly
 * the host the user configured.
 */
export async function ollamaRequest(options: OllamaRequestOptions): Promise<Response> {
  const transport = options.transport ?? defaultOllamaTransport();
  const url = ollamaRequestUrl(options.baseUrl, options.path);
  let response: Response;
  try {
    response = await transport(url, {
      ...options.init,
      headers: {
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
        ...(options.init?.headers ?? {})
      }
    });
  } catch (cause) {
    // An aborted request is not a host failure: the caller turns it into a
    // cancellation, so the raw cause is kept rather than wrapped.
    if (isAbortError(cause)) {
      throw cause;
    }
    throw new BackendError(
      'unavailable',
      `Cannot reach Ollama Cloud at ${normalizeOllamaBaseUrl(options.baseUrl)}. Check the network or the base URL setting.`,
      cause
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new BackendError('unauthenticated', 'Your Ollama Cloud token was rejected. It may be expired or revoked.');
  }
  if (!response.ok) {
    throw new BackendError('provider', `Ollama Cloud returned ${response.status} ${response.statusText}.`);
  }
  return response;
}

/**
 * A status-preserving request to the configured host.
 *
 * The same request as `ollamaRequest`, except the response status is *not*
 * turned into an error: the settings screen's "Test connection" has to tell
 * a rejected key (`401`/`403`) apart from a host-side failure (any other
 * non-2xx), so the status has to reach the caller.
 *
 * A transport failure still propagates as-is, so the caller can tell a DNS
 * or refused host apart from a general network failure.
 */
export async function ollamaProbe(options: OllamaRequestOptions): Promise<Response> {
  const transport = options.transport ?? defaultOllamaTransport();
  const url = ollamaRequestUrl(options.baseUrl, options.path);
  return transport(url, {
    ...options.init,
    headers: {
      Authorization: `Bearer ${options.token}`,
      'Content-Type': 'application/json',
      ...(options.init?.headers ?? {})
    }
  });
}

/**
 * The small client the Ollama adapter talks to.
 *
 * It owns two things the adapter must not re-derive: which host the
 * credential goes to (the user's own setting) and how the request is issued
 * (the transport seam). The adapter passes the inspected settings and the
 * token; the client resolves the base URL and issues the request.
 */
export class OllamaClient {
  private readonly inspectedBaseUrl: InspectedSetting<string> | undefined;
  private readonly transport: OllamaTransport;
  private readonly fallback: string;

  constructor(
    inspectedBaseUrl: InspectedSetting<string> | undefined,
    transport: OllamaTransport = defaultOllamaTransport(),
    fallback: string = DEFAULT_OLLAMA_BASE_URL
  ) {
    this.inspectedBaseUrl = inspectedBaseUrl;
    this.transport = transport;
    this.fallback = fallback;
  }

  /** The host the bearer token is sent to. */
  get baseUrl(): string {
    return resolveOllamaBaseUrl(this.inspectedBaseUrl, this.fallback);
  }

  /** One authenticated request to the configured host. */
  async request(path: string, token: string, init?: RequestInit): Promise<Response> {
    return ollamaRequest({
      baseUrl: this.baseUrl,
      path,
      token,
      transport: this.transport,
      ...(init ? { init } : {})
    });
  }

  /**
   * One authenticated request whose status the caller classifies.
   *
   * The settings screen's "Test connection" needs the raw status to tell a
   * rejected key from a host-side failure.
   */
  async probe(path: string, token: string, init?: RequestInit): Promise<Response> {
    return ollamaProbe({
      baseUrl: this.baseUrl,
      path,
      token,
      transport: this.transport,
      ...(init ? { init } : {})
    });
  }
}
