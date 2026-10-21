# Using SideCode

A tour of what the sidebar does and how to drive it. For installation, see the
[README](../README.md).

## Opening a chat

Click the **SideCode** icon in the Activity Bar, or run **View: Show SideCode** from the
Command Palette. Each conversation is a tab in the sidebar. A new tab is named
**SideCode** until you send a message; the tab is then renamed to a short truncation
of that message. **+** opens another sidebar tab (an unused SideCode tab is focused
instead of stacking a second blank one). History opens a chat in a new sidebar tab, or
focuses that tab when it is already open.

## The layout at a glance

```
+--------------------------------------------------+
| SideCode | Fix the login            x   [+][history] |
+--------------------------------------------------+
| Model  <provider> <model> v          [context][cog] |
+--------------------------------------------------+
|                                                  |
|   transcript: your turns, agent replies,         |
|   command cards, diffs, notices                  |
|                                                  |
+--------------------------------------------------+
| [ ask the agent...                          ]    |
| [attach]                             [ Send ]    |
+--------------------------------------------------+
```

The view title, from left to right, is **Refresh project context**, **Refresh
backend availability**, and the settings gear. On the tab row, conversation
history sits to the left of the primary **+** new-chat button, which is the
rightmost control. History is a searchable list (title and model) that still
shows Busy and Unread. Drag a tab to reorder it.

## Providers

The sidebar can talk to two providers, independently:

- **Ollama Cloud** — hosted models, needs a token.
- **OpenAI Codex CLI** — the local `codex` CLI, needs the CLI installed and signed in.
There are four possible states per provider:

| State | Meaning |
|---|---|
| **available** | Usable now; its models appear in the picker. |
| **unauthenticated** | Runs, but has no usable credential. Shown with a **Set token** action (Ollama) or a jump to settings (Codex). |
| **incompatible** | Runs, but reports a protocol version outside the range this build supports (pin: `codex-cli 0.156.1`, window `0.154.0–0.163.x`). Shown with the version and an **Open settings** action, so a CLI update that breaks Codex is diagnosable instead of silent. |
| **unavailable** | Cannot run at all (e.g. the Codex CLI is not installed). Hidden entirely — never rendered as broken. |

**Providers are isolated.** If one provider is missing, unauthenticated, or
incompatible, it cannot block the other and produces no error noise in the
transcript. When at least one provider is available, only available providers are
listed in the picker; the others are surfaced only when they are the whole story,
so the picker is never empty.

### opencode agentic runtime

Ollama Cloud runs through [opencode](https://opencode.ai) by default, so those
models can read the project, edit files, and run commands. Turning
**`melink.ollama.opencode.enabled`** off uses the direct streaming adapter
instead: it answers in the transcript but cannot edit files, run commands, or
keep a tool-driven session. **Settings → CLI** chooses a CLI source: **Local machine**
(path / PATH) or **Bundled** (extension global storage; survives closing VS Code).
When the CLI is not detected, **Install opencode** downloads the current GitHub
release into that source's install directory. When opencode is already connected,
**Update opencode** re-downloads the same way (it does not run `opencode upgrade`,
which can leave a custom install on an old version).

- **Identity is unchanged.** There is still one **Ollama Cloud** provider with
  the same badge and dot; opencode is a runtime behind it, not a new provider.
- **Models are the same list.** The runtime is pointed at exactly the models
  `GET /api/tags` returns, against the configured `melink.ollama.baseUrl`.
- **Streaming is the same experience.** Events are parsed as they arrive into
  the same transcript. (The installed opencode version emits whole message parts
  rather than token deltas, so a part appears when it completes.)
- **Sessions resume.** A second message in the same conversation continues the
  same opencode session. If that session is gone, a fresh one starts and a
  notice says so.
- **Modes and permissions.** With the runtime on, all three modes and all three
  permission levels become available. Each turn defines a freshly named,
  generated opencode agent with `disable: false`, the `task` tool off, and the
  selected permission as an agent property. A workspace `opencode.json` is still
  loaded for its MCP servers, skills, and other project settings, but the inline
  definition wins on overlapping keys: a workspace cannot disable our agent or
  fall back to `build` and `agent.build.permission` cannot widen the turn. A
  workspace-defined subagent is not callable because `task` is denied. Project
  plugins and remote `instructions` URLs are a separate, pre-existing concern and
  are not isolated by this fix. `plan` still honors the selected level; `ask`
  uses a read-only agent that cannot run commands, write, fetch the web, or
  delegate. Read-only and Ask deny edits, commands, external directories,
  webfetch, websearch, and subagent delegation. `default` asks before every edit,
  write, patch, command, external directory, webfetch, and websearch, and denies
  delegation; `unrestricted` (which the UI gates behind a labelled confirmation)
  allows them. opencode's own enforcement backs ours; it never replaces it. When
  a `default` turn hits an `ask`, the sidebar pauses and shows its approval card
  until you decide; a rejection is reported back to the agent instead of being
  silently auto-allowed.
- **Turn it off to fall back.** With the setting off, the direct `/api/chat`
  adapter is used unchanged and no opencode process is started.

If the `opencode` CLI is not installed (or `melink.ollama.opencode.path` does
not resolve), the turn reports a distinct, actionable notice — the missing CLI,
a spawn failure, a rejected generated config, and a rejected token each read
differently — and never blocks the direct path.

You can set all of this from **SideCode: Open settings** without editing JSON: the
Ollama region carries a **Use opencode as the agentic runtime** switch (off by
default) and, while it is on, an **opencode CLI path** field. The status line
shows one of three distinct states — detected (with the CLI version), missing or
not runnable, and off — and an invalid path is refused inline without
overwriting a previously stored valid one. While the runtime is on, the
**Skills** tab configures **ast-grep** (structural search/rewrite) and
**zvec-grep** (semantic + keyword search). Each skill has a local or bundled
CLI source (bundled lives under extension global storage, like opencode).
Turning a skill on installs the CLI when needed, writes an absolute-path MCP
entry into your user OpenCode config, and injects that server into SideCode
turns. Turning it off removes the MCP entry and leaves the CLI installed.


## Choosing a model

Click the **Model** trigger in the title bar. This opens a floating panel over
the chat with a bounded height and its own scrolling list. It contains:

- **One group per available provider**, each with its own provider badge and dot.
- **A live model list** fetched from that provider. For Ollama Cloud this is
  exactly `GET /api/tags` — no hardcoded fallback. Codex lists the models the
  local CLI reports.
- **A filter box** to narrow long lists by name.
- **Per-provider entries** for a provider that is not signed in, with a **Set
  token** button.

Selecting a model sets the check mark and updates the trigger label. Switching
applies to your **next message**; the current conversation is kept. The trigger
shows the selected provider's dot (blue for Ollama Cloud, neutral for Codex).

If a model list fails to load, the group shows an error with a **Retry** action
instead of spinning forever.

## Sending a message

- Type in the composer and press **Enter**, or click **Send**.
- **Shift+Enter** inserts a newline.
- The composer is disabled while restoring a conversation or when no backend is
  available (the placeholder reads *"No backend available"*).
- While a reply streams, **Send** is replaced by **Stop**, which cancels the
  in-flight turn. A canceled turn keeps whatever was already generated and is
  marked *Stopped*, not as an error.

An empty chat shows the meLink mark and the name **meLink SideCode**. The composer
opens tall so the first message has room to be written.

### Automatic mode selection

The host recognizes explicit plan requests and direct workspace action requests
before sending a turn. It can switch automatically to Plan; Ask remains a manual
choice in the mode selector. Switching to a mode that permits more activity
asks first in the sidebar; choose **Switch and continue** to send the original
request under that mode, or **Stay in** the current mode to send without
switching. Closing the dialog keeps the selected mode. Ambiguous requests keep
the current mode, and unsupported modes are never selected.

## Reading the transcript

Agent replies render as **Markdown**, with a streaming caret while text arrives
and a copy button on code blocks. Alongside messages you may see:

- **Command cards** — a command or tool invocation the agent ran, with a status
  chip (*Running* → *Passed*).
- **File-change cards** — edited files with `+/-` stats and an inline diff.
- **Reasoning** — the model's reasoning text, when the provider emits it.
- **Approval cards** — a decision the agent is waiting on. The turn stays paused
  until you choose **Allow once**, **Allow for this conversation**, **Always
  allow**, or **Reject**; nothing is decided for you on a timeout. See below.
- **Notices** — see below.

Every agent turn shows the provider dot it came from, so a mixed-provider
conversation is easy to read.

## Conversations

- **Conversation history** (the clock icon on the tab row) opens a searchable list
  of recent conversations for the active provider, newest first, with a title
  taken from the first user turn, the model it used, and Busy / Unread when
  those apply. Choosing one opens that conversation in a new sidebar tab, or
  focuses the tab when it is already open.
- **New chat** (the primary `+` button, the rightmost control on the tab row)
  opens another sidebar tab. It does not clear the tab you are in. An unused
  SideCode tab is focused instead of opening a second blank one. Drag a tab to
  change the order.

### Reload resume

Reloading the window **reopens the sidebar tabs** that were open. Each tab
restores its own conversation: a brief *"Restoring conversation…"* status clears
and the prior turns repaint. A tab that never sent a message comes back as
SideCode. If a thread is no longer available, that tab shows a notice and stays
usable.

For Ollama Cloud, replaying the stored turns against the stateless `/api/chat`
*is* the resume: the next turn is sent with the conversation's context. For
Codex, the CLI's own thread store is authoritative and is replayed on resume.

## Notices and recovery

Notices appear above the composer with a plain-language message and, where
useful, an action:

| Situation | Notice | Action |
|---|---|---|
| Ollama token rejected/expired | *Needs attention* | **Set token** |
| Network or mid-stream drop | *Needs attention* | **Refresh backends** |
| Provider error | *Something went wrong* | **Retry** |
| User canceled a turn | *Response stopped* | — |
| Stale conversation on reload | *The previous conversation could not be restored…* | — |

The view title, from left to right, is **Refresh project context** (rebuilds the
workspace snapshot for the next turn), **Refresh backend availability** (re-probes
every provider and drops cached model lists, so a model added or removed on the
server shows up after a refresh), and the **gear**, which opens the extension's
settings (**SideCode: Open settings**).

## Commands

| Command | What it does |
|---|---|
| **SideCode: Set Ollama Cloud token** | Prompt for the bearer token, store it in secret storage. |
| **SideCode: Clear Ollama Cloud token** | Delete the stored token. |
| **SideCode: Refresh project context** | Rebuild the project context snapshot for the next turn. |
| **SideCode: Refresh backend availability** | Re-probe both providers. |
| **SideCode: Open settings** | Open the inline settings screen. |

## Settings reference

| Setting | Default | Purpose |
|---|---|---|
| `melink.ollama.baseUrl` | `https://ollama.com` | Base URL for the Ollama Cloud API. The token is sent only to this host. |
| `melink.ollama.defaultModel` | *(empty)* | Default Ollama model; empty uses the first model reported. |
| `melink.ollama.opencode.enabled` | `true` | Run Ollama Cloud turns through the opencode agentic runtime (tool execution, file edits, session resume). Off uses the direct `/api/chat` adapter and spawns no opencode process. |
| `melink.ollama.opencode.cliSource` | `local` | `local` uses the path / PATH; `bundled` uses the SideCode download in extension global storage (survives closing VS Code). |
| `melink.ollama.opencode.path` | `opencode` | Path to the `opencode` CLI when `cliSource` is `local`; a bare name is resolved from `PATH`. Ignored when bundled. |
| `melink.ollama.opencode.zvecGrep` | `false` | Connect zvec-grep to OpenCode. Turning it on installs the `zg` CLI when it is missing (Node.js 22+) and runs `zg install --target opencode`. Turning it off runs `zg uninstall --target opencode` and leaves the CLI and workspace indexes in place. Stored in user settings. A new OpenCode session picks up the change. |
| `melink.skills.browserCodex` | `true` | Let Codex open a browser tab in the editor to check layout. |
| `melink.skills.browserOpencode` | `true` | Let OpenCode open a browser tab in the editor to check layout. |
| `melink.codex.path` | `codex` | Path to the Codex CLI executable; a bare name is resolved from `PATH`. |
| `melink.codex.defaultModel` | *(empty)* | Default model for Codex; empty uses the CLI default. |
| `melink.defaults.permissionLevel` | `default` | Permission level for a new conversation (`read-only` / `default` / `unrestricted`). A per-conversation choice overrides it; `unrestricted` must be confirmed. |
| `melink.defaults.mode` | `agent` | Starting mode for a new conversation (`agent` / `plan` / `ask`). `plan` and `ask` are applied to the Codex thread as developer instructions at thread start; `agent` leaves the CLI default. |
| `melink.defaults.thinking` | *(empty)* | App-level thinking level when a model has no reported default; model-level overrides take precedence. |
| `melink.context.includeInstructions` | `true` | Include instruction documents (`AGENTS.md`, `README.md`, `.github/copilot-instructions.md`) in the snapshot. |
| `melink.context.includeShape` | `true` | Include project shape (languages, directory tree, manifests) in the snapshot. |
| `melink.context.includeEditorState` | `true` | Follow the active file and open editors. When off, no active-file path, language, or open-editor list is read or sent, and the composer strip names no current file. |
| `melink.context.includeSelection` | `true` | Quote the current selection. When off, the selected text is never read. Selected text is sent verbatim. |
| `melink.context.includeChangedFiles` | `true` | Include the changed-files notice in the per-turn delta. |
| `melink.context.maxBytes` | `20480` | Overall byte cap for a rendered snapshot. When it is reached, categories truncate in order: open editors, then instruction documents, then the tree. |
| `melink.context.exclude` | *(empty)* | Extra glob patterns excluded from the project context snapshot, on top of the built-in ignore set and `files.exclude`/`search.exclude`. |
| `melink.review.checks.enabled` | `true` | Run post-turn checks after a turn that changed files. Off skips them entirely; an untrusted workspace is always skipped. |
| `melink.review.checks.commands` | *(empty)* | Explicit commands to run. Empty means auto-detect `typecheck` (falling back to `lint`) and `test` from `package.json`; an explicitly saved empty list turns checks off. |
| `melink.review.checks.timeoutSeconds` | `120` | Per-check timeout in seconds, clamped to 5–600. A timed-out check is killed and reported as timed out. |
| `melink.context.repoMap` | `false` (off) | Include a bounded per-turn symbol/import map built from the files the snapshot already accepted. Off sends only an explicit disabled marker. |
| `melink.context.repoMapMaxFiles` | `200` | Maximum source files the repository map may read in one build. |
| `melink.context.repoMapMaxBytes` | `131072` | Maximum bytes the repository map may read in one build. |
| `melink.context.repoMapBuildMs` | `750` | Wall-clock budget for one repository-map build; a slow read times out. |
| `melink.context.repoMapMaxChars` | `1200` | Character cap for the rendered per-turn repository-map block. |

The `melink.review.checks.*` values are read directly by the post-turn check host.
The inline settings screen does not yet expose controls for them. The review
panel's collapsed header shows the run summary and expanding it lists one row per
check with its status word, duration, and any bounded failure detail or skipped
reason.

The same settings are reachable from the in-product **settings screen**
(gear icon in the title bar), which opens inline in the sidebar rather than as a
separate window. It groups **Providers** (Ollama base URL, masked API key with
Save/Clear, Codex CLI path and login state) above **Defaults** (default model,
permission level, mode), and offers **Test connection** per provider. A value
that fails validation shows an inline message and is not saved.

### Which settings a workspace may set

A repository can ship a `.vscode/settings.json`, and VS Code merges it over
your own settings. SideCode does not let a repository decide the three things
that would make opening a folder a security problem, so those settings are
**read from your user settings only** and are declared
`"scope": "application"`:

| Setting | Why it is user-scope only |
|---|---|
| `melink.ollama.baseUrl` | The Ollama Cloud bearer token is sent to this host. A workspace must not be able to redirect it. |
| `melink.ollama.opencode.path`, `melink.ollama.opencode.cliSource` | The binary a turn spawns. The child runs with the workspace as its working directory. |
| `melink.codex.path` | The Codex CLI binary a turn spawns. |
| `melink.skills.zvecGrep.path`, `melink.skills.zvecGrep.cliSource` | The `zg` binary the search skill spawns. |
| `melink.skills.astGrep.path`, `melink.skills.astGrep.cliSource` | The `ast-grep` binary the search skill spawns. |
| `melink.defaults.permissionLevel` | The permission a new conversation starts with. A workspace must not be able to raise it to `unrestricted`. |

A workspace value for one of these is ignored even if it was written before
this restriction, and the **Save to workspace** action writes these to your
user settings instead, with a short note on the field. Every one of the nine
fields shows that note. Every other SideCode setting (model names, context
toggles, skill flags) keeps its normal workspace-scope behaviour.

Two further rules apply to the CLI paths, because they name the binary that
runs: a **relative path** is refused — it would resolve inside the workspace —
and a **bare command name** (`codex`, `opencode`) is resolved from `PATH`.

"Relative" covers both shapes:

- a relative path with a separator (`./evil`, `..\evil`, `bin/codex`); and
- the Windows **drive-relative** form (`C:evil.exe`, `C:`, `C:..\evil`). It
  carries no separator, so a separator-only rule would let it through — but
  Windows resolves it against the current directory *of that drive*, which is
  the workspace for a child spawned with it as the working directory. So
  `C:evil.exe` would run `workspace\evil.exe`.

A true absolute path (`C:\Tools\codex.exe`, `C:/Tools/codex.exe`,
`\\server\share\codex.exe`) is used as-is. The same rule applies to the
settings screen's status probes, so a refused value is never launched by the
probe either.

The extension also declares `capabilities.untrustedWorkspaces` as `limited`, so
VS Code can mark a workspace as untrusted and warn before a repository's
settings reach an extension at all. The same nine keys are listed in
`restrictedConfigurations`, so an untrusted workspace does not hand VS Code a
workspace-defined value for them at all.

## The settings screen

Open it from the gear in the title bar (or **SideCode: Open settings**). It opens
inline in the sidebar — the same panel pattern as the model switcher, never a
floating popover — and groups the settings as **Providers** above **Defaults**.

**Providers**

- **Ollama Cloud** — base URL, and an API key input. The input is always masked
  and empty; it shows a masked placeholder plus a **Key stored** / **No key**
  chip so you can tell whether a key exists without the value ever being shown.
  **Save key** writes a new value, **Clear key** removes it, and both go only to
  VS Code secret storage (see [Credentials](#credentials)).
- **Codex** — the CLI path override and the current login state, one sentence
  each about what they affect.
- **Test connection** — runs a real authenticated call and reports the outcome
  in plain language: a rejected key, an unreachable host, and a network problem
  read differently, so a wrong key is distinguishable from a wrong base URL. A
  failure never prints a raw stack trace or the key.

**Defaults** — the default model, permission level, and mode for a new
conversation. The app-level thinking choice applies when a model has no reported
default; a saved per-model choice takes precedence.

**Context** — what the agent is told about this workspace before your first
message. Each category (instruction documents, project shape, editor state,
current selection, changed files) can be turned off by default, and every change
applies from the next turn. Turning off **editor state** means the agent knows
the project but not the current page: no active-file path, language, or
open-editor list is read or sent, and the composer strip stops naming a current
file. **Selection** has its own control and an explicit note that selected text
is sent verbatim, so it is quoted only when you say so. **Maximum context size**
is editable with the resolved default shown beside it, and the panel states the
truncation order used when the cap is reached. **Ignore patterns** are additive:
the panel lists the built-in set for reference and lets you add extra glob
patterns, which are validated inline and marked "not saved" rather than silently
ignored. The panel states that these are workspace defaults and that the composer
can narrow them for a single turn; no per-turn action widens them.

Validation is on demand: a value that fails (for example a base URL without a
scheme) shows an inline message and is **not** persisted. Unsaved changes are
never applied to a turn already in progress.

**Save to workspace** writes to this repository's `.vscode/settings.json`. The
trust-sensitive settings (the credential host, the CLI paths and the permission
default) are always written to your **user** settings instead, and the field
carries a short note saying so — the value is persisted, just in the scope that
is actually read.

**Context** settings apply from the **next turn** of the current conversation:
saving any of them (or changing a `melink.context` value outside the screen)
re-primes the open thread, so its next turn is rebuilt from the new include flags,
cap, and patterns instead of re-sending an earlier snapshot. In particular,
turning editor state or selection sharing off drops active-file and selected-text
content from the next turn's payload, not just from a new conversation. A
stateful CLI session that already consumed an earlier snapshot keeps what it was
already given (a live session cannot un-receive it), but no further active-file
or selected-text content is sent, and the corrected snapshot is delivered when
the session is next primed. The other defaults (model, permission level, mode) are
read when a conversation starts, so they take effect on the next conversation.

### Audit: every contributed setting and stored credential

| Configuration key / credential | Default | On the settings screen |
|---|---|---|
| `melink.review.checks.enabled` | `true` | Not yet on the screen - read by the post-turn check host |
| `melink.review.checks.commands` | *(empty)* | Not yet on the screen - explicit commands; empty means auto-detect |
| `melink.review.checks.timeoutSeconds` | `120` | Not yet on the screen - per-check timeout, clamped 5-600 |
| `melink.ollama.baseUrl` | `https://ollama.com` | Providers → Ollama Cloud → Base URL |
| `melink.ollama.defaultModel` | *(empty)* | Defaults → Default model |
| `melink.codex.path` | `codex` | Providers → Codex → Codex CLI path |
| `melink.codex.defaultModel` | *(empty)* | Defaults → Default model |
| `melink.defaults.permissionLevel` | `default` | Defaults → Default permission level |
| `melink.defaults.mode` | `agent` | Defaults → Default mode |
| `melink.defaults.thinking` | *(empty)* | Defaults → Default thinking level |
| `melink.review.diffReview` | `false` | Settings JSON only (application scope): opt-in advisory diff review |
| `melink.ollama.token` (secret, not a setting) | *(none)* | Providers → Ollama Cloud → API key (Save / Clear) |

Codex has no stored credential of its own: it signs in through its own CLI, and
the screen reports that login state rather than holding a secret.

## Credentials

The Ollama Cloud token lives only in VS Code **secret storage**. It is read only
for the `Authorization` header and is never written to `settings.json`, output
channels, or logs. A rejected credential is reported as an actionable notice, not
as a raw HTTP status.

## Project context

Before a question is asked, the extension host builds one bounded picture of the
open project and keeps it current, and hands a rendered version of it to the
backend for the session. It is the single source of project awareness; the
composer turns it on or off. This section documents what is collected, what is
refused, and exactly what is sent to a provider.

The picture has four categories, each with a fixed byte cap and a deterministic
order:

| Category | What it contains |
|---|---|
| **Workspace identity** | Folder name(s) and absolute root path(s) (every root in a multi-root workspace), the git branch and remote `owner/repo` when present, and whether the folder is a git repo at all. |
| **Project shape** | Language breakdown by file count, a bounded top-level/second-level directory tree, detected manifests and entry points (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `tsconfig.json`, `src/`, `app/`, `cmd/`). Only small structured fields are read from a manifest — never its body. |
| **Instruction documents** | `AGENTS.md` at the root and in nested packages up to a bounded depth, `README.md`, and `.github/copilot-instructions.md`, each as a bounded excerpt. When none exist the category says **none found** rather than being silently omitted. |
| **Editor state** | The active file's absolute and workspace-relative path, its language id, and the current selection range with the selected text when there is one; the visible/open editors; dirty files; and the active terminal's cwd when one is open. This is what "current page" means, and it is the cheapest category to refresh. |

When project shape is on, a compact **conventions** block is derived from repository config and manifest metadata: formatter, linter, test runner and test-file pattern, plus indentation, quotes, semicolons and file/component naming only when at least 70% of a bounded sample agrees (at most eight source files, 800 bytes each). Only evidenced facts are named, each with its source path; raw sample bodies are never included. Turning `melink.context.includeShape` off skips both the config reads and the samples.

Every capped category carries a visible marker of the form
`… truncated (N of M entries)`, so the model is told it is seeing a partial view
rather than assuming completeness. An overall cap can trim the open-editor list,
the instruction documents, and the tree; each drop is marked the same way.

The picture is cached by workspace root. It is rebuilt on a workspace-folder
change, a file create/save/delete, a git branch change, and a configuration
change. Editor and selection changes are **delta-only** and never rebuild the
tree, so typing costs nothing. `getDelta(previous)` reports only what changed and
is empty when nothing meaningful changed.

### What is sent to a provider

One pure renderer (`src/context/render.ts`) turns the picture into a text block,
so the wording and the budget are defined once and every backend sends the same
shape. **Snapshot once, delta after**: the full snapshot is sent at session start
(new or resumed), then only a compact per-turn delta (active file, language,
selection, changed-file notice), so the stable prefix stays cacheable and
per-turn cost stays flat.

| Provider | Where the snapshot goes | Where a delta goes |
|---|---|---|
| **Ollama Cloud (direct)** | A `system`-role message before the first user turn. | A `system`-role message immediately before the new user turn. |
| **Codex app-server** | The native `developerInstructions` field on `thread/start` and `thread/resume`. Codex is also started with the workspace root as its `cwd`, so its own file access and `AGENTS.md` discovery work from the right place. | Codex's own file access (the pinned app-server has no per-turn instructions field on `turn/start`). |
| **opencode runtime** (Ollama, `melink.ollama.opencode.enabled`) | Primed into the turn text. opencode's `run` command exposes no system/instructions flag, so this is a deliberate prompt-priming fallback, not an oversight; the child is still spawned in the workspace root. | Only the delta is primed on later turns. |

Two rules hold on every path:

- **Context is system/provider input only.** On the direct Ollama path it is a
  `system` message; it is never folded into a user turn, so the transcript you
  see is unchanged and the synthetic context can never be persisted as transcript
  content.
- **A failure degrades.** A snapshot that cannot be built (or a category over its
  budget) becomes a plain-language notice in place of the block, and the turn is
  never blocked.

**Resume re-primes.** A resumed thread is sent the snapshot again, because the
upstream context may be gone after the replay; its prior messages remain visible
and coherent.

**Manual refresh.** The context button in the header asks for a fresh snapshot on
demand, so a turn sent right after a workspace change reflects it without a
reload. The title-bar refresh re-probes backend availability.

Nothing about the rendered block is shown in the sidebar: it is sent to the
model, not rendered as a message.

### What is never read

Exclusions are on by default. An excluded path is never read, and a selection
inside an excluded file is reported as excluded rather than quoted. The built-in
ignore set is:

- **Secret stores** — `.env`, `.env.*`, `.envrc`, `.npmrc`, `.netrc`,
  `.htpasswd`, `credentials`, `secrets.json`.
- **Key material** — `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, and `.pem`,
  `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.ppk` files.
- **Dependencies** — `node_modules`, `vendor`, `.venv`, `venv`, `__pycache__`.
- **VCS** — `.git`; other dot-directories except `.github`.
- **Build output** — `dist`, `out`, `build`, `coverage`, `bin`, `obj`, `target`,
  `.next`, plus `.min.js`, `.min.css`, and `.map` files.
- **Binaries** — images, archives, executables, libraries, fonts, and media.
- **Lockfiles** — `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`,
  `npm-shrinkwrap.json`, `Cargo.lock`, `go.sum`, `poetry.lock`, `composer.lock`,
  `Gemfile.lock` (the name is listed, the body is never read).

On top of those, every pattern in **Files: Exclude** and **Search: Exclude**, and
any pattern you add to `melink.context.exclude`, is honored.

No project-derived content from the picture is written to disk, logs, output
channels, telemetry, or error text.

## Permission levels and approvals

The permission level governs **when the active backend asks you**; the sandbox
Codex enforces separately is what actually limits the files and commands it can
touch. Approval is not the sandbox.

| Level | What may happen | Asks you when |
|---|---|---|
| **Read-only** | Read only; a sandbox blocks writes, network access, external directories, and subagent delegation. | Anything that would write or fetch. |
| **Default** | Write inside the workspace; Codex network access is blocked. | Anything outside that sandbox, or an opencode edit, command, webfetch, or websearch. |
| **Unrestricted** | No sandbox and no network block. | Never. |

At **Default**, Codex uses `workspaceWrite` with `networkAccess: false`: sandboxed
commands run without a prompt, but a command that needs the network fails rather
than quietly opening it. The opencode runtime has no OS sandbox for a child
process or its HTTP tools, so it instead asks before every edit, shell command,
webfetch, and websearch at **Default**, and before an external directory.
Read-only and Ask deny edits, commands, external directories, webfetch, and
websearch outright; **Unrestricted** allows them all. At Read-only, Default, and
Ask, opencode also denies the `task` tool, so a workspace-defined subagent cannot
be used to escape the selected level; only **Unrestricted** may delegate. A
workspace `opencode.json` is still loaded for its MCP servers, skills, and other
project settings, but the generated agent's `disable: false` and its own
permission block win on overlapping keys, so the project cannot disable the
active agent, switch the turn to `build`, or widen these rules. Project plugins
and remote `instructions` URLs are a pre-existing concern tracked separately;
they are not isolated by this permission fix.

Select the level from the picker in the title bar. Choosing **Unrestricted** needs
an explicit, labelled confirmation first, because it removes the safety net rather
than sandboxing you more loosely; it is never enabled as a side effect of any
other action. The choice is saved for the next turn and for new conversations.

When Codex needs a decision, the turn is **paused** and a card appears above the
composer. Nothing is decided for you — not on a timeout, not on a retry, not on a
reconnect. You choose:

| Decision | Effect |
|---|---|
| **Allow once** | This request only. |
| **Allow for this conversation** | Remembered for this thread, cleared when the thread ends. |
| **Always allow** | A lasting rule, shown in the rules panel and revocable at any time. |
| **Reject** | Denied, and the agent is told so it can adapt rather than stall. |

Stored **Always allow** rules are listed under the header, each showing exactly
what it permits (the command family or path root) and where it came from, with a
**Revoke** action. `Always allow` rules live in global state; `Allow for this
conversation` rules are scoped to the thread and survive a window reload without
either re-asking or silently escalating.

The direct Ollama Cloud adapter has no approval channel: it reports a single level
and never emits an approval request. The opencode runtime behind Ollama Cloud does
use the approval card above for its `ask` decisions.

## Reviewing changes

A turn that edits files is recorded and shown as a **Changes this turn** panel in
the transcript, under the reply it belongs to. The panel lists one row per
changed file with its status chip (**Created**, **Deleted**, **Renamed**, or
**Modified**), per-file `+`/`-` stats, a total, and the decision state of each
row (**No decision yet**, **Kept**, or **Rejected**). Open a row's chevron to
read its inline diff. A turn that changed nothing shows no panel at all.

### Opt-in diff review

`melink.review.diffReview` is **off by default**. When you enable it, a live
turn that changed files gets one additional advisory pass before the review
panel is repainted. It is read-only: it never edits files, runs shell commands,
asks for approvals, or keeps/rejects changes. **Keep** and **Reject** remain the
only actions, and they are unchanged.

The default first pass is local and deterministic. It reads the request that
opened the turn and the changed paths, and reports explicit paths the request
named but the turn did not change. It does **not** detect semantic regressions,
incomplete edits inside a file it did change, or paths mentioned only indirectly.
The prompt and runner seam is in place for a future model reviewer, but this
release runs only the local pass and never calls a model; adding one will not
change the advisory contract.

A review is stored per turn and restored on reload; **no reviewer runs again on
reload**. If the pass throws or misses its 15-second deadline, the section shows
a visible, non-blocking notice and the change decisions stay available. The
setting is **application-scoped**, so only your user setting can enable it; a
workspace setting cannot.

The panel owns a decision per file (and, from the row's actions, per hunk); it
never decides anything for you. A decision is only made when you click:

- **Keep** — accepts this file. **Keep writes nothing to disk**: the file already
  holds the agent's change, so accepting only records the decision. A file you
  keep is byte-for-byte what the turn left, and a rejected-then-kept file is
  byte-identical again.
- **Keep all** — accepts every file in the turn. It also writes nothing.
- **Reject** — restores this file's **pre-turn content**. Rejecting a modified
  file writes the exact pre-turn bytes back; rejecting a **Created** file deletes
  it; rejecting a **Deleted** file recreates it with its pre-turn bytes. Because
  Reject writes to disk it is destructive and never implicit: it opens a
  confirmation that names the affected path(s) first, and only the explicit
  **Reject file** / **Reject N files** confirms it.
- **Reject all** — rejects every file in the turn, behind the same confirmation.

Keep is not undoable from the panel; Reject overwrites what was on disk, so undo
it with your own tooling (for example `git checkout -- <path>`) if you reject by
mistake.

### Post-turn checks

After a turn that changed files is recorded, SideCode can run the project's own
checks before you keep it. Checks are **advisory evidence**, not an automatic
decision:

- **Default detection.** With `melink.review.checks.commands` unset, SideCode
  reads `package.json` and runs `typecheck` when present (otherwise `lint`), then
  `test`. Each command is `<packageManager> run <script>`, using the manifest's
  `packageManager` (for example `pnpm@9`) and falling back to `npm`. An explicit
  empty list turns checks off; a non-empty list runs those commands verbatim.
- **Trust.** Checks run only when the workspace is **trusted**. An untrusted
  workspace stores and shows *"Checks skipped: workspace is untrusted."* and
  spawns no process, regardless of settings.
- **One run at a time.** A new turn, or a new message in the same conversation,
  supersedes the previous run: the old child is killed and its late output is
  ignored. A run left in progress when the window reloads becomes **skipped**
  with the reason *"Checks were interrupted when the window reloaded."* rather
  than a spinner that never stops.
- **Bounded output.** Each stream is capped at 64 KiB as it arrives, and the
  stored result keeps only the last 4,000 characters with a leading `…`. Check
  output is shown only in the review surface: it is never sent to a model or
  provider and is never logged.
- **Keep gating.** While checks are **running**, Keep and Keep all are disabled.
  If any check **failed**, **timed out**, or **errored**, Keep opens a
  confirmation that names the failed check and says it will be bypassed; only
  confirming sends `overrideChecks: true`. Override is a deliberate user action,
  never automatic. Reject is never gated, so you can always undo a turn even
  when its checks are red.
- **No auto-keep.** A green run does not keep anything; the panel still waits for
  your decision.

### Conflicts

If a file changed **on disk after the turn** — a hand edit, a formatter, another
tool — a Reject does not clobber it. The row switches to the **Conflict: the
file changed on disk. Choose explicitly.** state with two actions and the file
is left exactly as it is until you choose:

- **Keep what is on disk** — records the rejection and writes nothing; your
  later edit survives.
- **Overwrite with pre-turn** — the only path that writes, restoring the
  pre-turn bytes over your edit.

Nothing overwrites silently, and a conflict is reported, never hidden.

### Files that cannot be reviewed inline

A **binary** file (a NUL byte in its first bytes) or a file over the inline size
cap (2 MiB) is still listed and still supports **Keep** and **Reject**, but it
has no inline diff. Its chip reads **Binary** or **Too large**, the row shows a
plain-language note in place of a diff, and the summary counts it under
*not reviewable*. From such a row you can still **Open in editor**, **Open diff**
(the left side is empty because the content is not rendered as text), or
**Reveal** it in Source Control.

### Full-fidelity review

For a long change the inline diff is for the decision, not for reading. The panel
hands a real diff view to the workbench:

- **Open changes in editor** opens every changed file in the workbench changes
  editor, file to file, the way Source Control lists them.
- **Open diff** opens one file with the recorded pre-turn content on the left and
  the working file on the right. A created file has an empty left side; a deleted
  file has an empty right side. No temp file is written into the workspace.

## Checkpoints

Every user message whose turn touched files carries a **Restore checkpoint**
action (a message whose turn touched nothing has none). The checkpoint is the
state of those files **before that message's turn**.

To restore, open the action, review the confirmation — it names the file count
and the affected paths — and confirm with **Restore files**. A restore reverts
**files only**: the transcript is untouched, so this message and the rest of the
conversation stay exactly where they are. Restoring an **earlier** message also
reverts every file changed by **later** turns, back to the state at that
checkpoint.

- **Undoable.** A restore first snapshots the current content of every file it is
  about to change, so an **Undo restore** action appears afterwards and puts them
  back. If that snapshot cannot be saved, nothing is written at all.
- **Conflicts are never clobbered.** A file edited outside the agent since the
  checkpoint is reported as a **conflict** and left alone unless you explicitly
  overwrite it, and the result is reported as **partial** rather than a full
  success.
- **Local, and not Git.** Checkpoints are recorded **on this machine, separately
  from Git**. They know nothing about branches, commits, remotes, merges, or
  history, and they are not a substitute for version control — do not rely on
  them to recover work you would expect a commit or a push to protect. Use Git
  for that.

### Where checkpoints are stored, and pruning

The journal behind the review panel and checkpoints is bounded so it cannot grow
without limit:

- The **turn index** (turn and file metadata — hashes, statuses and blob keys,
  never file content) lives in workspace state under `melink.changeJournal`.
- The recorded **before/after content** lives under the workspace-scoped
  extension storage (`context.storageUri`), and decision records live under
  `melink.changeDecisions`.
- The index keeps the most recent **50 turns** and the blob store is capped at
  **64 MiB**; older turns and their blobs are pruned. The turn currently under
  review is retained while it is on screen, but a closed turn can be pruned,
  after which **Open diff** degrades to an explanatory notice rather than
  throwing.

## Approvals vs review vs checkpoints

These three controls are easy to confuse. They act at different times and on
different things:

| Control | What it is | When it acts | What it does to disk |
|---|---|---|---|
| **Approval prompt** | A pre-execution gate on one tool call the agent wants to run. | **Before** the tool runs; the turn stays paused until you choose **Allow once**, **Allow for this conversation**, **Always allow**, or **Reject**. | Nothing yet — the tool has not run. Rejecting stops it. |
| **Changes this turn review panel** | A post-hoc decision about what a turn **already changed**. | **After** the edits have landed. | **Keep** / **Keep all** write nothing. **Reject** / **Reject all** write the pre-turn content back (or delete a created file). |
| **Checkpoint restore** | Reverting files across turns to their state before a message. | Any time, from a message's **Restore checkpoint**. | Writes the checkpoint content back over every file the affected turns touched. Files only; the conversation stays. |

The short version: an **approval prompt gates a tool before it runs**, the
**review panel decides what a finished turn changed**, and a **checkpoint restore
rewinds files across turns**.

## Current limitations (v0.1)

- **Codex app-server is experimental.** The CLI marks the command
  `[experimental]`; method names and payload shapes may change between releases.
  The bindings under `schemas/` are generated from `codex-cli 0.156.1`, and both
  the compile-time types and a runtime version check turn protocol drift into a
  visible error: a server outside the supported window is reported as
  **incompatible** with its version, not as a silent dead Codex. The adapter
  never probes `experimentalFeature/list` or an unrecognised experimental feature
  (those have crashed the app-server upstream), and if `--listen stdio://` is
  rejected it retries the bare `codex app-server` once. See the
  [README](../README.md#pinned-codex-version).
