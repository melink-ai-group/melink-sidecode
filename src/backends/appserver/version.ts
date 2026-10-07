/**
 * The pinned Codex app-server protocol version and the window of server
 * versions the checked-in `schemas/` bindings are known to describe.
 *
 * The generated bindings in `schemas/` are the compile-time guard: a drift in
 * the protocol shape becomes a type error. This module is the runtime guard for
 * the other half of the problem — the installed CLI can be much older or newer
 * than the pin, in which case the handshake may never answer and the caller only
 * sees a silent timeout. Comparing the server's own reported version against
 * this window lets that failure become a specific `incompatible` status carrying
 * the version, rather than a generic dead backend.
 *
 * Kept pure and host-free so the range is unit-testable and so a future re-pin
 * is a one-line edit here plus a `schemas:generate` run.
 */

/** The `codex-cli` version the checked-in `schemas/` were generated from. */
export const PINNED_CODEX_VERSION = '0.156.1';

/**
 * The range of server versions this pin is known to interoperate with, as
 * `major`/`minor` numbers. The window spans the previously verified pin
 * (`0.154.0`) through `0.160.x` (Codex app-server `0.160.1`). A patch inside
 * that window is accepted; a minor bump past it is reported precisely instead
 * of silently wedging. The checked-in `schemas/` remain generated from the pin.
 */
export const SUPPORTED_CODEX_MAJOR = 0;
export const SUPPORTED_CODEX_MINOR_MIN = 154;
export const SUPPORTED_CODEX_MINOR_MAX = 160;

/** A parsed `major.minor.patch`, with the exact server-reported text kept. */
export interface CodexVersion {
  major: number;
  minor: number;
  patch: number;
  /** The version exactly as the server reported it, e.g. `0.156.1`. */
  raw: string;
}

/**
 * Parse a version out of arbitrary server text (the `codex --version` line, or
 * the `initialize` user agent). Returns `undefined` when no `X.Y.Z` is present
 * rather than inventing `0.0.0`, so an unparseable version is never treated as a
 * supported one.
 */
export function parseCodexVersion(text: string | undefined | null): CodexVersion | undefined {
  if (!text) {
    return undefined;
  }
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) {
    return undefined;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return undefined;
  }
  return { major, minor, patch, raw: `${match[1]}.${match[2]}.${match[3]}` };
}

/**
 * Extract the app-server's own version from its `initialize` user agent. The
 * server puts its version on the leading `<client-name>/<version>` token while
 * the client's version appears later in the parenthesised suffix, so the first
 * `X.Y.Z` is the server's.
 */
export function codexVersionFromUserAgent(userAgent: string | undefined): string | undefined {
  if (!userAgent) {
    return undefined;
  }
  const match = /^[^/\s]+\/(\d+\.\d+\.\d+)/.exec(userAgent.trim());
  if (match) {
    return match[1];
  }
  return parseCodexVersion(userAgent)?.raw;
}

/**
 * Whether a server version falls inside the pinned protocol window. An
 * unparseable version is never supported: guessing compatibility is exactly the
 * silent failure this guard exists to remove.
 */
export function isSupportedCodexVersion(version: CodexVersion | string | undefined): boolean {
  const parsed = typeof version === 'string' ? parseCodexVersion(version) : version;
  if (!parsed) {
    return false;
  }
  if (parsed.major !== SUPPORTED_CODEX_MAJOR) {
    return false;
  }
  return parsed.minor >= SUPPORTED_CODEX_MINOR_MIN && parsed.minor <= SUPPORTED_CODEX_MINOR_MAX;
}

/**
 * The human-readable protocol window, e.g. `0.154.0–0.160.x`, used in the
 * plain-language `incompatible` status so the drift is named, not just detected.
 */
export function supportedCodexVersionRange(): string {
  return `${SUPPORTED_CODEX_MAJOR}.${SUPPORTED_CODEX_MINOR_MIN}.0–${SUPPORTED_CODEX_MAJOR}.${SUPPORTED_CODEX_MINOR_MAX}.x`;
}
