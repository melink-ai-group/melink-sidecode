# Settings audit: contributed configuration, credentials, and persisted values

This is the audit behind the settings screen. Every value the extension honours is
listed with where it lives, whether the screen reaches it, and — for a default —
what actually consumes it (so no control is inert). The configuration list is
enumerated from `package.json` → `contributes.configuration`, not from memory.

## Contributed configuration (`package.json` → `contributes.configuration`)

| Key | Type / default | On the screen | Consumer |
|---|---|---|---|
| `melink.ollama.baseUrl` | string, `https://ollama.com` | **Present** — Providers → Ollama Cloud → Base URL | `OllamaBackend.baseUrl`, read per request; the token is sent only to this host |
| `melink.ollama.defaultModel` | string, *(empty)* | **Present** — Providers → Ollama Cloud → Default model | `OllamaBackend.defaultModel`, used when no model is selected |
| `melink.opencode.defaultModel` | string, *(empty)* | **Present** — Providers → OpenCode Zen → Default model | `OpencodeBackend.defaultModel`; empty uses the first model the app's catalog shows (free list without a key, full live list with one) |
| `melink.ollama.opencode.enabled` | boolean, `true` | **Present** — CLI → Use opencode for Ollama turns | `OllamaBackend.opencodeEnabled`; gates the runtime, `permissionLevels`, and `hasApprovalChannel` |
| `melink.ollama.opencode.path` | string, `opencode` | **Present** — CLI → opencode CLI path | `resolveOpencodeExecutable`, when `cliSource` is `local` |
| `melink.ollama.opencode.cliSource` | enum, `local` | **Present** — CLI → opencode CLI source | `readOpencodeCliSource` / the shared CLI resolver (local or bundled) |
| `melink.ollama.opencode.zvecGrep` | boolean, `false` | **Legacy fallback** — read by Skills → zvec-grep only when `melink.skills.zvecGrep` is unset; no separate control | `SettingsService.zvecEnabled` fallback |
| `melink.codex.path` | string, `codex` | **Present** — Providers → Codex → Codex CLI path | `CodexBackend` spawn path, resolved from `PATH` when bare |
| `melink.codex.defaultModel` | string, *(empty)* | **Present** — Providers → Codex → Default model | `CodexBackend.defaultModel`, used when no model is selected |
| `melink.defaults.permissionLevel` | enum, `default` | **Present** — Defaults → Default permission level | `readDefaultPermissionLevel()` → `SidebarViewProvider` seeds a new thread; the adapter maps it to its native permission fields |
| `melink.defaults.mode` | enum, `agent` | **Present** — Defaults → Default mode | `readDefaultMode()` → the adapter applies mode instructions at thread start; `agent` leaves the provider default |
| `melink.defaults.thinking` | string, *(empty)* | **Present** — Defaults → Default thinking level | `readDefaultThinking()` → `SidebarViewProvider.appDefaults()` → model setting resolution; model-reported defaults and saved per-model choices take precedence |
| `melink.defaults.dictationModel` | string, *(empty)* | **Present** — Defaults → Dictation model | Dictation controller / target (`provider\|model`); cleans dictated text only, never answers; empty disables the microphone |
| `melink.context.includeInstructions` | boolean, `true` | **Present** — Context → instruction documents | `VscodeProjectContextHost.contextSettings()` → `ProjectContext.getSnapshot`; off sends no instruction documents |
| `melink.context.includeShape` | boolean, `true` | **Present** — Context → project shape | `contextSettings()` → `ProjectContext.getSnapshot`; off sends no shape |
| `melink.context.includeEditorState` | boolean, `true` | **Present** — Context → editor state | `contextSettings()` → `ProjectContext.buildEditor` is not called; no active-file or open-editor read |
| `melink.context.includeSelection` | boolean, `true` | **Present** — Context → selection | `contextSettings()` → `ProjectContext.buildEditor`; off never reads the selected text |
| `melink.context.includeChangedFiles` | boolean, `true` | **Present** — Context → changed files | `contextSettings()` → `ProjectContext.getDelta`; off omits the changed-files notice |
| `melink.context.maxBytes` | number, `20480` | **Present** — Context → Maximum context size | `contextSettings()` → `ProjectContext` overall cap and `ContextDelivery` render budget |
| `melink.context.exclude` | array, *(empty)* | **Present** — Context → Ignore patterns | `VscodeProjectContextHost.userExclude()` → `ProjectContext` glob options, additive to the built-in set |
| `melink.skills.browserCodex` | boolean, `true` | **Present** — Skills → Browser → Codex | `browserSkillEnabledFor('codex')`; when off Codex gets no browser tools |
| `melink.skills.browserOpencode` | boolean, `true` | **Present** — Skills → Browser → OpenCode | `browserSkillEnabledFor('opencode')`; applies to the Ollama agentic runtime and OpenCode Zen |
| `melink.skills.browser` | boolean, `true` | **Legacy fallback** — read by Skills → Browser only when the per-provider keys are unset; no separate control | `browserSkillEnabledFor` fallback via `configuredSettingValue` |
| `melink.skills.zvecGrep` | boolean, `false` | **Present** — Skills → zvec-grep → Use semantic search | `SettingsService.setZvecGrep` / `applyZvecGrep`; writes or removes the absolute-path MCP entry and leaves the CLI installed |
| `melink.skills.zvecGrep.cliSource` | enum, `local` | **Present** — Skills → zvec-grep → CLI source | `readZvecGrepCliSource` (local or bundled) |
| `melink.skills.zvecGrep.path` | string, `zg` | **Present** — Skills → zvec-grep → CLI path | `resolveZvecGrepExecutable`, when `cliSource` is `local` |
| `melink.skills.astGrep` | boolean, `false` | **Present** — Skills → ast-grep → Use structural search | `SettingsService.setAstGrep` / `applyAstGrep`; writes or removes the `ast_grep` MCP entry |
| `melink.skills.astGrep.cliSource` | enum, `local` | **Present** — Skills → ast-grep → CLI source | `readAstGrepCliSource` (local or bundled) |
| `melink.skills.astGrep.path` | string, `ast-grep` | **Present** — Skills → ast-grep → CLI path | `resolveAstGrepExecutable`, when `cliSource` is `local` |

## Credentials

| Secret | Store | On the screen | Consumer / write path |
|---|---|---|---|
| `melink.ollama.token` (`OLLAMA_TOKEN_SECRET_KEY`, `src/backends/secrets.ts`) | VS Code `SecretStorage` only | **Present** — Providers → Ollama Cloud → API key (masked, empty; only `hasToken` is sent to the webview) | Bearer credential for `melink.ollama.baseUrl` requests, including the opencode runtime child env. Written by the screen and `SideCode: Set Ollama Cloud token` via `context.secrets.store`; removed with `context.secrets.delete` |
| `melink.opencode.zenToken` (`OPENCODE_ZEN_TOKEN_SECRET_KEY`, `src/backends/secrets.ts`) | VS Code `SecretStorage` only | **Present** — Providers → OpenCode Zen → Zen API key (optional, masked, empty; only `hasToken` is sent to the webview) | Paid-model Zen catalog and model requests (`OpencodeBackend`). Written by the screen and `SideCode: Set OpenCode Zen API key` via `context.secrets.store`; removed with `context.secrets.delete` |

There is no second credential store and no `settings.json` write path for either
secret. The webview read model exposes only `hasToken`, so a stored value can
never be painted into the DOM. Codex holds no SideCode credential: it signs in
through its own CLI and the screen reports that login state.

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

## Approval state (`src/backends/approvalStore.ts`)

| Key | Scope | Purpose |
|---|---|---|
| `melink.approval.globalRules` | global | `Always allow` rules, revocable from the rules panel |
| `melink.approval.sessionRules` | workspace | `Allow for this conversation` rules, cleared when the thread ends |
