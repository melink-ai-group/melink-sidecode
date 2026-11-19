# Security policy

## Supported versions

Security fixes are provided for the current `0.3.x` line. Older builds should be upgraded to the latest release.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include the affected version, host (VS Code or Open VSX), operating system, provider, reproduction steps, impact, and any logs with tokens and personal paths redacted.

If private reporting is unavailable, contact the maintainers through GitHub and ask for a private channel. Do not include a working credential in the first message.

## What to include

- sideCode version and VS Code or host version.
- The provider and permission level in use.
- Whether the workspace was trusted.
- The smallest reproduction you can share.
- The expected and actual behavior.
- Relevant log excerpts with secrets removed.

## Response

We aim to acknowledge a report within five business days, triage it, and agree on a disclosure timeline with the reporter. Confirmed issues are fixed in a release and credited unless the reporter asks to remain anonymous. This is a small project without a bug bounty.

## Scope

In scope:

- Extension-host and webview code.
- Credential handling and secret storage.
- Spawning and resolving the `codex`, `opencode`, `zg`, and `ast-grep` executables.
- Workspace trust and application-scoped settings.
- Approval cards, permission levels, and the destructive-command classifier.
- Browser tools, origin approvals, and downloaded CLI archives.
- Release packaging and checksum verification.

Out of scope:

- Vulnerabilities in VS Code, the host, a provider API, or a third-party CLI that sideCode invokes.
- A provider's own data handling after a request leaves sideCode.
- Denial of service caused by a malicious model output that the user can stop.

## Security model

- Trust-sensitive settings are application-scoped and read from user settings only, so a workspace cannot redirect a token or choose a binary.
- Provider tokens live in VS Code secret storage; they are injected into the selected provider's request or child environment, not written into settings, logs, or the workspace.
- The destructive-command classifier runs before stored approval rules. Ask mode refuses actions; unrestricted mode requires an explicit confirmation.
- Relative executable paths, including the Windows drive-relative form, are refused.
- Untrusted workspaces run with a limited contract and cannot change the trust-sensitive settings.
- sideCode has no network telemetry. The optional missed-issue log is local, application-scoped, opt-in, and limited to redacted fields.

The full setting-by-setting audit is in [docs/settings-audit.md](docs/settings-audit.md).

## Dependency advisories

`npm audit --omit=dev` currently reports high-severity advisories in the local Whisper runtime's transitive tree (`@xenova/transformers` through `onnxruntime-web`, `sharp`, and `protobufjs`). These packages process the locally cached Whisper model; they are not on the provider request path. `npm audit fix` proposes a breaking downgrade, so the remediation is an upstream upgrade of the Transformers.js/ONNX stack rather than a force fix. Do not load an untrusted model file into the dictation runtime.

## Safe harbor

We will not pursue legal action against researchers who make a good-faith effort to avoid privacy violations, service disruption, and data destruction, and who report findings privately and give us a reasonable window to fix them.
