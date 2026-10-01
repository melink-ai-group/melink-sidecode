# Manual test script — Agent sidebar v0.1

Runnable checklist for signing off v0.1. Work top to bottom; tick `[x]` for pass,
leave `[ ]` and record the failure (or promote it to a known limitation) for a miss.

Run every step in both hosts (see [Per-host pass](#5-per-host-pass)) unless a step
names a single host.

- Extension under test: `melink-agent-sidebar` 0.1.0 (`melink` publisher)
- Build under test: `npm run build` output in `dist/`
- Tester: ............................  Date: ............
- Host A (plain VS Code): version ............
- Host B (Open VSX consumer): .............. version ............

---

## Release acceptance criteria → step map

v0.1 ships only when all six criteria pass in both hosts.
| # | Release acceptance criterion | Proven by |
|---|---|---|
| RC-1 | **Provider isolation.** A provider that cannot be used (CLI missing, no credential, rejected credential) degrades only itself: it produces no error noise in, and never blocks, the other provider. | Steps 1–14 |
| RC-2 | **Reload resume.** Reloading the window and reopening the sidebar resumes the previous thread for the active backend, with its transcript repainted. | Steps 15–24 |
| RC-3 | **Process teardown.** No orphaned `codex` process remains after deactivate, after window reload, or after closing the editor. | Steps 25–33 |
| RC-4 | **Credential hygiene.** The Ollama Cloud token lives only in secret storage and never appears in `settings.json`, output channels, or logs. | Steps 34–39b |
| RC-5 | **Project awareness.** A fresh thread answers "what is this project about?" from the delivered context, without the user pasting anything and without web search. | §4b (steps 39c–39k) |
| RC-6 | **Change review & checkpoint safety.** A turn that edits files is reviewable: Keep writes nothing, Reject restores the exact pre-turn bytes, a conflict is never silently clobbered, a checkpoint restore reverts files only and is itself undoable, pending decisions survive a reload, and the recorded blob store stays bounded. | §4c (steps S1–S3, 47–58) |

Steps 40–43 repeat the rendering/reload/teardown checks per host.
Steps 44–46 repeat the project-awareness pass for the opencode off/on paths.
Steps 47–58 (§4c) cover change review, conflict handling, checkpoint restore,
reload mid-review, approval interaction, and journal pruning, on both providers.

---

## 0. Setup

- [ ] 0.1 Install the build: `npm run build`, then install the produced `.vsix` in
      each host (`code -n --install-extension ./melink-agent-sidebar-0.1.0.vsix` for
      VS Code; for Cursor use the Extensions view → `...` → *Install from VSIX*).
- [ ] 0.2 Restart the host so `deactivate`/`activate` run against a clean state.
- [ ] 0.3 Record the Codex CLI version: `codex --version`
      (expected baseline: `codex-cli 0.156.1`; the supported protocol window is
      `0.154.0–0.156.x`). ............
- [ ] 0.4 Record the exact CLI path: `where codex` (Windows) / `which codex`
      (macOS/Linux). ............
- [ ] 0.5 Note the "known good" Codex login state: `codex login status`
      (expected: `Logged in using ChatGPT`).
- [ ] 0.6 Open a **fresh, empty scratch workspace** so `workspaceState` from an
      earlier run cannot mask a failure.
- [ ] 0.7 Open the Agent sidebar once (Activity Bar → **Agent**) to force
      activation, then close it again.

### Making the Codex CLI unresolvable (reversible)

Use **one** method per pass and always restore it before the next pass.

**Method A — settings override (preferred; no filesystem change).**
1. Command Palette → *Preferences: Open Workspace Settings (JSON)*.
2. Add:
   ```json
   { "melink.codex.path": "codex-missing-for-test" }
   ```
3. The next probe resolves a bare name that exists nowhere on `PATH`, so the Codex
   backend reports `unavailable` exactly as if the CLI were not installed.
4. **Restore:** remove the `melink.codex.path` key (or set it back to `codex`).

**Method B — temporary rename (true filesystem absence).**
1. Close every host so no `codex` process is running.
2. Rename the executable recorded in step 0.4:
   - Windows: `ren "<path>\codex.exe" codex.exe.disabled`
   - macOS/Linux: `mv "$(command -v codex)" "$(command -v codex).disabled"`
3. Reopen the host; the CLI is genuinely unresolvable from `PATH`.
4. **Restore (mandatory before any later pass):**
   - Windows: `ren "<path>\codex.exe.disabled" codex.exe`
   - macOS/Linux: `mv "<recorded-path>.disabled" "<recorded-path>"`
   (Use the path recorded in step 0.4.)
5. Confirm restoration: `codex --version` prints the version from step 0.3.

> Do **not** uninstall the CLI. Both methods are reversible and leave the login
> state and config untouched.

---

## 1. Provider matrix — four passes

The matrix is the core of RC-1. For each pass: set the credentials, reload the
window, open the sidebar, and compare the sidebar state and switcher contents
against the expected column.

| Pass | Ollama token | Codex CLI | Use |
|---|---|---|---|
| A | set | unresolvable (Method A/B) | Ollama only |
| B | clear | installed + signed in | Codex only |
| C | set | installed + signed in | Both authenticated |
| D | clear | unresolvable (Method A/B) | Neither |
| E | set | either | Ollama with the opencode runtime **enabled** |
| F | set | either | Ollama fallback (opencode runtime **disabled**, the default) |

Passes E and F verify the optional opencode runtime: E that a turn executes
through opencode and streams, F that the setting off uses the direct `/api/chat`
adapter and spawns no opencode process. Run them after the main matrix, against
the same workspace.

### Pass A — Ollama only

- [ ] 1. Make the Codex CLI unresolvable with Method A (leave the Codex login in
      place — this pass proves that an unusable provider is isolated even when a
      credential exists).
- [ ] 2. Set the Ollama token: Command Palette → **Agent: Set Ollama Cloud token**,
      paste a valid `ollama.com` bearer token, Enter.
- [ ] 3. Command Palette → **Developer: Reload Window**.
- [ ] 4. Open the sidebar (Activity Bar → **Agent**).
- [ ] 5. **Expected sidebar state:** transcript reaches the empty state
      *“Ask the agent about this workspace”* with the three suggestion buttons;
      composer placeholder reads `Ask the agent...` and is enabled (input not
      disabled) after restore completes.
- [ ] 6. **Expected switcher:** open the **Model** trigger.
      - Trigger shows a live Ollama model label with the blue Ollama dot.
      - Panel lists exactly one group: **Ollama Cloud**, with the models returned
        live by `GET /api/tags` (no hardcoded fallback list).
      - **No Codex group appears**, and no Codex error text appears anywhere.
      - Footer note reads *“Providers without a usable integration are hidden until
        they are installed.”*
- [ ] 7. **No error noise:** the transcript and notifications area show **no** banner
      or toast about Codex. (A hidden provider must be silent.)

### Pass B — Codex only

- [ ] 8. **Agent: Clear Ollama Cloud token**, then reload the window.
- [ ] 9. Ensure the CLI is resolvable again (step 0.5 restored) and signed in.
- [ ] 10. Open the sidebar, open the **Model** trigger.
      - **Expected sidebar state:** empty state *“Ask the agent about this
        workspace”*; composer enabled with placeholder `Ask the agent...`.
      - **Expected switcher:** exactly one group, **OpenAI Codex CLI**, listing
        `gpt-5-codex` and `gpt-5`. The **Ollama Cloud group does not appear** (an
        unauthenticated provider is not diluted in while a provider is available).
      - Trigger shows `gpt-5-codex` (default) with the neutral Codex dot.

### Pass C — both authenticated

- [ ] 11. Set the Ollama token again (step 2), sign in Codex, reload.
      - **Expected sidebar state:** empty state as above; composer enabled.
      - **Expected switcher:** two groups, **Ollama Cloud** (live models) and
        **OpenAI Codex CLI** (`gpt-5-codex`, `gpt-5`).
      - Trigger dot matches the selected provider; selecting a model in the other
        group moves the check mark and updates the trigger label.
- [ ] 12. Send one short turn on each provider in turn. Confirm each streams in the
      transcript with the correct provider dot and that neither turn shows an error
      banner caused by the other provider.

### Pass D — neither

- [ ] 13. **Agent: Clear Ollama Cloud token**; make the CLI unresolvable
      (Method A/B); reload; open the sidebar; open the **Model** trigger.
      - **Expected sidebar state:** empty state with title *“No backend is ready”*
        and text *“Ollama Cloud needs a token before you can chat.”*, with
        **Set token** and **Retry** buttons. Composer placeholder reads
        `No backend available` and the input is disabled.
      - **Expected switcher:** the panel shows the empty state *“No provider is
        ready”* with *“Set up a provider below to list the models on your
        account.”*, followed by one disabled **Ollama Cloud — Not signed in** group
        with a **Set token** button.
      - **No Codex group and no Codex error text appears** (an unavailable provider
        is omitted, never rendered as broken).
- [ ] 14. **Restore** the CLI (Method A/B restore) and set the Ollama token again
      before continuing.

### Pass E — Ollama with the opencode runtime enabled

Record the installed CLI first: `opencode --version` (baseline validated against
`1.1.65`). ............ Ensure `opencode` resolves on `PATH`, or set
`melink.ollama.opencode.path` to its full path.

- [ ] 14a. Set the Ollama token (step 2). In **Workspace Settings (JSON)** add:
      ```json
      { "melink.ollama.opencode.enabled": true }
      ```
      Reload the window and open the sidebar.
- [ ] 14b. **Mode availability.** Open the mode picker. With the runtime on, it
      offers **Agent**, **Plan**, and **Ask** (the direct adapter offers Agent
      only). Open the permission picker: it offers **Read-only**, **Default**,
      and **Unrestricted**. The provider badge/dot is still the single Ollama one
      — no new provider, badge, or dot appears.
- [ ] 14c. **Streaming turn.** Select an Ollama model and send a short turn and
      wait for completion. **Expected:** the reply streams into the transcript
      incrementally (a text item opens and completes) rather than the whole thing
      appearing only at the end. No error banner appears.
- [ ] 14d. **Tool execution.** Ask the agent to list the workspace files. Confirm
      a **tool card** appears for the command and completes with its status.
- [ ] 14e. **Config cross-check.** From a terminal in the same workspace, confirm
      the runtime resolves the generated provider against the configured base
      URL and the live model ids:
      ```sh
      opencode models
      ```
      Confirm the listed Ollama model ids match the sidebar's model list (no id
      rewritten, no hardcoded extra list). The generated config is passed inline
      only; confirm **no** generated `opencode.json` was created in the workspace.
- [ ] 14f. **Session resume.** Send a second turn in the same conversation and
      confirm the runtime continues the same session (the reply refers to the
      earlier turn). Then delete the persisted thread index key
      (`melink.threadIndex`) while leaving the active-thread reference, reload,
      send a turn, and confirm a visible notice that a new session was started
      rather than an error or a stall.
- [ ] 14g. **Plan follows its permission level; Ask cannot modify the workspace.**
      Switch to **Plan** with **Default**, ask it to create a file, and confirm
      the workspace sandbox permits writes. With **Unrestricted**, confirm
      writes outside the workspace are permitted. Switch to **Ask**, ask it to
      run a destructive command (e.g. delete a scratch file) and to write a file, and
      confirm neither happens. Check the scratch files are unchanged afterwards.
- [ ] 14h. **Read-only and default never auto-approve edits or commands.**
      Select **Read-only**, attempt a write and a destructive command, and
      confirm both are refused. Select **Default**, attempt a write, and confirm
      it is **not** auto-approved (headless opencode auto-rejects the `ask`, so
      the file is not written). Select **Unrestricted** (after the labelled
      confirmation), attempt a workspace write, and confirm it is performed.
- [ ] 14i. **Reasoning and context.** With a model that reports reasoning, set a
      thinking level and a max context and confirm the turn still completes.
      Select a model that reports **no** reasoning control, set a thinking level,
      and confirm a notice says that control is unsupported instead of a value
      being sent.
- [ ] 14j. **Cancel.** Start a long turn and press **Stop**. Confirm the
      transcript keeps the partial output, shows *Stopped* (not an error), the
      input is usable again, and no `opencode` process survives (`tasklist /FI
      "IMAGENAME eq opencode.exe"`, or `pgrep -fl opencode`).
- [ ] 14k. **Failure states.** Make the CLI unresolvable (Method A/B) and send a
      turn → a distinct *CLI missing* notice, not a crash. Restore it. Set
      `melink.ollama.baseUrl` to an endpoint returning 401 and send a turn → a
      distinct *token rejected* notice with a **Set token** action. Restart.
- [ ] 14l. **Remove** the `melink.ollama.opencode.enabled` key before the next
      pass.

### Pass F — Ollama fallback (runtime disabled)

- [ ] 14m. Confirm `melink.ollama.opencode.enabled` is absent or `false`. Reload
      and open the sidebar.
- [ ] 14n. Send a turn and wait for completion. **Expected:** the direct
      `/api/chat` adapter streams the reply; the mode picker offers **Agent**
      only and the permission picker a single level, exactly as before this
      ticket.
- [ ] 14o. **No child process on the off path.** Immediately after sending the
      turn (and again after it completes), run the listing command:
      ```powershell
      Get-CimInstance Win32_Process -Filter "name='opencode.exe'" |
        Select-Object ProcessId, ParentProcessId, CommandLine
      ```
      ```sh
      pgrep -fl opencode   # macOS / Linux
      ```
      **Expected:** no `opencode` process is spawned at any point. (This is the
      acceptance check that the fallback is exact.)

---

## 2. Reload test (RC-2)

Run once with Ollama active and once with Codex active. Use a thread that already
has at least one completed turn.

### Ollama

- [ ] 15. With Ollama selected, send a turn and wait for it to complete.
- [ ] 16. Command Palette → **Developer: Reload Window**.
- [ ] 17. Reopen the sidebar.
      - **Expected:** a brief *“Restoring conversation…”* status, then the prior
        user and assistant turns repaint in full.
      - The active thread is the same conversation (history list still shows it as
        selected), and the selected model matches the one used before the reload.
- [ ] 18. Send a follow-up turn. Confirm the backend receives the replayed history as
      context (the reply references the earlier turn).

### Codex

- [ ] 19. Select Codex, send a turn, wait for completion.
- [ ] 20. Reload the window and reopen the sidebar.
      - **Expected:** the transcript repaints from the render cache; the thread
        resumes; no duplicate items and no “Running” card left behind.
- [ ] 21. Send a follow-up turn; confirm it succeeds against the same thread id.

### Stale-thread degradation (optional robustness check)

This exercises `SidebarViewProvider.degradeToFresh`. It fires when the persisted
`melink.activeThread` reference survives but the backend no longer knows the thread
(the reference is checked against `melink.threadIndex`). Deleting the key on its own
does *not* trigger it, because `restore()` then simply starts fresh — so remove the
*index* entry while leaving the active-thread reference in place.

- [ ] 22. Note the active thread id from §2, then quit the host. Locate this
      workspace's state database:
      - Windows: `%APPDATA%\Code\User\workspaceStorage\<hash>\state.vscdb`
        (for a Cursor host, substitute `%APPDATA%\Cursor\User\...`).
      - macOS/Linux: `~/Library/Application Support/Code/User/workspaceStorage/<hash>/state.vscdb`
        (Linux: `~/.config/Code/User/workspaceStorage/<hash>/state.vscdb`).
      Find the `<hash>` folder whose `workspace.json` points at the scratch
      workspace. With `sqlite3` available, drop only the thread index (keep
      `melink.activeThread`):
      ```sh
      sqlite3 state.vscdb \
        "DELETE FROM ItemTable WHERE key='melink.threadIndex';"
      ```
      (If `sqlite3` is unavailable, skip this optional section.)
- [ ] 23. Reopen the host and the sidebar.
      - **Expected:** the sidebar falls back to a fresh conversation and shows the
        quiet notice *“The previous conversation could not be restored, so a new one
        was started.”* — never a blocking error and never an input that stays
        disabled. The input becomes enabled when the *“Restoring conversation…”*
        status clears.
- [ ] 24. Confirm that on the next reload the sidebar no longer shows the notice
      (because `degradeToFresh` cleared `melink.activeThread`).

---

## 3. Process teardown test (RC-3)

The Codex CLI is spawned as one long-lived `codex app-server` child process per
workspace and disposed on deactivate. Confirm nothing survives.

### The exact command to list candidate processes

**Windows (PowerShell — preferred, shows the tree):**
```powershell
Get-CimInstance Win32_Process -Filter "name='codex.exe'" |
  Select-Object ProcessId, ParentProcessId, CommandLine
```

**Windows (tasklist — quick count):**
```bat
tasklist /FI "IMAGENAME eq codex.exe"
```

**macOS / Linux:**
```sh
pgrep -fl codex
# or, with the parent chain:
ps -eo pid,ppid,command | grep -i '[c]odex'
```
A clean result is *no rows* (tasklist: `No tasks are running which match the
specified criteria.`; pgrep exits non-zero with no output).

### After deactivate (extension host restart)

- [ ] 25. With Codex selected, start a long turn and **do not** wait for it to finish.
- [ ] 26. Command Palette → **Developer: Restart Extension Host**. This disposes the
      extension (`deactivate`) while leaving the window open.
- [ ] 27. Run the listing command above.
      - **Expected:** zero `codex` processes remain (the in-flight turn was killed
        with its process tree).

### After window reload

- [ ] 28. Start a long Codex turn, then **Developer: Reload Window** mid-stream.
- [ ] 29. Run the listing command.
      - **Expected:** zero `codex` processes remain after the reload settles
        (allow ~3 s; the CLI may take a moment to exit).

### After closing the editor

- [ ] 30. Start a long Codex turn, then **quit the whole editor** (not just the
      window) mid-stream.
- [ ] 31. From a terminal outside the host, run the listing command.
      - **Expected:** zero `codex` processes remain. No daemon was started by the
        extension, so nothing should keep running.
- [ ] 32. Reopen the host and confirm it starts cleanly with no leftover socket/state
      lock and that the previous thread is resumable (ties back to RC-2).
- [ ] 33. Also verify the ordinary case: after any turn completes normally, the
      listing command shows no lingering `codex` process.

> If a `codex.exe` row survives, capture its `ProcessId`, `ParentProcessId`, and
> `CommandLine`, and record it as a failure — this is the regression the tree-kill
> teardown in `src/backends/appserver/connection.ts` (`killProcessTree`) prevents.

---

## 4. Credential hygiene check (RC-4)

Use a distinctive, non-real token so it is easy to grep for, e.g.
`TEST-ONLY-should-never-appear-7f3a`. Never use a real credential for this check.

- [ ] 34. Command Palette → **Agent: Set Ollama Cloud token**, enter the distinctive
      token.
- [ ] 35. **settings.json:** open both *User Settings (JSON)* and *Workspace Settings
      (JSON)* and search for the token substring. **Expected: absent.** The
      `melink.*` settings must contain no credential.
- [ ] 36. **Output channels:** `Ctrl+Shift+U` (View → Output), select each channel in
      the dropdown (including *Extension Host* and any *Agent* channel), and search
      the panel for the token. **Expected: absent.**
- [ ] 37. **Logs:** Command Palette → **Developer: Open Logs Folder** (and
      *Developer: Show Logs…* → *Extension Host*); search the log files for the
      token. **Expected: absent.**
- [ ] 38. **Error path:** stop the CLI or make the host reject the token (set
      `melink.ollama.baseUrl` to an endpoint returning 401, or use an expired
      token), send a turn, and confirm the resulting notice text contains no token.
      Search the Output panel again for the token. **Expected: absent.**
- [ ] 39. **Static check (optional but recommended):** from the repo:
      ```sh
      grep -RIn "melink.ollama.token\|OLLAMA_TOKEN" src dist | grep -v node_modules
      ```
      and confirm the only uses are `secrets.store` / `secrets.get` against
      `OLLAMA_TOKEN_SECRET_KEY`. Confirm the token is only ever read into the
      `Authorization` header and never interpolated into an error string.
- [ ] 39b. **Clear:** **Agent: Clear Ollama Cloud token**, then confirm a subsequent
      turn reports *unauthenticated* (not a raw 401) with a **Set token** action.

---

## 4a. Codex ChatGPT-auth forcing (RC-4b)

The extension spawns `codex app-server` with the inherited credential variables
scrubbed and passes `-c 'forced_login_method="chatgpt"'` ahead of the subcommand,
so Codex uses the ChatGPT login in `$CODEX_HOME/auth.json` rather than an API key
it inherited from the environment. These checks confirm it end to end.

- [ ] 39j. Confirm the CLI reports the ChatGPT login outside the extension:
      `codex login status` → **Logged in using ChatGPT**.
- [ ] 39k. **Inherited-key isolation.** Set `OPENAI_API_KEY` to a distinctive,
      non-real value (e.g. `sk-svcacct-TEST-ONLY-7f3a`) in the environment the
      extension host inherits (a shell profile or the launch config), then reload
      the host. Send a Codex turn. **Expected:** the turn succeeds, and the
      Output channel shows no request carrying that key. (If the turn instead
      401s with *Incorrect API key provided*, the scrub did not take effect;
      record it as a failure with the spawn args from the *(Agent sidebar
      (Codex))* output channel.)
- [ ] 39l. **Config independence.** Add `forced_login_method = "api"` to
      `~/.codex/config.toml`, reload, and send a Codex turn. **Expected:** the
      extension's per-invocation override wins, so the turn still uses ChatGPT
      and does not 401. Remove the line afterwards.
- [ ] 39m. **Auth mode reported.** Open **Settings → Providers → Codex**. The
      **Login state** row shows *Signed in. …* and a *Reported auth method:
      chatgpt* line.
- [ ] 39n. **Mismatch is distinct.** Point the CLI at an API-key login (e.g.
      `codex login --with-api-key` with a throwaway key), reload, and open
      Settings. **Expected:** the Codex chip reads **API key, not ChatGPT**, the
      Login state explains the mismatch, and the provider is not reported as a
      plain signed-in success. Restore the ChatGPT login afterwards.
- [ ] 39o. **Ollama-only silence.** Select Ollama, then force a Codex auth
      failure (steps 39k/39n). **Expected:** no notice, banner, or error text
      about Codex appears anywhere while Ollama is the active provider.

---

## 4b. Project-awareness pass (RC-5)

Run this in a **real project workspace** (not the empty scratch workspace), with a
README and at least one source directory, so the answer has something to name.
Pick one provider at a time; every check must pass for each provider you use.

The point is that the agent answers from what the extension delivered, not from
what you typed and not from a web search. Do not paste any project fact.

### Fresh thread

- [ ] 39c. Open the real project workspace, reload, and open the sidebar. Start a
      **new conversation** (the new-chat icon).
- [ ] 39d. Ask exactly: **"what is this project about?"** and send.
      **Expected:** the reply names the project **name**, its **root**, its
      **purpose** (from the instructions/README), its **main languages**, and an
      **entry point** — none of which you supplied. With no tool support it must
      still answer; with tool support it may read files, but it must not claim it
      cannot see the project.
- [ ] 39e. **No synthetic messages in the transcript.** Confirm the transcript
      shows only your question and the reply: no `<project-context>` block, no
      system message, and no duplicate of your turn.

### Resumed thread

- [ ] 39f. Reload the window and reopen the sidebar (the thread resumes). Confirm
      the prior messages are still visible and coherent, then ask a follow-up
      about the project (e.g. "which directory holds the source?"). **Expected:**
      the resumed thread is re-primed and answers from the project; no error and
      no lost history.

### Workspace change mid-thread

- [ ] 39g. Without reloading, open a different file (or select some code), then
      send a turn that depends on the change, e.g. *"what file am I looking at
      and what is selected?"* **Expected:** the reply reflects the active file /
      selection you just changed.
- [ ] 39h. Create or delete a file in the workspace, then send a turn asking
      whether it saw the change. **Expected:** the per-turn delta mentioned the
      changed file, so the reply reflects it without a reload.

### Manual refresh

- [ ] 39i. Make another workspace change, then click the **Refresh project
      context** button in the header (the document icon next to the availability
      refresh). Send a turn that depends on the change. **Expected:** the next
      turn reflects it, without a window reload.

### Degradation

- [ ] 39j. **Snapshot failure degrades.** Point the workspace at a state where the
      snapshot cannot be built (or use an over-budget project — a large tree with
      `melink.context.exclude` empty). Send a turn. **Expected:** a plain-language
      notice in place of the context, the turn still sends, and no blocking error.
- [ ] 39k. **Record the pinned versions** the priming path was verified against:
      Codex CLI (step 0.3) and opencode (`opencode --version`, baseline `1.1.65`).
      ..............................

### What is sent by default (for the tester's reference)

- **Ollama Cloud, direct path:** the snapshot as a `system` message before the
  first user turn; a compact delta as a `system` message before later turns. No
  context is ever persisted as transcript content.
- **Codex:** the snapshot in the native `developerInstructions` field on
  `thread/start` and `thread/resume`; the thread `cwd` is the workspace root, so
  Codex reads project files and `AGENTS.md` from the right place.
- **opencode (when `melink.ollama.opencode.enabled` is on):** the snapshot is
  primed into the turn text, because the pinned `opencode run` exposes no
  system/instructions flag; the child is spawned in the workspace root. With the
  setting **off**, the direct `/api/chat` body is unchanged apart from the context
  messages and **no** `opencode` child is spawned.

---

## 4c. Change review, conflict, and checkpoint pass (RC-6)

A turn that edits files is recorded in a per-turn journal and surfaced as a
**Changes this turn** panel in the sidebar. This pass proves the safety
properties a feature that writes to users' files must have.

### Provider capture paths (why every pass runs on both)

The bytes the review compares come from two different capture paths, so a pass
must pass on both; a defect in one is not masked by the other.

- **Codex** reports every path an `apply_patch` touched through a structured
  `fileChanges` notification (`item/fileChange/patchUpdated`, `item/completed`),
  so those files get a **reported** before/after side.
- **opencode** (Ollama with `melink.ollama.opencode.enabled` on) reports file
  tool edits as **reported** too. A shell-driven write (a formatter, codegen,
  `git apply`) emits no structured event on either provider and is caught by the
  **watcher** fallback instead, which usually only has an after side.

Unless a pass says otherwise, run it once with Codex selected and once with
Ollama selected (opencode runtime on), and tick both. A pass that names a single
provider says so explicitly.

### Setup shared by every pass

- [ ] S1. Use a scratch workspace that is a **git repository with at least one
      commit** (run `git init && git add -A && git commit -m scratch` once in the
      step 0.6 folder if it is not). Open it in a terminal and confirm it is
      clean before starting each pass:
      ```sh
      git status --porcelain
      ```
      **Expected:** no output (a clean tree). This is the baseline every pass
      restores to.
- [ ] S2. Note the exact bytes of a file before a review with:
      ```sh
      git diff -- <path>
      ```
      or, when the file is new, `git status --porcelain` (the `??` row). The
      restore checks compare the working tree, so a stale editor buffer will
      corrupt the result — close any editor holding a changed file before
      rejecting, or accept that the buffer may rewrite it back.
- [ ] S3. **No auto-decisions.** For every pass below, leave the panel
      untouched for at least a minute after it appears and confirm nothing is
      accepted or rejected on a timer, a retry, or a reconnect. The panel must
      sit on **No decision yet** until a human acts.

### Pass 1 — single-file modify

*Applies to: Codex and opencode (both).*

- [ ] 47. Ask the agent to change **one** line in a tracked scratch file, e.g.
      *"append the line `review-pass-1` to `scratch.txt`"*. Wait for the turn to
      complete.
      - **Expected:** the **Changes this turn** panel appears with the `1 file`
        chip, a **Modified** status chip, and one row for `scratch.txt` with
        **No decision yet**. The header shows `1 to review · 1 undecided` and
        `+1`/`-0` stats. The `scratch.txt` working tree now contains the new line.
- [ ] 47a. Click **Keep** on the row, then confirm `git diff -- scratch.txt`
      still shows the change.
      - **Expected: Keep writes nothing.** The row reads **Kept**, the turn is
        `All decided`, and the file on disk is byte-for-byte what the turn left.
        `git status --porcelain` shows the modified file. Keep is not undoable
        from the panel, so restore the original yourself with
        **`git checkout -- scratch.txt`** before the next step.
- [ ] 47b. Starting from the clean `scratch.txt`, ask the agent to make the same
      edit again (a fresh turn), then click **Reject** and confirm the
      destructive confirmation that names `scratch.txt`.
      - **Expected: Reject restores the exact pre-turn bytes.** The row reads
        **Rejected**; `git diff -- scratch.txt` prints **nothing** and
        `git status --porcelain` no longer lists the file — the bytes match the
        pre-turn original exactly, not merely "a similar" file.
- [ ] 47c. **Cleanup:** `git checkout -- scratch.txt` (a no-op after a correct
      reject) and confirm `git status --porcelain` is empty.

### Pass 2 — multi-file turn, counts, and bulk decisions

*Applies to: Codex and opencode (both).*

- [ ] 48. **Counts.** Ask the agent to change **three** tracked files in one turn,
      e.g. *"add a `review-pass-2` marker line to `a.txt`, `b.txt`, and `c.txt`"*.
      - **Expected:** the panel shows the `3 files` chip, three **Modified**
        rows, per-file `+`/`-` stats, and a total in the summary. Each row is
        independently **No decision yet**.
- [ ] 48a. **Per-file decisions.** Click **Keep** on `a.txt` and **Reject** on
      `b.txt` (confirm the named-path confirmation), leaving `c.txt` undecided.
      - **Expected:** `a.txt` reads **Kept** and still contains the marker;
        `b.txt` reads **Rejected** and its diff is gone (`git diff -- b.txt` is
        empty); `c.txt` still reads **No decision yet** and the summary shows
        `1 undecided`. A partial decision never auto-fills the rest.
      - **Reset before the next step:** `git checkout -- a.txt b.txt c.txt`.
- [ ] 48b. **Keep all.** With all three files clean, run a fresh turn that
      changes all three again, then click **Keep all**.
      - **Expected:** every row reads **Kept**, the footer shows `All decided`,
        and `git diff` shows all three changes intact. **Keep all writes
        nothing.** **Reset:** `git checkout -- a.txt b.txt c.txt`.
- [ ] 48c. **Reject all.** Run one more fresh turn that changes all three, click
      **Reject all**, and confirm the confirmation that lists all three paths.
      - **Expected:** every row reads **Rejected** and `git status --porcelain`
        is empty for all three files; the pre-turn bytes are back.
- [ ] 48d. **Cleanup:** `git checkout -- a.txt b.txt c.txt` and confirm
      `git status --porcelain` is empty.

### Pass 3 — created and deleted files

*Applies to: Codex and opencode (both).*

- [ ] 49. Ask the agent to **create** a new scratch file, e.g. *"create
      `created.txt` containing `hello`"*. **Expected:** a row with a **Created**
      status chip and a diff whose left side is empty.
      - Click **Reject** and confirm. **Expected: rejecting a created file
        deletes it** — `created.txt` no longer exists and `git status
        --porcelain` shows no `?? created.txt` row.
- [ ] 49a. Ask the agent to **delete** a tracked scratch file, e.g. *"delete
      `gone.txt`"*. **Expected:** a row with a **Deleted** status chip and a
      diff whose right side is empty.
      - Click **Reject** and confirm. **Expected: rejecting a deleted file
        recreates it with the pre-turn bytes** — `gone.txt` is back and
        `git status --porcelain` is clean (the recreated bytes match the
        committed original exactly; verify with `git diff -- gone.txt`, which
        prints nothing).
- [ ] 49b. **Cleanup:** remove any file the turn created that was **kept**
      (`rm -f created.txt`), and `git checkout -- gone.txt` to be safe. Confirm
      `git status --porcelain` is empty.

### Pass 4 — rename

*Applies to: Codex and opencode (both).* Rename recognition matches a before-only
path to an after-only path with an identical content hash.

- [ ] 50. Ask the agent to **rename** a tracked scratch file without editing it,
      e.g. *"rename `old.txt` to `moved.txt`"*. **Expected:** a single row for
      `moved.txt` with a **Renamed** status chip (never a separate Delete row
      plus a Create row), and its inline diff is a pure move (no content change
      when the agent moved it verbatim).
- [ ] 50a. Click **Reject** and confirm. **Expected:** `moved.txt` is gone and
      `old.txt` is back with its original bytes; `git status --porcelain` is
      clean.
- [ ] 50b. **Cleanup:** `git checkout -- .` and remove any leftover `moved.txt`,
      then confirm `git status --porcelain` is empty.

### Pass 5 — binary and oversized files

*Applies to: Codex and opencode (both).* The inline cap is 2 MiB and a NUL byte
in the first bytes marks content binary; either makes a file non-reviewable but
still listed.

- [ ] 51. Ask the agent to **modify a binary file** (a small PNG or any file
      containing a NUL byte — e.g. `git show :scratch.bin > scratch.bin` before
      the turn). **Expected:** a row whose status chip reads **Binary**, a
      **non-reviewable** note in place of a diff (*"Binary file: the content is
      recorded but not shown as text."*), no inline diff, and the footer notes
      `1 not reviewable`. The row still supports **Keep** and **Reject**.
- [ ] 51a. On that row click **Open in editor** (and **Open diff**).
      - **Expected:** **Open in editor** opens the working file in a normal
        editor; **Open diff** opens the built-in diff editor with an **empty**
        left side (the binary before content is recorded but never rendered as
        text). Neither writes a temp file into the workspace, and the diff
        editor's virtual side cannot be saved.
- [ ] 51b. Ask the agent to **modify a file larger than 2 MiB** (e.g.
      `head -c 3000000 /dev/urandom > big.txt` before the turn, then have the
      agent append to it). **Expected:** a row whose chip reads **Too large**, a
      non-reviewable note (*"The file is too large to show as a diff."*), no
      inline diff, and no inline content stored for it. **Open in editor**
      still works.
- [ ] 51c. **Cleanup:** `git checkout -- scratch.bin big.txt` (or delete them if
      they were created by the pass), then confirm `git status --porcelain` is
      empty and no `big.txt`/`scratch.bin` remains tracked as changed.

### Pass 6 — shell-only change (watcher fallback)

*Applies to: Codex and opencode (both).* A formatter or codegen invoked through
the shell emits no structured edit event, so only the fallback watcher sees it.

- [ ] 52. Ask the agent to run a shell command that writes a file **without**
      using its file-edit tool, e.g. *"run `printf 'watched\\n' > watched.txt`
      in the workspace"* (or run a formatter over an existing scratch file).
      Wait for the turn to complete.
      - **Expected:** `watched.txt` appears in the review panel and its
        **Created**/**Modified** status matches the end state. This proves a
        shell-only change is captured rather than missed. (A created-by-shell
        file has no before side, so its inline diff may show an empty left — that
        is correct, not a defect.)
      - **Confirm the watcher did it** (the `source` is recorded, not shown in
        the panel). Read the journal index (see pass 12) and check the entry for
        `watched.txt` has `"source": "watched"`, not `"reported"`.
- [ ] 52a. Click **Reject** on the `watched.txt` row and confirm. **Expected:**
      the rejected created file is deleted (`git status --porcelain` shows no
      `?? watched.txt`).
- [ ] 52b. **Cleanup:** `rm -f watched.txt`, `git checkout -- .`, and confirm
      `git status --porcelain` is empty.

### Pass 7 — turn with no changes

*Applies to: Codex and opencode (both).*

- [ ] 53. Send a turn that only answers a question and touches **no** file,
      e.g. *"reply with the single word `ok`; do not change any file"*.
      - **Expected: no review surface appears at all.** There is no **Changes
        this turn** panel, no empty panel, and no stale panel from the previous
        turn left on screen. Silence is not rendered as "0 files changed".
- [ ] 53a. **Cleanup:** confirm `git status --porcelain` is empty. (A turn that
      changed nothing needs no revert.)

### Pass 8 — conflict on external edit

*Applies to: Codex and opencode (both).* This is the silent-clobber guard: a file
edited by hand after the turn is never overwritten by a reject unless the user
explicitly opts in.

- [ ] 54. Ask the agent to modify one tracked file, e.g. *"append `agent-line` to
      `conflict.txt`"*. Wait for the turn and leave the row **No decision yet**.
- [ ] 54a. **Edit the same file by hand, outside the agent** — add a distinctive
      line, e.g. append `manual-line` in the editor and **save**. Note the exact
      new content:
      ```sh
      git diff -- conflict.txt
      ```
      This hand edit is the external change the guard must protect.
- [ ] 54b. In the sidebar, click **Reject** on the `conflict.txt` row and
      confirm the confirmation.
      - **Expected: a conflict state, not a silent clobber.** The row shows the
        **Conflict: the file changed on disk. Choose explicitly.** state with two
        actions — **Keep what is on disk** and **Overwrite with pre-turn** — and
        the file is **left byte-for-byte as you saved it** (`git diff --
        conflict.txt` still shows `manual-line`; neither `manual-line` nor
        `agent-line` is silently removed). A failure here is the file being
        reverted without a choice, or the agent line surviving with no conflict
        shown.
- [ ] 54c. Click **Keep what is on disk**. **Expected:** the row resolves to
      **Rejected**, and the file on disk is **unchanged** — it still contains
      `manual-line` (verify with `git diff -- conflict.txt`). Nothing was
      written and the hand edit survives.
- [ ] 54d. **Opt-in overwrite.** Repeat steps 54–54b, then click **Overwrite
      with pre-turn**.
      - **Expected:** this time the file is reverted to the exact **pre-turn**
        bytes (`git diff -- conflict.txt` is empty), because the user explicitly
        chose the overwrite. This distinguishes the two conflict outcomes: the
        default leaves the disk untouched, the explicit choice writes.
- [ ] 54e. **Cleanup:** `git checkout -- conflict.txt`, then confirm
      `git status --porcelain` is empty.

### Pass 9 — checkpoint restore

*Applies to: Codex and opencode (both).* A checkpoint is the pre-turn snapshot of
the message that opened a turn. Restore reverts files only; the transcript is
never touched, and the restore is itself undoable.

- [ ] 55. In one thread, send **three** turns that each change a file (e.g.
      append `c1` to `chk.txt`, then `c2`, then `c3`), waiting for each to
      complete. Note the message rows that carry a **Restore checkpoint** action
      in the transcript.
      - **Expected:** each of the three messages whose turn touched `chk.txt`
        offers a **Restore checkpoint** action (a message whose turn touched
        nothing offers none).
- [ ] 55a. **Restore an earlier checkpoint.** On the **first** message's
      **Restore checkpoint**, open the confirmation. It must name the file count
      and the affected path(s).
      - **Expected:** after confirming, `chk.txt` reverts to its content
        **before the first turn** — `c1`, `c2`, and `c3` are all gone, i.e.
        later turns are included, and the file matches its pre-session original.
        Verify with `git diff -- chk.txt` (empty) or by reading the file.
- [ ] 55b. **Transcript is untouched.** Confirm the conversation still shows
      **all three** user messages and **all three** assistant replies, in order;
      restore does not delete or truncate messages. The checkpoint/restore strip
      reports the restore as **complete** (not partial).
- [ ] 55c. **Restore is undoable.** In the restore-result strip, click **Undo
      restore**.
      - **Expected:** `chk.txt` returns to the content it held *just before the
        restore* (the end state with `c1`/`c2`/`c3`), and the strip reports the
        undo. Confirm with `git diff -- chk.txt`. This proves the pre-restore
        snapshot was captured before any file was written.
- [ ] 55d. **Partial restore is reported.** Make a second file change in a fresh
      turn, then manually edit **one** of the checkpoint's files before
      restoring.
      - **Expected:** the restore result names the hand-edited file as
        **conflict/left unchanged** and reports the restore as **partial**; it
        is never reported as a full success, and the edited file is not
        clobbered. Files with no external edit are reverted.
- [ ] 55e. **Cleanup:** click **Undo restore** (if offered) or `git checkout -- .`,
      then confirm `git status --porcelain` is empty.

### Pass 10 — reload mid-review

*Applies to: Codex and opencode (both).* Decisions and the review set persist in
`workspaceState`, so a reload must repaint them, not reset them.

- [ ] 56. Ask the agent to modify **two** tracked files, e.g. add `reload-1` to
      `r1.txt` and `reload-2` to `r2.txt`. Leave **both** rows **No decision
      yet**.
- [ ] 56a. Decide **one** file only (click **Keep** on `r1.txt`), leaving
      `r2.txt` **No decision yet**.
- [ ] 56b. **Developer: Reload Window**, then reopen the sidebar.
      - **Expected: pending decisions survive the reload and nothing is
        auto-decided.** The panel repaints the same turn; `r1.txt` still reads
        **Kept** and `r2.txt` still reads **No decision yet**. No row flips to
        accepted/rejected on its own, and the diff/panel is not lost.
- [ ] 56c. Now **Reject** `r2.txt` (confirm) and verify the pre-turn bytes are
      restored (`git diff -- r2.txt` empty) while `r1.txt` keeps its change
      (`git diff -- r1.txt` still shows it). **Expected:** the decision made
      before the reload and the one made after act on the same recording.
- [ ] 56d. **Cleanup:** `git checkout -- r1.txt r2.txt`, then confirm
      `git status --porcelain` is empty.

### Pass 11 — approval prompt interaction

*Applies to: Codex (which raises command approvals); repeat on opencode only
when the runtime raises a prompt.* This proves the pre-execution approval gate and
the post-hoc review are independent: the prompt still blocks execution, and the
review covers the result.

- [ ] 57. Set the permission level so a command requires approval (e.g.
      **Default** or **Read-only**), then send a turn that both **prompts for a
      command** and **edits a file**, e.g. *"create `approval.txt` by running a
      shell command, then append `approved` to it"*.
      - **Expected:** the **approval prompt** appears and the turn stays blocked
        until you answer; the file is **not** changed while the prompt is
        unanswered. Nothing is auto-approved.
- [ ] 57a. Choose **Allow once** (or the equivalent single-run allowance).
      - **Expected:** the command runs, the turn completes, and **then** the
        **Changes this turn** review panel appears for `approval.txt`. The
        approval gate and the review are sequential and separate: the prompt
        gated execution, the review covers the result.
- [ ] 57b. **Reject** the review row (confirm) and confirm the file is removed or
      reverted to its pre-turn state (`git status --porcelain` clean for it).
      **Expected:** rejecting the review never re-runs the command and never
      re-opens the approval; it only restores the file.
- [ ] 57c. **Cleanup:** `git checkout -- .`, `rm -f approval.txt`, and confirm
      `git status --porcelain` is empty.

### Pass 12 — pruning, bounded blob storage, and in-review retention

*Applies to: Codex and opencode (both).* The journal index is capped by count
(default 50 turns) and the blob store by bytes (default 64 MiB), and the turn
currently under review is **never** evicted while it is on screen.

Where the journal lives:
- **Index** (turn metadata, no file content): `workspaceState` under
  `melink.changeJournal`.
- **Blobs** (recorded before/after content): under the workspace-scoped
  extension storage root, `context.storageUri` — typically
  `%APPDATA%\<Host>\User\workspaceStorage\<hash>\melink.melink-agent-sidebar\`.

- [ ] 58. **Observe the blob budget and index cap.** Open the journal index and
      confirm it carries only hashes/keys and no file content, and that its
      `turns` list is bounded. Quit the host first so the cached index is
      flushed, then locate this workspace's `state.vscdb` exactly as in step 22
      and read the key with `sqlite3`:
      ```sh
      sqlite3 state.vscdb \
        "SELECT value FROM ItemTable WHERE key='melink.changeJournal';"
      ```
      **Expected:** the JSON has a `turns` array no longer than the cap, each
      entry has `files` with hashes/`*Key` names and **no** inline content, and
      a `restorePoints` array also bounded. An oversized index (hundreds of
      entries, embedded file text) is a failure.
- [ ] 58a. **Blob store stays bounded.** In the extension storage root above,
      inspect the blob folders and their total size:
      ```powershell
      Get-ChildItem -Recurse "<storageRoot>" |
        Measure-Object -Property Length -Sum
      ```
      ```sh
      du -sh "<storageRoot>"   # macOS / Linux
      ```
      **Expected:** the total stays under the 64 MiB budget; count-based pruning
      (step 58b) is the practical way to watch eviction happen, and the byte cap
      is observed by this total never exceeding 64 MiB even after many turns.
      Blobs for evicted turns are removed (their keys no longer resolve).
- [ ] 58b. **The turn under review is never evicted.** Generate enough turns to
      exceed the index cap (more than 50 change-turns — a short scripted loop of
      *"append one line to `prune.txt`"* turns is fine and fastest on Codex),
      watching step 58's `turns` count stay capped at 50. Leave the **most
      recent** turn's review panel open with a row still **No decision yet**.
      - **Expected:** the visible turn's row and its diff **remain readable**:
        its blobs were not pruned while it is under review. `Open diff` still
        opens with a real pre-turn left side (not an empty "no longer recorded"
        degrade), and **Reject** still restores the exact pre-turn bytes — even
        though older turns in the index have already been evicted.
- [ ] 58c. **Retention is not a claim of permanence.** Close the review (decide
      every row or start a new turn so the old turn is no longer under review),
      then generate more turns past the cap.
      - **Expected:** the previously protected turn may now be evicted and its
        `Open diff` degrades to the explanation *"This turn is no longer
        recorded…"* rather than throwing. This is expected; only the **currently
        reviewed** turn is guaranteed retained.
- [ ] 58d. **Cleanup:** decide/close the open review, delete `prune.txt`,
      `git checkout -- .`, and confirm `git status --porcelain` is empty. To
      reset the journal itself, delete its blobs under the storage root and the
      `melink.changeJournal` key from `state.vscdb` (optional; a clean scratch
      workspace for the next run also does this).

---

## 5. Per-host pass

The view lifecycle and child-process lifetime can differ between hosts.

- [ ] 40. Repeat the full provider matrix (Passes A–D) in **plain VS Code** (stable)
      and in **one Open VSX consumer** (e.g. Cursor, VSCodium).
- [ ] 41. Repeat the reload test (§2) and the teardown test (§3) in both hosts.
- [ ] 41b. Repeat Passes E (opencode-enabled) and F (fallback) in both hosts, and
      in each host confirm the off path spawns no `opencode` process
      (step 14o).
- [ ] 42. Repeat the rendering checks in both hosts:
      - transcript streaming caret and provider dot;
      - tool card and file-change/diff card render with host theme colors;
      - the model switcher and history panels float over the chat with a usable
        minimum height, and their content remains scrollable without clipping;
      - mode, permission, model-settings, and context panels float above the
        composer without resizing it, and the transcript still scrolls;
      - light and dark workbench themes both leave the sidebar legible.
- [ ] 43. Record both host versions in the header of this document.
- [ ] 44. Repeat the project-awareness pass (§4b) on the **direct Ollama path**
      (opencode off) in both hosts. Confirm the §4b "what is sent by default"
      notes hold: the snapshot is a `system` message, no synthetic message appears
      in the transcript, and the next turn reflects the change.
- [ ] 45. Repeat the project-awareness pass (§4b) with the **opencode runtime
      enabled**. Confirm the snapshot is primed into the turn text and the child
      runs in the workspace root (ask it to name the root; it should match).
- [ ] 46. Repeat the project-awareness pass (§4b) with the **opencode runtime
      disabled** and confirm the fallback is exact: the request payload is
      unchanged apart from the context messages and **no** `opencode` child is
      spawned (step 14o).

---

## 6. Validation log

The parts that do not need a GUI host were executed during authoring and are
recorded below; the GUI steps must be completed and signed by a tester. A step that
fails is either fixed (recorded in the headless section) or listed under §7.

- Environment validated in: `Windows 11 (10.0.26200), Cursor 3.21.18 (Open VSX), codex-cli 0.156.1`
- Executed by: authoring run on 2026-09-24 (headless checks only)
- Result summary: headless checks pass; app-server adapter exercised against the
  live CLI; GUI matrix outstanding
- Defects found and fixed during validation:
  - orphaned Codex process on dispose — tree-kill teardown in
    `src/backends/appserver/connection.ts`
  - missing-CLI misdetected as unauthenticated — replaced by an explicit
    `unavailable` classification in `AppServerConnection`
  - double `thread/started` and double-opened item cards — deduped per id in
    `src/backends/codex.ts`
- Failures recorded as known limitations: plain-VS-Code and GUI-only checks (see §7)

### Executed headlessly (host-independent checks)

These were run from the repo during authoring, without a GUI host:

- [x] **Build & typecheck & tests:** `npm run lint`, `npm run build`, and
      `npm test` all pass (192 pure unit tests cover JSON-RPC framing, the
      backoff schedule, item translation, project-context rendering/delivery,
      and the system-message order).
- [x] **Handshake against the live CLI.** Spawned `codex app-server`
      0.156.1, completed `initialize` (with `experimentalApi: true`) + `initialized`,
      and read `userAgent`, `getAuthStatus`, and `model/list`.
- [x] **Streaming a turn.** `thread/start` then `turn/start` produced the order
      `thread/started > thread/status/changed > turn/started > item/started >
      item/completed (user) > item/started > item/agentMessage/delta >
      item/completed > turn/completed`; the delta reassembled to the full reply.
      The current CLI streams the assistant message as `item/agentMessage/delta`,
      which the adapter handles explicitly (alongside the reasoning and command
      delta methods).
- [x] **Interrupt maps to `interrupted`.** `turn/interrupt` on a live turn
      produced a `turn/completed` whose `Turn.status` is `interrupted`, distinct
      from `completed` and `failed`.
- [x] **No orphan after dispose.** After `dispose()` (`tasklist /FI "IMAGENAME eq
      codex.exe"`) reported zero `codex.exe` rows. A failed first spawn form is
      killed before the bare-command retry, so the retry cannot orphan either.
- [x] **Missing binary is silent `unavailable`.** Starting with a nonexistent
      executable rejected with `kind: 'unavailable'` before writing to the server,
      and it is not retried with the other spawn form.
- [x] **Handshake timeout is specific `incompatible`.** A `initialize` that times
      out is classified `incompatible`, carrying the CLI's own `codex --version`
      (queried best-effort), never the generic `unavailable` state.
- [x] **Spawn-arg drift tolerated.** A rejected `--listen stdio://` exits early;
      the adapter retries once with the bare `codex app-server` and records which
      form started in the **Agent sidebar (Codex)** output channel.
- [x] **No experimental feature probe.** No call to `experimentalFeature/list`
      or an enablement set exists; only the documented `initialize` capability
      flag is opted into (static guard in `src/backends/protocolHygiene.test.ts`).
- [x] **Credential-hygiene static check:** the Ollama token key is used only with
      `secrets.store` / `secrets.get`; no `console.*` output of secret material
      exists in `src`.
- [x] **App-server schema version pinned.** Bindings generated with
      `codex app-server generate-ts --out ./schemas` and checked in (see §7).
- [x] **Delivery regression test (RC-5).** `npm test` covers the renderer
      (name/root/purpose/languages/entry point), the message order (snapshot as a
      `system` message before the first user turn, delta as system-role input
      only), that context never enters the persisted transcript, that a resumed
      thread is re-primed, that manual refresh re-arms priming, and that a failed
      snapshot degrades to a notice instead of throwing.
- [x] **Codex native priming verified against the pinned bindings.** The
      generated `schemas/v2/ThreadStartParams.ts` and `ThreadResumeParams.ts` for
      `codex-cli 0.156.1` expose `baseInstructions`/`developerInstructions` and
      `cwd`; `TurnStartParams` exposes no per-turn instructions field. Codex
      priming/`cwd` therefore uses the native field at start/resume, and mid-thread
      deltas are left to Codex's own file access (documented in the README).
- [x] **opencode priming surface checked.** `opencode run --help` on 1.1.65
      exposes no system/instructions flag, so the fallback is prompt priming;
      recorded in the README and in code as a deliberate fallback.

### Requires a human on a GUI host

The following could not be exercised from this non-GUI environment and must be
completed and signed by a tester: all of §1 (provider matrix), §2 (reload),
§3 (teardown, steps 25–33), §4 (credential hygiene in the UI), §4b (project
awareness, which needs a live model), §4c (change review and checkpoints, which
need a live model plus a git workspace), and §5 (per-host).

---

## 7. Known limitations

- **Codex app-server is experimental.** The integration drives the
  `codex app-server` JSON-RPC protocol over stdio. The CLI labels the command
  `[experimental]`, so its protocol may change between releases; the checked-in
  bindings under `schemas/` turn that drift into a build/type error.
- **Pinned versions the priming path was verified against:** `codex-cli 0.156.1`
  (Windows x86_64) and `opencode 1.1.65`. Re-run §0 step 0.3 and
  `opencode --version` and confirm these before signing off; a different version
  invalidates the field/flag assumptions below.
- **Codex has no per-turn instructions field.** In the pinned bindings,
  `baseInstructions`/`developerInstructions` exist on `thread/start` and
  `thread/resume` only. Mid-thread workspace changes are therefore not injected as
  a delta on the Codex path; Codex's own file access (rooted at the workspace
  `cwd`) is relied on instead. This is a deliberate limitation, not an oversight.
- **opencode primes through the prompt.** The pinned `opencode run` exposes no
  system/instructions flag, so the snapshot is prepended to the turn text. It is
  still not written to any transcript, and the child still runs in the workspace
  root.
- **Generated-schema version.** The app-server bindings behind this script were
  generated from the installed 0.156.1 CLI and are checked in under `schemas/`:
  ```sh
  codex app-server generate-ts --out ./schemas
  ```
  (also `npm run schemas:generate`). Regenerate and fix any resulting type
  errors before treating an app-server result as valid.
- **Plain VS Code not available in the authoring environment** (only an Open VSX
  consumer, Cursor 3.21.18). The `Per-host pass` for VS Code stable remains
  unverified here and must be run by the tester.
- **GUI-only.** View resolution, theme inheritance, and process lifetime on editor
  quit cannot be observed from a headless shell; the corresponding steps are marked
  as requiring a GUI host.
