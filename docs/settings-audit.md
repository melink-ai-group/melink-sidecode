# Settings audit: contributed configuration, credentials, and persisted values

This is the audit behind the settings screen. Every value the extension honours is
listed with where it lives, whether the screen reaches it, and — for a default —
what actually consumes it (so no control is inert).

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
| `melink.ollama.opencode.path` | string, `opencode` | **Present** — CLI → opencode CLI path | `resolveOpencodeExecutable` → the spawned command |
| `melink.ollama.opencode.cliSource` | enum, `local` | **Present** — CLI → Source | `resolveOpencodeExecutable` → the spawned command |
| `melink.codex.path` | string, `codex` | **Present** — Providers → Codex → Codex CLI path | `readTrustedCodexExecutable` → the spawned app-server command |
| `melink.skills.zvecGrep.path` | string, `zg` | **Present** — Skills → zvec-grep | `resolveZvecGrepExecutable` → the MCP command |
| `melink.skills.zvecGrep.cliSource` | enum, `local` | **Present** — Skills → zvec-grep | `resolveZvecGrepExecutable` → the MCP command |
| `melink.skills.astGrep.path` | string, `ast-grep` | **Present** — Skills → ast-grep | `resolveAstGrepExecutable` → the MCP command |
| `melink.skills.astGrep.cliSource` | enum, `local` | **Present** — Skills → ast-grep | `resolveAstGrepExecutable` → the MCP command |
| `melink.defaults.permissionLevel` | enum, `default` | **Present** — Defaults → Default permission level | `readDefaultPermissionLevel()` → `SidebarViewProvider` seeds a new thread; `CodexBackend.startThread` maps it to `approvalPolicy` + `sandbox` |

### Ordinary keys (workspace scope allowed)

| Key | Type / default | On the screen | Consumer |
|---|---|---|---|
| `melink.ollama.defaultModel` | string, *(empty)* | **Present** — Providers → Ollama Cloud → Default model | `OllamaBackend.defaultModel`, used when no model is selected |
| `melink.codex.defaultModel` | string, *(empty)* | **Present** — Providers → Codex → Default model | `CodexBackend.defaultModel`, used when no model is selected |
| `melink.defaults.mode` | enum, `agent` | **Present** — Defaults → Default mode | `readDefaultMode()` → `CodexBackend.startThread` applies `developerInstructions`; `agent` adds none |
| `melink.defaults.thinking` | string, *(empty)* | **Present** — Defaults → Default thinking level | `readDefaultThinking()` → `SidebarViewProvider.appDefaults()` → model setting resolution; model-reported defaults and saved per-model choices take precedence |
| `melink.context.includeInstructions` | boolean, `true` | **Present** — Context → Included by default | `VscodeProjectContextHost.contextSettings()` → `ProjectContext.getSnapshot`; off sends no instruction documents |
| `melink.context.includeShape` | boolean, `true` | **Present** — Context → Included by default | `contextSettings()` → `ProjectContext.getSnapshot`; off sends no shape |
| `melink.context.includeEditorState` | boolean, `true` | **Present** — Context → Editor state | `contextSettings()` → `ProjectContext.buildEditor` is not called; no active-file or open-editor read |
| `melink.context.includeSelection` | boolean, `true` | **Present** — Context → Selection | `contextSettings()` → `ProjectContext.buildEditor`; off never reads the selected text |
| `melink.context.includeChangedFiles` | boolean, `true` | **Present** — Context → Included by default | `contextSettings()` → `ProjectContext.getDelta`; off omits the changed-files notice |
| `melink.context.maxBytes` | number, `20480` | **Present** — Context → Maximum context size | `contextSettings()` → `ProjectContext` overall cap and `ContextDelivery` render budget |
| `melink.context.exclude` | array, *(empty)* | **Present** — Context → Ignore patterns | `VscodeProjectContextHost.userExclude()` → `ProjectContext` glob options, additive to the built-in set |
| `melink.review.diffReview` | boolean, `false`, application scope | **Not on the screen** - opt in through Settings JSON only | `SidebarViewProvider.diffReviewEnabled()` -> `reviewFinishedTurn()` on live turn finish; off means no input is built, no runner is called, and nothing is stored |

## Credentials

| Secret | Store | On the screen | Write path |
|---|---|---|---|
| `melink.ollama.token` (`OLLAMA_TOKEN_SECRET_KEY`, `src/backends/secrets.ts`) | VS Code `SecretStorage` only | **Present** — Providers → Ollama Cloud → API key (masked, empty; only `hasToken` is sent to the webview) | `context.secrets.store` / `context.secrets.delete`, the same helper the contributed commands use |

There is no second credential store and no `settings.json` write path for the
token. The webview read model exposes only `hasToken`, so the stored value can
never be painted into the DOM.

The token is sent only to `melink.ollama.baseUrl`, which is read from the
user's own settings. A workspace override of that key is ignored, so opening a
repository cannot redirect the credential to a host the user never configured.

## Workspace trust

`package.json` declares `capabilities.untrustedWorkspaces.supported =
"limited"`, the description names every restricted key, and
`restrictedConfigurations` lists the same nine keys. The manifest scope and the
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
actually read. All nine trust-sensitive fields show that notice; the list
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
