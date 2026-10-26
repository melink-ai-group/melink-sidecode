# CLI releases and verification

sideCode installs OpenCode and ast-grep from their official GitHub repositories.
Both verify the archive SHA-256 before extracting or writing the executable.

## OpenCode: latest stable release

Install and Update query `https://api.github.com/repos/anomalyco/opencode/releases/latest`
on every action. They select the asset for this machine from that stable release,
then download its exact `/releases/download/<tag>/<asset>` URL. A new stable release
is picked up without changing sideCode's source or rebuilding the extension.
The bundled executable lives in extension global storage; running `opencode upgrade`
on a different PATH executable does not update that copy.

The expected SHA-256 comes from the asset's `digest` in GitHub's HTTPS API response.
Drafts, prereleases, invalid metadata, missing assets or digests, network failures,
and checksum mismatches fail visibly without installing unverified bytes. Metadata
and archive requests are bounded by timeouts and size limits. The installer never
falls back to an old fixed release or skips verification. Platform support follows
the assets actually published in the selected release.

The Settings action probes the installed executable and checks its reported version
against the selected release before saving the source/path and reporting success.
A failed check must not report that the CLI is up to date.

## ast-grep: pinned release

The ast-grep version and digests remain in `src/backends/cliManifest.ts`:

| CLI | Version | Assets |
| --- | --- | --- |
| ast-grep | `0.51.0` | 6 archives under `ast-grep/ast-grep` |

A missing digest fails before download. A checksum mismatch fails before extracting
or replacing the executable. Neither condition overwrites an existing executable.

To bump ast-grep:

1. Select an official tag and download every supported archive from that tag.
2. Compute each archive's SHA-256.
3. Update `AST_GREP_VERSION` and `AST_GREP_SHA256` in `src/backends/cliManifest.ts`.
4. Run the installer tests, `npm run typecheck`, `npm test`, and `npm run build`.
5. Update the version table above and note any unsupported platforms.
