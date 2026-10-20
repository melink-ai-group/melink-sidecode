# Settings audit: contributed configuration, credentials, and persisted values

This is the audit behind the settings screen. Every value the extension honours is
listed with where it lives, whether the screen reaches it, and — for a default —
what actually consumes it (so no control is inert).

## Contributed configuration (`package.json` → `contributes.configuration`)

| Key | Type / default | On the screen | Consumer |
|---|---|---|---|
| `melink.ollama.baseUrl` | string, `https://ollama.com` | **Present** — Providers → Ollama Cloud → Base URL | `OllamaBackend.baseUrl`, read per request |
| `melink.ollama.defaultModel` | string, *(empty)* | **Present** — Providers → Ollama Cloud → Default model | `OllamaBackend.defaultModel`, used when no model is selected |
| `melink.codex.path` | string, `codex` | **Present** — Providers → Codex → Codex CLI path | `CodexBackend.executable`, used to spawn the CLI |
| `melink.codex.defaultModel` | string, *(empty)* | **Present** — Providers → Codex → Default model | `CodexBackend.defaultModel`, used when no model is selected |
| `melink.defaults.permissionLevel` | enum, `default` | **Added by this ticket** — Defaults → Default permission level | `readDefaultPermissionLevel()` → `SidebarViewProvider` seeds a new thread; `CodexBackend.startThread` maps it to `approvalPolicy` + `sandbox` |
| `melink.defaults.mode` | enum, `agent` | **Added by this ticket** — Defaults → Default mode | `readDefaultMode()` → `CodexBackend.startThread` applies `developerInstructions`; `agent` adds none |
| `melink.defaults.thinking` | string, *(empty)* | **Present** — Defaults → Default thinking level | `readDefaultThinking()` → `SidebarViewProvider.appDefaults()` → model setting resolution; model-reported defaults and saved per-model choices take precedence |
| `melink.context.includeInstructions` | boolean, `true` | **Added by this ticket** — Context → Included by default | `VscodeProjectContextHost.contextSettings()` → `ProjectContext.getSnapshot`; off sends no instruction documents |
| `melink.context.includeShape` | boolean, `true` | **Added by this ticket** — Context → Included by default | `contextSettings()` → `ProjectContext.getSnapshot`; off sends no shape |
| `melink.context.includeEditorState` | boolean, `true` | **Added by this ticket** — Context → Editor state | `contextSettings()` → `ProjectContext.buildEditor` is not called; no active-file or open-editor read |
| `melink.context.includeSelection` | boolean, `true` | **Added by this ticket** — Context → Selection | `contextSettings()` → `ProjectContext.buildEditor`; off never reads the selected text |
| `melink.context.includeChangedFiles` | boolean, `true` | **Added by this ticket** — Context → Included by default | `contextSettings()` → `ProjectContext.getDelta`; off omits the changed-files notice |
| `melink.context.maxBytes` | number, `20480` | **Added by this ticket** — Context → Maximum context size | `contextSettings()` → `ProjectContext` overall cap and `ContextDelivery` render budget |
| `melink.context.exclude` | array, *(empty)* | **Added by this ticket** — Context → Ignore patterns | `VscodeProjectContextHost.userExclude()` → `ProjectContext` glob options, additive to the built-in set |
| `melink.review.checks.enabled` | boolean, `true` | **Pending UI pass** - read directly by `CheckHost`; the review panel will show the state | `readWorkspaceCheckSettings()` -> `resolveCheckPlan`; off stores an off summary and spawns nothing |
| `melink.review.checks.commands` | array, *(empty)* | **Pending UI pass** - read directly by `CheckHost` | `readCheckSettingsFrom()` -> `detectDefaultChecks` when unset, explicit `[]` means run nothing |
| `melink.review.checks.timeoutSeconds` | number, `120` | **Pending UI pass** - read directly by `CheckHost` | `clampCheckTimeoutSeconds()` -> `runChecks` per-check timeout, 5-600 |

## Post-turn check state (`src/review/checkStore.ts`)

| Key | Scope | Purpose |
|---|---|---|
| `melink.review.checks` | workspace | Newest 50 check runs, keyed `backendId:threadId:turnId`; a stored `running` run is read back as `skipped` after a reload. This is state, not a setting, and it shares the name with the configuration section only by design. |

## Credentials

| Secret | Store | On the screen | Write path |
|---|---|---|---|
| `melink.ollama.token` (`OLLAMA_TOKEN_SECRET_KEY`, `src/backends/secrets.ts`) | VS Code `SecretStorage` only | **Present** — Providers → Ollama Cloud → API key (masked, empty; only `hasToken` is sent to the webview) | `context.secrets.store` / `context.secrets.delete`, the same helper the contributed commands use |

There is no second credential store and no `settings.json` write path for the
token. The webview read model exposes only `hasToken`, so the stored value can
never be painted into the DOM.

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
