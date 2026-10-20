# SideCode

One agent chat sidebar for VS Code and Open VSX hosts, driving Ollama Cloud and
the OpenAI Codex CLI.

- **Install and set up:** see below.
- **How to use it and what it can do:** [docs/usage.md](docs/usage.md).
- **Reviewing changes, checkpoints, and how they differ from approvals:**
  [docs/usage.md](docs/usage.md#reviewing-changes).
- **Manual test script / release checks:** [docs/manual-test.md](docs/manual-test.md).

## What it is

A single chat view in the Activity Bar that talks to one of two providers:

| Provider | What it needs | Badge |
|---|---|---|
| **Ollama Cloud** | An `ollama.com` bearer token | Ollama |
| **OpenAI Codex CLI** | The `codex` CLI installed and signed in | Codex |

Providers are independent. A provider that is missing or has no credential is
hidden and stays silent; it never blocks or adds error noise to the one you are
using. The model picker switches between every provider you have a working
account for, in one place.

## Change review and checkpoints

A turn that edits files is recorded and shown as a **Changes this turn** panel.
You decide per file: **Keep** and **Keep all** write nothing to disk (the edit is
already there), while **Reject** and **Reject all** write the pre-turn content
back, deleting a file the turn created — behind a confirmation that names the
paths. A file edited outside the agent is a **conflict** and is never clobbered
silently, and a **binary** or oversized file is listed but not reviewable inline.
Every message whose turn touched files also carries a **Restore checkpoint**
action that reverts those files (across later turns) to their state before that
message; it reverts **files only**, keeps the conversation, is itself undoable,
and is stored **locally, separately from Git** — it is not a version-control
substitute.

This post-hoc review is deliberately separate from the pre-execution **approval
prompt**, which gates a tool before it runs. The distinction, the exact disk
effects, and the storage/pruning behaviour are documented in
[docs/usage.md](docs/usage.md#reviewing-changes) (review and conflicts),
[docs/usage.md](docs/usage.md#checkpoints), and the comparison table at
[docs/usage.md](docs/usage.md#approvals-vs-review-vs-checkpoints).

## Requirements

- VS Code **1.93.0** or newer, or an Open VSX host (Cursor, VSCodium, …).
- **Node.js 20+** only if you build from source.
- At least one provider:
  - **Ollama Cloud:** an API token from <https://ollama.com>.
  - **Codex CLI:** install the `codex` CLI and sign in (`codex login`). The
    integration is developed against `codex-cli 0.156.1`.

## Install

### Option A — from a packaged `.vsix`

1. Build the package (or obtain a released `melink-sidecode-0.2.0.vsix`) —
   see [Build from source](#build-from-source) if you need to make one.
2. Install it:
   - **VS Code CLI:**
     ```sh
     code --install-extension ./melink-sidecode-0.2.0.vsix
     ```
   - **Any host (including Open VSX consumers):** open the Extensions view, click
     the `...` menu in its title bar, choose **Install from VSIX…**, and pick the
     file.
3. Reload the window when prompted.

### Build from source

```sh
npm install
npm run build
```

`npm run build` writes `dist/extension.js` (extension host) and
`dist/webview.js` + `dist/webview.css` (the React sidebar webview). Package it
with:

```sh
npm run package   # produces melink-sidecode-0.2.0.vsix
```

Then install the `.vsix` as in Option A.

#### Build with a script

If you do not know the npm scripts by heart, run the wrapper for your platform
from anywhere in the checkout — each script resolves the repo root itself and
runs the same flow (install if needed, then build, then package):

```sh
./build.sh                 # macOS / Linux
```

```bat
build.bat                  REM Windows
```

Both scripts check that **Node.js 20+** and npm are on `PATH` first, run
`npm install` only when `node_modules` is missing, then run `npm run build`
and `npm run package`, and print the generated `.vsix` filename.
Rerunning without flags skips the install. Pass `--clean` (`-Clean` on Windows)
to force a fresh `npm install` before the build and package steps:

```sh
./build.sh --clean         # force a fresh npm install, then build and package
```

```bat
build.bat -Clean           REM force a fresh npm install, then build and package
```

For a quick dev loop, `npm run watch` rebuilds on change; press `F5` in VS Code
to launch an Extension Development Host. Other scripts:

```sh
npm run typecheck  # tsc --noEmit
npm run lint       # alias for typecheck
npm test           # pure unit tests (node --experimental-strip-types)
```

## Set up a provider

Open the sidebar (Activity Bar → **SideCode**) once to activate the extension, then
set up whichever provider you have.

### Ollama Cloud

1. Create an API token at <https://ollama.com>.
2. Command Palette → **SideCode: Set Ollama Cloud token**.
3. Paste the token and press Enter.

The token is stored in VS Code **secret storage** and sent only as a bearer
credential to the configured base URL. It never appears in `settings.json`,
output channels, or logs. To remove it, run **SideCode: Clear Ollama Cloud token**.

Optional settings (`Settings → search "melink"`, or **SideCode: Open settings**):

| Setting | Default | Purpose |
|---|---|---|
| `melink.ollama.baseUrl` | `https://ollama.com` | Base URL for the Ollama Cloud API. |
| `melink.ollama.defaultModel` | *(empty)* | Default model; empty uses the first one the backend reports. |
| `melink.ollama.opencode.enabled` | `true` | Run Ollama Cloud turns through the **opencode** agentic runtime. Turn it off to use the direct adapter. |
| `melink.ollama.opencode.cliSource` | `local` | `local` uses the path / PATH; `bundled` uses the SideCode download in extension global storage (survives closing VS Code). |
| `melink.ollama.opencode.path` | `opencode` | Path to the `opencode` CLI when `cliSource` is `local`. Ignored when bundled. |
| `melink.ollama.opencode.zvecGrep` | `false` | Legacy. Prefer `melink.skills.zvecGrep`. |
| `melink.skills.browserCodex` | `true` | Let Codex open a browser tab in the editor. |
| `melink.skills.browserOpencode` | `true` | Let OpenCode open a browser tab in the editor. |
| `melink.skills.zvecGrep` | `false` | Connect [zvec-grep](https://github.com/zvec-ai/zvec-grep) to OpenCode (semantic + keyword + ripgrep MCP). |
| `melink.skills.zvecGrep.cliSource` | `local` | `local` (path / PATH) or `bundled` (extension global storage). |
| `melink.skills.zvecGrep.path` | `zg` | Path to `zg` when `cliSource` is local. |
| `melink.skills.astGrep` | `false` | Connect [ast-grep](https://github.com/ast-grep/ast-grep) to OpenCode (structural search/rewrite MCP). |
| `melink.skills.astGrep.cliSource` | `local` | `local` or `bundled` (extension global storage). |
| `melink.skills.astGrep.path` | `ast-grep` | Path to `ast-grep` when `cliSource` is local. |

`Ollama Cloud` lists exactly the models the live server returns from
`GET /api/tags` — there is no hardcoded fallback list.

#### Optional opencode agentic runtime

By default Ollama Cloud runs through [opencode](https://opencode.ai), a terminal
coding agent that can read the project, edit files, and run commands. Provider
identity stays **Ollama**: no new provider, badge, or dot is added. Turning
**`melink.ollama.opencode.enabled`** off uses the direct HTTP adapter instead
(`GET /api/tags` for models and `POST /api/chat` with `stream: true`), which
streams chat and does not spawn opencode.

- **CLI source.** Configure under **Settings → CLI**. `melink.ollama.opencode.cliSource`
  is `local` (path / PATH) or `bundled` (SideCode download in extension global
  storage). Bundled turns always use that binary; it survives closing VS Code.
  Install and Update fetch the official GitHub release into the active install
  directory (they do not rely on `opencode upgrade`, which can report success
  without replacing the binary).
- **Path.** When `cliSource` is `local`, `melink.ollama.opencode.path` defaults
  to `opencode`, resolved from `PATH` when it is a bare name, exactly like
  `melink.codex.path`.
- **zvec-grep.** Under **Settings → Skills**, enable semantic search to connect
  [zvec-grep](https://github.com/zvec-ai/zvec-grep) to OpenCode. Choose **local**
  or **bundled** (SideCode-managed install under extension global storage).
  Enable writes an absolute-path `zvec_grep` MCP entry into the user OpenCode
  config and injects the same server into each SideCode turn. Off removes that
  entry and leaves the CLI installed. Stored as `melink.skills.zvecGrep`
  (legacy key `melink.ollama.opencode.zvecGrep` is still read when unset).
- **ast-grep.** Under **Settings → Skills**, enable structural search to connect
  [ast-grep](https://github.com/ast-grep/ast-grep). Bundled downloads the
  official GitHub release into extension global storage. SideCode ships a thin
  MCP shim (`dist/ast-grep-mcp.js`) that shells out to the resolved binary.
  Enable writes `ast_grep` into the user OpenCode config and injects it per turn.
- **Config is generated per turn, never committed.** The generated config is
  handed to the child through the documented inline override
  `OPENCODE_CONFIG_CONTENT`; nothing is written into the workspace and no
  generated file is checked in. It points at the same base URL
  (`melink.ollama.baseUrl`) and the same live model ids `/api/tags` returns, so
  no id is rewritten and no list is hardcoded. The provider is generated as a
  custom `@ai-sdk/openai-compatible` entry with a namespaced id, so a credential
  a user may have stored with `opencode auth login` cannot override ours.
- **The credential never leaves secret storage.** The token is resolved at spawn
  time into the child's environment (`OLLAMA_API_KEY`); the generated config
  names only that variable, so the secret never appears in the config, on disk,
  in settings, in logs, or in error text.
- **Streaming.** Each turn runs headless (`opencode run --format json`) and its
  NDJSON events are parsed incrementally into the same normalized event union
  the direct adapter uses, so the transcript has one path. A stream that ends
  without a terminal event is treated as a stream error, not a success.
- **Sessions.** The runtime's session id is persisted per thread, so a second
  turn in the same thread resumes the same session. A stale id degrades to a
  fresh session with a visible notice.
- **Modes and permissions.** `agent` and `plan` map to opencode's build agent,
  while `ask` maps to a generated read-only agent. Permission levels
  map onto opencode's own `permission` config: `read-only` denies edits and
  commands, `default` asks for them, and only `unrestricted` (gated behind the
  labelled confirmation) allows them without asking. Ask forces read-only;
  Plan honors the selected permission level. opencode's enforcement is a
  second gate, not a replacement for ours. The pinned opencode version has no
  `--auto` flag and no interactive prompt in `run` mode, so an `ask` is
  auto-rejected rather than silently allowed; the in-chat approval surface is a
  separate ticket.
- **Fallback is exact.** With the setting off, the direct `/api/chat` adapter
  runs unchanged: no opencode module is loaded on that path and no child process
  is spawned.

## Project context

A fresh thread can answer "what is this project about?" without the user pasting
anything and without web search, because the extension builds one bounded
workspace picture and hands a rendered version of it to the active backend for
the session. The picture and its exclusions are documented in
[docs/usage.md](docs/usage.md#project-context); this section states exactly what
is sent to a provider.

- **One renderer, every backend.** `src/context/render.ts` turns the snapshot (or
  a delta) into a text block, so the wording and the byte budget are defined once.
- **Snapshot once, delta after.** The full snapshot is sent at session start (new
  or resumed); afterwards only a compact per-turn delta (active file, language,
  selection, changed-file notice). The stable prefix stays cacheable and per-turn
  cost stays flat.
- **Resume re-primes.** A resumed thread is sent the snapshot again, because the
  upstream context may be gone after the replay.
- **A failure degrades.** A snapshot that cannot be built, or a category over its
  budget, becomes a plain-language notice and never blocks a turn.
- **Manual refresh.** A header button requests a fresh snapshot, so a turn sent
  after a workspace change reflects it without a reload.
- **Optional repo map.** With `melink.context.repoMap` on, `src/context/repoMap.ts`
  builds a bounded symbol/import index over the files the snapshot already
  accepted and ranks definitions, importers and dirty files against each
  message. It is host-free, capped by files (`repoMapMaxFiles`, 200), bytes
  (`repoMapMaxBytes`, 131072), build time (`repoMapBuildMs`, 750) and rendered
  characters (`repoMapMaxChars`, 1200), and it times out a slow read. Off,
  unavailable, failed or over-budget all render a one-line marker instead of
  blocking a turn. `zvec-grep` is unchanged and remains a separate optional
  retrieval path, not a dependency of this map.

How each provider receives it:

| Provider | Snapshot | Per-turn delta |
|---|---|---|
| **Ollama Cloud (direct)** | A `system`-role message before the first user turn. | A `system`-role message immediately before the new user turn. |
| **Codex app-server** | The native `developerInstructions` field on `thread/start` and `thread/resume`; the thread's `cwd` is the workspace root, so Codex's own file access and `AGENTS.md` discovery work from the right place. | Codex's own file access (the pinned app-server exposes no per-turn instructions field on `turn/start`). |
| **opencode runtime** | Primed into the turn text; the child is spawned in the workspace root. | Only the delta is primed. |

`melink.ollama.opencode.enabled` **off** leaves the direct `/api/chat` request
body unchanged apart from the context messages, and spawns no child process. The
opencode and Codex paths were verified against the versions pinned below.

### Pinned versions the priming path was verified against

- **Codex CLI: `codex-cli 0.156.1`** — the generated bindings in `schemas/`
  expose `baseInstructions`/`developerInstructions` on `thread/start` and
  `thread/resume`, and no per-turn instructions field on `turn/start`. That is
  why Codex priming is native at start/resume and left to Codex's own file access
  mid-thread. The supported protocol window is `0.154.0–0.163.x`; a server
  outside it is reported as `incompatible` with its version rather than used.
- **opencode: `1.1.65`** — `opencode run --help` exposes no
  system/instructions flag, so the snapshot is delivered by priming the turn text.
  This is a deliberate fallback, not an oversight.

Both providers are also spawned with the workspace root as their working
directory, so their own project discovery reads the real `AGENTS.md` even when the
rendered snapshot is the only thing the model is explicitly handed.

### OpenAI Codex CLI

1. Install the `codex` CLI so that `codex` resolves on your `PATH`.
2. Sign in:
   ```sh
   codex login
   ```
   Confirm with `codex login status` (expected: `Logged in using ChatGPT`).
3. If `codex` is not on `PATH`, set **`melink.codex.path`** to its full path.

Optional settings:

| Setting | Default | Purpose |
|---|---|---|
| `melink.codex.path` | `codex` | Path to the Codex CLI executable. |
| `melink.codex.defaultModel` | *(empty)* | Default model; empty uses the CLI default. |

### App-level defaults

The settings screen also exposes defaults for a **new conversation**. Each is
overridable per conversation; the header model switcher and the permission
picker in the title bar override them for the conversation you are in.

| Setting | Default | Purpose |
|---|---|---|
| `melink.defaults.permissionLevel` | `default` | Permission level a new conversation runs at (`read-only` / `default` / `unrestricted`). `unrestricted` must be confirmed. |
| `melink.defaults.mode` | `agent` | Starting mode a new conversation runs in (`agent` / `plan` / `ask`). A mode is applied to the Codex thread at start. |

Open the settings screen from the gear in the title bar (it opens inline in the
sidebar, not a separate window). It also sets the Ollama API key with a masked
input and Save/Clear actions, and offers **Test connection** for each provider.

### Modes

A conversation runs in one of three modes, defined once in the shared contract
(`src/backends/types.ts`) and reported per backend so the UI only offers a mode
the backend can actually honour:

| Mode | Contract |
|---|---|
| `agent` | The agent acts on the workspace. |
| `plan` | The agent writes a plan and waits for you to build it before implementing its steps. Workspace access follows the selected permission level. |
| `ask` | The agent only answers questions; it cannot act. |

**Enforcement, not suggestion.** Ask runs at the read-only end of the
permission machinery. Plan and Agent honor the selected level, so Codex's own
sandbox controls which writes and commands can run. Ask refuses every approval
the agent raises, so a question can never become a change. A mode a backend
cannot enforce is not advertised: Ollama Cloud reports `agent` only,
so Plan/Ask are hidden rather than shown and behaving like Agent.

The generated `CollaborationMode` / `ModeKind` types exist, but this pinned CLI
exposes no client request that sets them (`collaborationMode` appears only on
the read-only `ThreadSettings`). Plan and Ask are therefore implemented as
**prompt plus permission-level policy**, and that divergence is documented in
`src/backends/modes.ts`. Native plan *tracking* (`turn/plan/updated`) is used
where it exists and forwarded as the neutral `plan/updated` event.

A mode change applies to the next turn only; it never mutates the transcript,
and the active mode is persisted with the thread index so a resumed thread keeps
its mode.

The host also recognizes a small set of clear request forms before sending a
turn: explicit plan requests can switch to Plan, and direct workspace action
requests can switch to Agent. Ask is only selected manually from the mode
control. Switching to Plan happens automatically and is shown in the mode control.
Moving to a mode that permits more activity pauses for a confirmation; dismissing
the prompt keeps the current mode. Unclear wording leaves the selected mode
alone. Detection is provider-neutral and only runs for modes the backend reports
as supported.

### Plan artifact

In Plan mode the plan is written to one markdown file per thread at a
predictable, workspace-relative path:

```
<workspace root>/.melink/plans/<thread-id>.md
```

The name is derived from the **thread id**, never the raw prompt, so a revision
updates the same file rather than creating a second plan. The file contains what
the plan will do and a bullet list of steps; **creating it is the one permitted
write in Plan mode**. Building the plan moves the thread into execution (the mode
returns to `agent`) and the bullet list becomes the todo list, whose per-step
status is tracked and persisted so a reload does not reset progress. Rejecting a
plan leaves the workspace unchanged apart from the plan file. The path is carried
over the protocol (`plan` message) so the UI can show and reopen it.

### Reviewing a turn in the native diff views

The sidebar summary and its inline diff are for a decision, not for reading a
long change. Full-fidelity review is handed to the workbench, which already ships
the single-file diff editor and the multi-file changes editor. The host owns this
path (`src/changes/nativeDiff.ts` for the host-free planner and
`src/changes/vscodeDiff.ts` for the VS Code binding):

- **`melink-changes:` content provider.** The left-hand side of a diff is the
  journal's **pre-turn** content, served read-only from the recorded blob store.
  No temporary file is written to the workspace, and a virtual document cannot be
  saved back, so opening a diff never leaves a dirty unsaved editor. Blobs live
  under extension storage (`context.storageUri`) and are pruned by the journal.
- **Single file.** `melink.openChangeDiff` opens the built-in diff editor with the
  pre-turn content on the left and the working file on the right. A **created**
  file has an empty left side (and no before blob is required); a **deleted** file
  has an empty right side.
- **Whole turn.** `melink.openTurnChanges` opens every changed path in the
  workbench changes editor (`vscode.changes`, falling back to
  `_workbench.openMultiDiffEditor`), so the user can walk file to file the way
  Source Control does.
- **Fallback.** `melink.revealChangeInSourceControl` focuses the Source Control
  view. A turn's changes are not a source-control provider, so this opens the view
  and says so rather than fabricating a row.

Command ids are stable and registered at activation, so the review surface's
`Open in editor` / `Open diff` affordances have real targets; if the data is gone
or a view is unavailable, each degrades to an explanatory notice instead of
throwing. The provider and commands are disposed on deactivate and never leak
across a reload.


## Verify it works

1. Reopen the sidebar. An empty chat shows the meLink mark and the name
   **meLink SideCode**, with a tall composer and no suggestion buttons.
2. Open the **Model** trigger. You should see one group per provider you set up,
   listing that provider's live models.
3. Type a message and press **Enter**. The reply streams into the transcript.

If you see *"No backend is ready"*, the sidebar links you straight to the fix
(**Set token**, or a hint to install/sign in to Codex).

## Development notes

### Codex app-server integration

The Codex backend talks to `codex app-server` over newline-delimited JSON-RPC 2.0
on stdio. This is the interface the official Codex VS Code extension uses, so
cloud features and fast mode are preserved, unlike shelling out to `codex exec`.
The `"jsonrpc":"2.0"` field is omitted on the wire, matching the app-server.

The CLI is spawned as one long-lived child process per workspace. It tries
`app-server --listen stdio://` first and, if a newer CLI rejects that argument,
retries once with the bare `codex app-server` (stdio is the default); whichever
form starts is logged to the **SideCode (Codex)** output channel. A missing
binary is reported as `unavailable` before anything is written, so an Ollama-only
sidebar never shows Codex noise.

#### ChatGPT auth is forced, not inherited

Codex reads ChatGPT OAuth credentials from `$CODEX_HOME/auth.json`, but it also
accepts credentials and endpoint overrides from the environment. The extension
host's environment is inherited by its children, so an `OPENAI_API_KEY` set for
another tool could make Codex 401 against the ChatGPT backend with a credential
the user never chose. Two things prevent that:

- **The child env is scrubbed.** `OPENAI_API_KEY`, `OPENAI_BASE_URL`,
  `OPENAI_ORG_ID`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, and the other
  credential/base-URL variables are removed before `codex` is spawned (see
  `src/backends/codex/env.ts`). `HOME`, `USERPROFILE`, `PATH`, and `CODEX_HOME`
  are preserved so `auth.json` stays discoverable.
- **The auth preference is explicit.** Every invocation passes
  `-c 'forced_login_method="chatgpt"'` ahead of the subcommand, so the choice is
  the extension's and not whatever `~/.codex/config.toml` says. The key was
  verified against the installed `0.156.1` binary, which parses
  `forced_login_method` (`chatgpt`/`api`); there is no `preferred_auth_method`
  key. An unrecognised key is ignored by the CLI rather than fatal, so the
  override is safe across the supported version window.

The `getAuthStatus` reply's auth mode is surfaced in **Settings → Providers →
Codex** (*Reported auth method*). When the CLI reports an API-key login — or a
failed turn body is `Incorrect API key provided` — the state is named as the
API-key-vs-ChatGPT mismatch rather than a healthy sign-in or a plain sign-out,
and it is only surfaced while Codex is the selected provider. No credential value
is ever logged, shown, or interpolated into a message.

#### Pinned Codex version

Generated protocol bindings are checked in under `schemas/` and the extension
compiles against them, so a protocol drift surfaces as a build/type error rather
than a runtime mystery. At runtime, the server's own version (from the
`initialize` user agent, or `codex --version` when the handshake times out) is
checked against the pinned protocol window: a version outside `0.154.0–0.163.x`
is reported as the specific `incompatible` status carrying that version, never the
generic `unavailable` state and never a silent no-op.

- **Pinned Codex CLI version: `codex-cli 0.156.1`** (Windows x86_64)
- Generated with:

  ```sh
  codex app-server generate-ts --out ./schemas
  ```

  (also available as `npm run schemas:generate`)

When the installed CLI is newer than this pin, regenerate the bindings and fix
any resulting type errors before shipping. The app-server command and its
WebSocket transport are marked `[experimental]` by the CLI, so method names and
payload shapes can move between releases; the checked-in types are the guard. The
adapter deliberately never calls `experimentalFeature/list` or enables an
unrecognised experimental feature, because those have crashed the app-server
upstream; the only experimental surface opted into is the documented `initialize`
capability flag.

#### Behaviours driven by the app-server

- **Handshake.** `initialize` with `clientInfo` and
  `capabilities.experimentalApi: true`, followed by the `initialized`
  notification. Initialized exactly once per connection. The assistant stream is
  consumed as `item/agentMessage/delta` (in addition to the reasoning and
  command delta methods); a handshake that never answers is reported as
  `incompatible` with the CLI's own `codex --version`, not as a silent timeout.
- **Backoff.** A `-32001` / "Server overloaded; retry later." response is retried
  with exponential backoff plus jitter, up to a capped attempt count.
- **Shutdown.** `dispose()` closes stdin, then sends SIGTERM, then a bounded
  SIGKILL; `deactivate` awaits it so no orphaned `codex` process survives a
  window reload or extension-host restart.
- **Approvals.** Inbound `requestApproval` server requests are held open and
  surfaced as a pending decision; the turn stays blocked until the user chooses
  **Allow once**, **Allow for this conversation**, **Always allow**, or
  **Reject**. Nothing is auto-decided on a timeout, retry, or reconnect, and a
  rejection is reported back to the agent so it can adapt. `always` rules go to
  `globalState`, `session` rules to `workspaceState` scoped to the thread (and
  cleared when the thread ends), and stored `always` rules are listed and
  revocable in the sidebar.

### Optional opencode runtime

The Ollama opencode runtime is a per-turn, short-lived child process. It is
pinned and verified against **`opencode 1.1.65`**; the flags used (`run`,
`--format json`, `--model`, `--agent`, `--session`, `--variant`) are the ones
that version's `opencode run --help` lists. Notes:

- The pinned version emits whole message parts rather than token deltas, so a
  text or reasoning part is forwarded as one `item/started` + `item/delta` +
  `item/completed` group keyed by its part id.
- It has **no `--auto` flag** (passing it prints help and exits non-zero), so the
  turn's permission level is expressed entirely through the generated
  `permission` config. A headless `ask` is auto-rejected rather than prompted,
  which is why `default` never silently writes.
- A stream that ends without a terminal `step_finish` (`reason: "stop"`) is a
  stream error, not a successful turn.
- The credential is supplied through the provider's `env` declaration and the
  child's environment; `OPENCODE_CONFIG_CONTENT` is the only config transport,
  so nothing is written into the workspace or the repository.

When the installed CLI is newer than this pin, re-check `opencode run --help`
and the JSON event shapes before relying on these assumptions.

### Project layout
```
src/
  extension.ts          activation, commands, registrations
  sidebarView.ts        webview <-> host glue, reload/restore lifecycle
  planStore.ts          writes/reads the per-thread plan file under .melink/plans
  protocol.ts           typed host <-> webview message contract
  backends/
    types.ts            provider-neutral seam every backend implements
    registry.ts         owns both adapters, publishes availability
    modes.ts            mode enum translation, enforcement policy, refusal copy
    plan.ts             pure per-thread plan path + markdown render/parse
    permissions.ts      permission-level -> Codex sandbox/approval mapping
    ollama.ts           Ollama Cloud adapter (direct HTTP + optional opencode runtime)
    opencode/           generated config + NDJSON event parsing + per-turn runner
    codex.ts            Codex adapter
    appserver/          JSON-RPC transport for `codex app-server`
    threadStore.ts      persisted thread index + transcript replay cache
  webview/              React sidebar UI (App, state, styles)
schemas/                generated Codex app-server protocol bindings
docs/                   usage and manual-test documentation
```
