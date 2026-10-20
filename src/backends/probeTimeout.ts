/**
 * Shared timeout primitives for provider probes.
 *
 * A probe (model catalog, test connection, availability) must never wait
 * forever: it either answers, or fails with a plain-language timeout that says
 * which provider timed out. Ordinary chat turns are deliberately excluded:
 * they keep their own cancellation signal and are not put on this deadline.
 *
 * Host-free: no `vscode` import, and the fetch used for a probe is injectable,
 * so a test can use a never-resolving stub and a millisecond timeout.
 */

import { BackendError, type ConnectionTestResult } from './types.ts';

/** The single provider-probe deadline. Ten seconds, shared by every probe. */
export const PROVIDER_PROBE_TIMEOUT_MS = 10_000;

/** Render a timeout for a sentence: 10s, 1.5s, 0.02s. */
function formatTimeout(timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  return `${Number.isInteger(seconds) ? seconds : Number(seconds.toFixed(3))}s`;
}

/** The one user-visible wording for a timed-out probe. Never includes credentials. */
export function timeoutMessage(provider: string, timeoutMs: number = PROVIDER_PROBE_TIMEOUT_MS): string {
  return `The ${provider} probe timed out after ${formatTimeout(timeoutMs)}. Try again.`;
}

/** A probe exceeded its deadline. Carries no request headers or token. */
export class ProviderTimeoutError extends Error {
  readonly provider: string;
  readonly timeoutMs: number;

  constructor(provider: string, timeoutMs: number = PROVIDER_PROBE_TIMEOUT_MS, cause?: unknown) {
    super(timeoutMessage(provider, timeoutMs));
    this.name = 'ProviderTimeoutError';
    this.provider = provider;
    this.timeoutMs = timeoutMs;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * An abort signal that fires after `timeoutMs`. `AbortSignal.timeout` is used
 * when the runtime has it (its timer does not hold the process open); the small
 * controller fallback does the same with an unref'd timer.
 */
export function probeSignal(timeoutMs: number = PROVIDER_PROBE_TIMEOUT_MS): AbortSignal {
  const native = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout;
  if (typeof native === 'function') {
    return native.call(AbortSignal, timeoutMs);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  return controller.signal;
}

function combineSignals(first: AbortSignal, second: AbortSignal): AbortSignal {
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === 'function') {
    return any.call(AbortSignal, [first, second]);
  }
  // No AbortSignal.any: forward both inputs to one controller so the fetch is
  // actually aborted when either the caller or the probe deadline fires.
  const controller = new AbortController();
  if (first.aborted || second.aborted) {
    controller.abort();
    return controller.signal;
  }
  const forward = (): void => {
    first.removeEventListener('abort', forward);
    second.removeEventListener('abort', forward);
    controller.abort();
  };
  first.addEventListener('abort', forward, { once: true });
  second.addEventListener('abort', forward, { once: true });
  return controller.signal;
}

/** Whether an error came from a probe deadline (directly or wrapped by a backend). */
export function isProbeTimeoutError(error: unknown): error is ProviderTimeoutError | BackendError {
  if (error instanceof ProviderTimeoutError) {
    return true;
  }
  return error instanceof BackendError && error.cause instanceof ProviderTimeoutError;
}

/**
 * Race an operation against the probe deadline. The passed signal is the probe
 * signal, so a caller-side abort (an ordinary turn) is never mistaken for a
 * timeout: its promise rejects with its own `AbortError` instead.
 */
export async function withProbeTimeout<T>(
  provider: string,
  timeoutMs: number,
  signal: AbortSignal,
  operation: Promise<T>
): Promise<T> {
  if (signal.aborted) {
    throw new ProviderTimeoutError(provider, timeoutMs);
  }
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(new ProviderTimeoutError(provider, timeoutMs));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/**
 * Fetch one probe URL with an already-created shared deadline. The fetch gets a
 * signal combined with any caller signal, while the promise race watches the
 * probe signal alone, so a caller cancel is never reported as a timeout.
 */
export async function fetchWithProbeSignal(
  url: string,
  init: RequestInit,
  provider: string,
  timeoutMs: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const fetchSignal = init.signal ? combineSignals(init.signal, signal) : signal;
  return await withProbeTimeout(provider, timeoutMs, signal, fetchImpl(url, { ...init, signal: fetchSignal }));
}

/**
 * Fetch one probe URL with the shared deadline. The signal is passed to the
 * fetch (and combined with a caller signal when there is one), and the promise
 * race guarantees a stub or transport that ignores the signal still cannot hang
 * the probe.
 */
export async function fetchWithProbeTimeout(
  url: string,
  init: RequestInit,
  provider: string,
  timeoutMs: number = PROVIDER_PROBE_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  return await fetchWithProbeSignal(url, init, provider, timeoutMs, probeSignal(timeoutMs), fetchImpl);
}

/**
 * Read a probe response body on the shared deadline. A body that never settles
 * is a timeout, not a silently empty catalog.
 */
export async function readProbeJson<T>(
  response: Response,
  provider: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<T> {
  try {
    return (await withProbeTimeout(provider, timeoutMs, signal, response.json())) as T;
  } catch (error) {
    if (isProbeTimeoutError(error)) {
      throw error instanceof BackendError
        ? error
        : new BackendError('unavailable', error.message, error);
    }
    if (signal.aborted) {
      throw new BackendError('unavailable', timeoutMessage(provider, timeoutMs), error);
    }
    throw error;
  }
}

/** A probe model-list request: a timeout becomes `BackendError('unavailable')`. */
export async function requestWithProbeTimeout(options: {
  url: string;
  init?: RequestInit;
  provider: string;
  timeoutMs?: number;
  /** An existing shared deadline, so one list operation can cover several calls. */
  probeSignal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? PROVIDER_PROBE_TIMEOUT_MS;
  const signal = options.probeSignal ?? probeSignal(timeoutMs);
  try {
    return await fetchWithProbeSignal(options.url, options.init ?? {}, options.provider, timeoutMs, signal, options.fetchImpl);
  } catch (error) {
    if (isProbeTimeoutError(error)) {
      throw error instanceof BackendError
        ? error
        : new BackendError('unavailable', error.message, error);
    }
    throw error;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The `code` on a transport error's cause chain, when one is present. */
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
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('getaddrinfo') || message.includes('enotfound');
}

/**
 * The Ollama Cloud test-connection probe, host-free so the timeout result can
 * be exercised with a stub. Every outcome is distinct: a timed-out request is
 * `unavailable` and names the timeout, never a generic "network failed", while
 * 401/403 stays `invalid-key`, a DNS/refused host stays `host`, an offline
 * device stays `network`, and a non-ok host stays `provider`.
 */
export async function probeOllamaConnection(options: {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<ConnectionTestResult> {
  const provider = 'Ollama Cloud';
  const timeoutMs = options.timeoutMs ?? PROVIDER_PROBE_TIMEOUT_MS;
  const { baseUrl } = options;
  if (!isHttpUrl(baseUrl)) {
    return {
      backendId: 'ollama',
      outcome: 'host',
      message: 'The base URL is not a full http or https address. Fix it, then test again.'
    };
  }
  if (!options.token) {
    return {
      backendId: 'ollama',
      outcome: 'invalid-key',
      message: 'No key is stored. Add a key, then test again.'
    };
  }
  let response: Response;
  try {
    response = await fetchWithProbeTimeout(
      `${baseUrl}/api/tags`,
      { headers: { Authorization: `Bearer ${options.token}` } },
      provider,
      timeoutMs,
      options.fetchImpl
    );
  } catch (error) {
    if (error instanceof ProviderTimeoutError) {
      return { backendId: 'ollama', outcome: 'unavailable', message: error.message };
    }
    // A transport failure is the only place the network and the host differ.
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (offline) {
      return {
        backendId: 'ollama',
        outcome: 'network',
        message: 'This device appears to be offline. Reconnect, then test again.'
      };
    }
    if (isDnsOrRefused(error)) {
      return {
        backendId: 'ollama',
        outcome: 'host',
        message: `Could not reach ${baseUrl}. Check the base URL, then test again.`
      };
    }
    return {
      backendId: 'ollama',
      outcome: 'network',
      message: 'The request did not complete. Check your network connection, then test again.'
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      backendId: 'ollama',
      outcome: 'invalid-key',
      message: 'The host answered but rejected this key. Check the key, or confirm the base URL points at the host that issued it.'
    };
  }
  if (!response.ok) {
    return {
      backendId: 'ollama',
      outcome: 'provider',
      message: `The host answered with ${response.status}. The key was accepted, so this is a host-side problem.`
    };
  }
  return {
    backendId: 'ollama',
    outcome: 'ok',
    message: `Connected to ${baseUrl}. The key was accepted.`
  };
}
