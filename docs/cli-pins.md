# Pinned CLI releases

sideCode installs two CLIs from GitHub releases: `opencode` and `ast-grep`.
Both installers use an explicit release tag and verify the downloaded archive
SHA-256 before extracting or writing anything. The versions and digests live in
`src/backends/cliManifest.ts`:

| CLI | Version | Assets |
|---|---|---|
| opencode | `1.1.65` | 11 archives under `anomalyco/opencode` |
| ast-grep | `0.51.0` | 6 archives under `ast-grep/ast-grep` |

The URLs are tag URLs (`/releases/download/<tag>/<asset>`), never
`/releases/latest/`. A release that is newer than the pin is not installed until
the manifest is bumped.

## Fail-closed behaviour

- A missing digest for the asset this machine needs fails the install before
  any download, so an unshipped platform reports the real reason instead of a
  release 404.
- A digest mismatch fails the install.
- Neither case extracts the archive, creates the install directory, or touches
  an existing executable. An older working binary stays in place and the
  settings screen shows the failure message.

**Windows arm64 is unsupported for opencode.** `1.1.65` publishes no Windows
arm64 CLI asset, so `opencode-windows-arm64.zip` has no manifest entry. A
bundled opencode install there fails fast before the request with:

> No SHA-256 is pinned for opencode-windows-arm64.zip (version 1.1.65); this
> platform is not supported by the pinned release. Nothing was installed.

It makes no fetch and creates no directory or file. The same pre-check runs in
the ast-grep installer.

That means adding a platform is a deliberate two-part change: add the asset to
the filename mapping and add its digest. A platform without a digest cannot be
installed by accident.

## Bump procedure

1. Pick the release tag. opencode tags are `v<version>` (for example
   `v1.1.65`); ast-grep tags are the bare version (for example `0.51.0`).
2. Download **every** asset for that tag, not only the platform you run on.
   Keep the exact asset file names:

   ```sh
   gh release download v1.1.65 --repo anomalyco/opencode --dir opencode-1.1.65
   gh release download 0.51.0 --repo ast-grep/ast-grep --dir ast-grep-0.51.0
   ```

3. Compute the digests:

   ```sh
   sha256sum opencode-1.1.65/*
   sha256sum ast-grep-0.51.0/*
   ```

   On Windows use `Get-FileHash -Algorithm SHA256 <file>` or a `sha256sum`
   shipped with Git for Windows.

4. Update `OPENCODE_VERSION` / `OPENCODE_SHA256` and `AST_GREP_VERSION` /
   `AST_GREP_SHA256` in `src/backends/cliManifest.ts`. Every asset name the
   filename helpers can produce must have an entry.
5. Run the focused tests and the full suite:

   ```sh
   node --experimental-strip-types --test "src/backends/**/install.test.ts" "src/backends/cliManifest.test.ts"
   npm run typecheck
   npm test
   npm run build
   ```

6. Note any platform that is not shipped in the release and name it here. For
   example, opencode `1.1.65` has no Windows arm64 asset, so Windows arm64 stays
   unsupported. Its install fails closed before download with the
   "No SHA-256 is pinned" message. Do not add a placeholder or fall back to a
   moving tag; either add the real asset and digest or leave the platform
   unsupported.
