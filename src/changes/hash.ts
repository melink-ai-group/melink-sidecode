import { createHash } from 'node:crypto';

/**
 * Deterministic content hashing shared by the change journal, the diff and the
 * decision store.
 *
 * `node:crypto` is a Node built-in, not a runtime dependency, and this module
 * never imports `vscode`, so it stays unit-testable without a host. Hashing is
 * the one primitive the journal, diff and decision paths must agree on: the
 * journal records an `afterHash`, the conflict guard compares the file's current
 * hash against it, and a hunk id is a hash of the hunk's own content.
 */

/** SHA-256 of raw bytes, hex-encoded. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** SHA-256 of a UTF-8 string, hex-encoded. */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
