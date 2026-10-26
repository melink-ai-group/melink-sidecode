import { createHash } from 'node:crypto';

/**
 * Pinned ast-grep release version and shared archive verification helpers.
 *
 * Installers download from an explicit tag, never a moving release alias, and
 * verify the archive SHA-256 before extracting or writing anything. A missing digest
 * is a failure, not a warning, so a new platform cannot be installed silently.
 */

export const AST_GREP_VERSION = '0.51.0';

export interface CliArchiveManifest {
  readonly tool: string;
  readonly version: string;
  readonly checksums: Readonly<Record<string, string>>;
}

export const AST_GREP_SHA256: Readonly<Record<string, string>> = {
  'app-aarch64-apple-darwin.zip': 'e18e13c27ed6c4b3ec4de00745b0755dee9dc26c035e226f4dd5d147dca99cc8',
  'app-aarch64-pc-windows-msvc.zip': 'fb6a4c3c6ed350d7e64eae81961bdf6b3f201c6e7c31ace8caccf8ceddff1cac',
  'app-aarch64-unknown-linux-gnu.zip': '73af0ebe5958acee012754a5b2826a186580ef83333092408a7a01096fc30b8b',
  'app-x86_64-apple-darwin.zip': '8438fe549da59da28518c45bdaab5b851aabafe8fb4f8dc05c261a7649b4eca6',
  'app-x86_64-pc-windows-msvc.zip': '1a5b7824c5925ac34257f806488e54860817cefd855fd308d13df7550d068908',
  'app-x86_64-unknown-linux-gnu.zip': 'a7eead5552d3a8daad70f5d50d935da44bd0c138e946b5b0a96b1d38169fa639'
};

export const AST_GREP_MANIFEST: CliArchiveManifest = {
  tool: 'ast-grep',
  version: AST_GREP_VERSION,
  checksums: AST_GREP_SHA256
};

/** The pinned ast-grep release asset URL. The tag is explicit, never `latest`. */
export function astGrepReleaseUrl(filename: string): string {
  return `https://github.com/ast-grep/ast-grep/releases/download/${AST_GREP_VERSION}/${filename}`;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Look up a pinned digest before any network work. A missing digest is the same
 * fail-closed error the post-download verification would report, but it lands
 * before a 404 so the user sees the real reason a platform is unsupported.
 */
export function requirePinnedChecksum(
  filename: string,
  manifest: CliArchiveManifest = AST_GREP_MANIFEST
): string {
  const expected = manifest.checksums[filename];
  if (!expected) {
    throw new Error(
      `No SHA-256 is pinned for ${filename} (version ${manifest.version}); this platform is not supported by the pinned release. Nothing was installed.`
    );
  }
  return expected;
}

/**
 * Verify an archive against a pinned manifest before it is extracted or written.
 * Missing digests and mismatches both throw, and the message names the asset and
 * pinned version so the caller can report it without a stack trace.
 */
export function verifyArchiveSha256(
  filename: string,
  archive: Uint8Array,
  manifest: CliArchiveManifest = AST_GREP_MANIFEST
): void {
  const expected = requirePinnedChecksum(filename, manifest);
  const actual = sha256Hex(archive);
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `SHA-256 mismatch for ${manifest.tool} ${manifest.version} asset ${filename}, so it was not installed.`
    );
  }
}
