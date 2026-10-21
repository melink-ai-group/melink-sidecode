# Settings audit: contributed configuration, credentials, and persisted values

This is the audit behind the settings screen. Every value the extension honours is
listed with where it lives, whether the screen reaches it, and — for a default —
what actually consumes it (so no control is inert). The configuration list is
enumerated from `package.json` → `contributes.configuration`, not from memory.

## Contributed configuration (`package.json` → `contributes.configuration`)

### Trust-sensitive keys (read from user settings only)

These keys decide where a credential is sent, which binary is spawned, or what
the permission default is. They are declared `"scope": "application"`, are read
through `inspect()` keeping only `globalValue ?? defaultValue`
(`src/config/trust.ts`), and are only ever written to the user's own settings.
A workspace `.vscode/settings.json` cannot change them.

Every spawned path is additionally checked by `src/backends/executables.ts`:
a value that is *relative* is refused, because the child runs with the
workspace as its working directory. That covers a relative path with a
separator (`./evil`, `..\evil`) **and** the Windows drive-relative form
(`C:evil.exe`, `C:`, `C:..\evil`) — the latter carries no separator, so a
separator-only rule would let it through, and Windows would resolve it against
the current directory of that drive, i.e. the workspace. A bare command name
(resolved from PATH) and a true absolute path (`C:\Tools\codex.exe`,
`C:/Tools/codex.exe`, `\\server\share\codex.exe`) are accepted.

| Key | Type / default | On the screen | Consumer |
|---|---|---|---|
| `melink.ollama.baseUrl` | string, `https://ollama.com` | **Present** — Providers → Ollama Cloud → Base URL | `OllamaClient.baseUrl` → the request URL; the token is sent only to this host |
| `melink.ollamaLocal.baseUrl` | string, `http://localhost:11434` | **Present** — Providers → Ollama Local → Base URL | `OllamaClient.baseUrl` (Local profile) → the request and `/v1` URL; no credential is sent |
| `melink.ollama.opencode.path` | string, `opencode` | **Present** — CLI → opencode CLI path | `resolveOpencodeExecutable` → the spawned command |
| `melink.ollama.opencode.cliSource` | enum, `local` | **Present** — CLI → Source | `resolveOpencodeExecutable` → the spawned command |
| `melink.codex.path` | string, `codex` | **Present** — Providers → Codex → Codex CLI path | `readTrustedCodexExecutable` → the spawned app-server command |
| `melink.skills.zvecGrep.path` | string, `zg` | **Present** — Skills → zvec-grep | `resolveZvecGrepExecutable` → the MCP command |
| `melink.skills.zvecGrep.cliSource` | enum, `local` | **Present** — Skills → zvec-grep | `resolveZvecGrepExecutable` → the MCP command |
| `melink.skills.astGrep.path` | string, `ast-grep` | **Present** — Skills → ast-grep | `resolveAstGrepExecutable` → the MCP command |
| `melink.skills.astGrep` | boolean, `false` | **Present** - Skills -> ast-grep -> Use structural search | MCP shim registration for OpenCode |
| `melink.skills.astGrep.cliSource` | enum, `local` | **Present** — Skills → ast-grep | `resolveAstGrepExecutable` → the MCP command |
| `melink.defaults.permissionLevel` | enum, `default` | **Present** — Defaults → Default permission level | `readDefaultPermissionLevel()` → `SidebarViewProvider` seeds a new thread; `CodexBackend.startThread` maps it to `approvalPolicy` + `sandbox` |

### Ordinary keys (workspace scope allowed)

| Key | Type / default | On the screen | Consumer |
|---|---|---|---|
| `melink.ollama.defaultModel` | string, *(empty)* | **Present** — Providers → Ollama Cloud → Default model | `OllamaBackend.defaultModel`, used when no model is selected |
| `melink.ollamaLocal.defaultModel` | string, *(empty)* | **Present** — Providers → Ollama Local → Default model | `OllamaBackend.defaultModel` (Local); empty resolves to the first `/api/tags` model |
| `melink.codex.defaultModel` | string, *(empty)* | **Present** — Providers → Codex → Default model | `CodexBackend.defaultModel`, used when no model is selected |
| `melink.defaults.mode` | enum, `agent` | **Present** — Defaults → Default mode | `readDefaultMode()` → `CodexBackend.startThread` applies `developerInstructions`; `agent` adds none |
| `melink.safety.destructiveCommands` | enum, `ask` (`off` / `ask` / `block`), application scope | **Not on the screen** — user `settings.json` only, so a workspace cannot turn the check off | `readSafeModeSettings()` → `safeModeDecision()` in `CodexBackend.handleServerRequest`, `OllamaBackend.decideOpencodePermission`, `OpencodeBackend.decideOpencodePermission`, before any stored-rule match |
| `melink.safety.destructivePatterns` | array, *(empty)*, application scope | **Not on the screen** — user `settings.json` only, so a workspace cannot weaken the check | `readSafeModeSettings()` → `classifyDestructiveCommand(..., patterns)`; invalid/blank patterns are ignored |
| `melink.defaults.thinking` | string, *(empty)* | **Present** — Defaults → Default thinking level | `readDefaultThinking()` → `SidebarViewProvider.appDefaults()` → model setting resolution; model-reported defaults and saved per-model choices take precedence |
| `melink.context.includeInstructions` | boolean, `true` | **Present** — Context → Included by default | `VscodeProjectContextHost.contextSettings()` → `ProjectContext.getSnapshot`; off sends no instruction documents |
| `melink.context.includeShape` | boolean, `true` | **Present** — Context → Included by default | `contextSettings()` → `ProjectContext.getSnapshot`; off sends no shape |
| `melink.context.includeEditorState` | boolean, `true` | **Present** — Context → Editor state | `contextSettings()` → `ProjectContext.buildEditor` is not called; no active-file or open-editor read |
| `melink.context.includeSelection` | boolean, `true` | **Present** — Context → Selection | `contextSettings()` → `ProjectContext.buildEditor`; off never reads the selected text |
| `melink.context.includeChangedFiles` | boolean, `true` | **Present** — Context → Included by default | `contextSettings()` → `ProjectContext.getDelta`; off omits the changed-files notice |
| `melink.context.maxBytes` | number, `20480` | **Present** — Context → Maximum context size | `contextSettings()` → `ProjectContext` overall cap and `ContextDelivery` render budget |
| `melink.context.exclude` | array, *(empty)* | **Present** — Context → Ignore patterns | `VscodeProjectContextHost.userExclude()` → `ProjectContext` glob options, additive to the built-in set |
| `melink.review.diffReview` | boolean, `false`, application scope | **Legacy fallback** - surfaced in Orchestration -> Reviewing; read only while `melink.orchestration.reviewing` is unset | `SidebarViewProvider.diffReviewEnabled()` -> `reviewFinishedTurn()` on live turn finish; off means no input is built, no runner is called, and nothing is stored |
| `melink.opencode.defaultModel` | string, *(empty)* | **Present** - Providers -> OpenCode Zen -> Default model | `buildZenOpencodeConfig` model default; empty uses the first catalog model |
| `melink.ollama.opencode.zvecGrep` | boolean, `false` | **Not on the screen** - legacy | read only when `melink.skills.zvecGrep` is unset |
| `melink.defaults.dictationModel` | string, *(empty)* | **Present** - Defaults -> Dictation model | dictation cleanup model (`provider / model`); empty disables the microphone |
| `melink.skills.browserCodex` | boolean, `true` | **Present** - Skills -> Browser -> Codex | Codex browser skill |
| `melink.skills.browserOpencode` | boolean, `true` | **Present** - Skills -> Browser -> OpenCode | OpenCode browser skill |
| `melink.skills.browser` | boolean, `true` | **Not on the screen** - legacy fallback | read only when the per-provider browser keys are unset |
| `melink.context.repoMap` | boolean, `false` | **Added by T84** — off by default; no map is built until enabled | `contextSettings()` → `ContextDelivery.repoMapForTurn`; on builds a bounded map over `shape.files`, off sends the explicit disabled marker |
| `melink.context.repoMapMaxFiles` | number, `200` | **Added by T84** | `contextSettings()` → `RepoMapCaps.maxFiles`; stops the build deterministically |
| `melink.context.repoMapMaxBytes` | number, `131072` | **Added by T84** | `contextSettings()` → `RepoMapCaps.maxBytes`; stops the build deterministically |
| `melink.context.repoMapBuildMs` | number, `750` | **Added by T84** | `contextSettings()` → `RepoMapCaps.maxBuildMs`; per-read timeout also bounds a never-resolving read |
| `melink.context.repoMapMaxChars` | number, `1200` | **Added by T84** | `contextSettings()` → `RepoMapCaps.maxChars`; bounds the rendered per-turn block |
| `melink.review.checks.enabled` | boolean, `true` | **Legacy fallback** - surfaced in Orchestration -> Testing; read only while `melink.orchestration.testing` is unset | `readWorkspaceCheckSettings()` -> `resolveCheckPlan`; off stores an off summary and spawns nothing |
| `melink.orchestration.testing` | boolean, `true` | **Present** - Orchestration -> Testing; falls back to `melink.review.checks.enabled` | `resolveOrchestrationSettings()` -> per-turn plan gate |
| `melink.orchestration.reviewing` | boolean, `false` | **Present** - Orchestration -> Reviewing; falls back to `melink.review.diffReview` | `resolveOrchestrationSettings()` -> diff-review gate |
| `melink.orchestration.doubleCheck` | boolean, `true` | **Present** - Orchestration -> Double-check | `resolveOrchestrationSettings()` -> diagnostics sweep gate |
| `melink.orchestration.quickTask` | boolean, `true` | **Present** - Orchestration -> Quick tasks | `resolveOrchestrationSettings()` -> quick-task gate |
| `melink.orchestration.planning` | boolean, `true` | **Present** - Orchestration -> Plan autopilot | `resolveOrchestrationSettings()` -> plan-autopilot gate |
| `melink.review.checks.commands` | array, *(empty)* | **Pending UI pass** - read directly by `CheckHost` | `readCheckSettingsFrom()` -> `detectDefaultChecks` when unset, explicit `[]` means run nothing |
| `melink.review.checks.timeoutSeconds` | number, `120` | **Pending UI pass** - read directly by `CheckHost` | `clampCheckTimeoutSeconds()` -> `runChecks` per-check timeout, 5-600 |

## Post-turn check state (`src/review/checkStore.ts`)

| Key | Scope | Purpose |
|---|---|---|
| `melink.review.checks` | workspace | Newest 50 check runs, keyed `backendId:threadId:turnId`; a stored `running` run is read back as `skipped` after a reload. This is state, not a setting, and it shares the name with the configuration section only by design. |
| `melink.telemetry.failureLog` | boolean, `false`, **application scope** | **Not on the screen** — VS Code Settings or the **SideCode: Record a missed issue locally** command | `createFailureLogHost()` / `recordFailureEntry()`; false keeps the command informational and touches no directory or file. Application scope means a workspace cannot opt in |

## Credentials

| Secret | Store | On the screen | Consumer / write path |
|---|---|---|---|
| `melink.ollama.token` (`OLLAMA_TOKEN_SECRET_KEY`, `src/backends/secrets.ts`) | VS Code `SecretStorage` only | **Present** — Providers → Ollama Cloud → API key (masked, empty; only `hasToken` is sent to the webview) | Bearer credential for `melink.ollama.baseUrl` requests, including the opencode runtime child env. Written by the screen and `SideCode: Set Ollama Cloud token` via `context.secrets.store`; removed with `context.secrets.delete` |
| `melink.opencode.zenToken` (`OPENCODE_ZEN_TOKEN_SECRET_KEY`, `src/backends/secrets.ts`) | VS Code `SecretStorage` only | **Present** — Providers → OpenCode Zen → Zen API key (optional, masked, empty; only `hasToken` is sent to the webview) | Paid-model Zen catalog and model requests (`OpencodeBackend`). Written by the screen and `SideCode: Set OpenCode Zen API key` via `context.secrets.store`; removed with `context.secrets.delete` |

There is no second credential store and no `settings.json` write path for either
secret. The webview read model exposes only `hasToken`, so a stored value can
never be painted into the DOM. Codex holds no SideCode credential: it signs in
through its own CLI and the screen reports that login state.

The token is sent only to `melink.ollama.baseUrl`, which is read from the
user's own settings. A workspace override of that key is ignored, so opening a
repository cannot redirect the credential to a host the user never configured.

## Workspace trust

`package.json` declares `capabilities.untrustedWorkspaces.supported =
"limited"`, the description names every restricted key, and
`restrictedConfigurations` lists the same ten keys. The manifest scope and the
code's read rule are kept in step by a contract test
(`src/config/packageContract.test.ts`): the application-scoped set in the
manifest and `TRUST_SCOPED_KEYS` in `src/config/trust.ts` must be the same
list, and so must the `restrictedConfigurations` array.

The `restrictedConfigurations` list is a host-level layer on top of the
application scope: while a workspace is untrusted, VS Code does not hand the
extension a workspace-defined value for those keys at all. The code's own rule
is stronger — a workspace value for those keys is ignored whether the
workspace is trusted or not — so the application scope is what the description
promises.

A **Save to workspace** action writes a trust-sensitive key to the user's own
settings instead, and the field carries a short notice saying so. The value is
persisted — it is not silently dropped — but it lands in the scope that is
actually read. All ten trust-sensitive fields show that notice; the list
lives in `src/config/fieldNotices.ts` and is asserted against the screen's
source by `src/config/fieldNotices.test.ts`.

## Persisted conversation state (`src/backends/threadStore.ts`)

These are conversation state, not user settings, so they are deliberately not
surfaced as settings fields; the screen's default-model picker is their
user-facing counterpart.

| Key | Scope | Purpose |
|---|---|---|
| `melink.activeThread` | workspace | The conversation to reconnect to on activation |
| `melink.threadIndex` | workspace | Per-backend thread list for history |
| `melink.transcripts` | workspace | Rendered items for replay |
| `melink.lastUsedModel` | global | Last model, so a reload reconnects to it |

## Review state (`src/review/reviewStore.ts`)

| Key | Scope | Purpose |
|---|---|---|
| `melink.review.findings` | workspace | Advisory diff-review result per `backendId:threadId:turnId`, bounded to the newest 50 turns. Read on reload; written only for a live turn when `melink.review.diffReview` is on. |

Findings are advisory only: the store never changes a Keep/Reject decision, and
a failed or timed-out review is stored as a notice rather than blocking the turn.

## Approval state (`src/backends/approvalStore.ts`)

| Key | Scope | Purpose |
|---|---|---|
| `melink.approval.globalRules` | global | `Always allow` rules, revocable from the rules panel |
| `melink.approval.sessionRules` | workspace | `Allow for this conversation` rules, cleared when the thread ends |
