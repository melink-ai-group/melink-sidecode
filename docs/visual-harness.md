# Visual harness (dev only)

`npm run visual` renders the **built** sideCode webview in headless Chromium,
seeded with fixed host state, and writes twelve screens (24 PNGs) plus a
manifest and an index under `.melink/reports/visual/`.

It is a screenshot tool for reviews, not a product feature. It is excluded from
the VSIX. The host-free catalog/harness tests (`tools/visual-harness/*.test.mjs`)
do run under `npm test`; capturing itself is not part of `npm test` or CI.

## What it does

1. Builds the same `dist/webview.js` + `dist/webview.css` bundle as
   `npm run build`, using the `esbuild` version already in dev dependencies.
2. Serves it from a local-only static server (`127.0.0.1`, random port). The
   server never serves the repository root: only `dist/` and
   `tools/visual-harness/` are reachable, and dotfiles, `node_modules`, and
   traversal attempts return 404.
3. Installs a minimal `acquireVsCodeApi` mock with `getState`, `setState`, and
   `postMessage`, then posts the same `HostToWebviewMessage` objects the
   extension host would send.
4. Waits for fonts, disables animations, transitions and the text caret, and
   captures one fixed-size PNG per screen and viewport. Scrollbars are not
   hidden.
5. Applies one capture-only stylesheet for `plan-todos` (see
   [Plan/todos capture adjustment](#plan-todos-capture-adjustment)).

No extension host, provider, network request, credential, or CLI process is
involved. The webview bundle is the real built artifact; only its host is
mocked.

A lock file (`.melink/reports/visual/.run.lock`) stops two runs from deleting
each other's PNGs. A run that finds a stale lock (dead process or older than two
hours) replaces it; otherwise it exits with the owning PID.

## Prerequisites

- Node.js 20+ (same as the project).
- Google Chrome or Microsoft Edge installed.
- No new package install: `playwright-core` and `esbuild` are already project
  dependencies.

The harness finds Chrome/Edge in the usual Windows, macOS, and Linux locations.
Override it when needed:

```sh
# Use an installed channel
MELINK_VISUAL_BROWSER=chrome npm run visual
MELINK_VISUAL_BROWSER=msedge npm run visual

# Or point at a specific executable
MELINK_VISUAL_BROWSER="C:\Program Files\Google\Chrome\Application\chrome.exe" npm run visual
```

On PowerShell:

```powershell
$env:MELINK_VISUAL_BROWSER = 'chrome'; npm run visual
```

## Command

```sh
npm run visual
```

Output:

```text
.melink/reports/visual/
  chat-idle-1280x800.png
  chat-idle-390x844.png
  stream-reasoning-1280x800.png
  stream-reasoning-390x844.png
  change-review-1280x800.png
  change-review-390x844.png
  plan-todos-1280x800.png
  plan-todos-390x844.png
  settings-1280x800.png
  settings-390x844.png
  manifest.json
  index.md
```

`.melink/` is gitignored, so these artifacts stay local.

### Optional hash baseline

The manifest records a SHA-256 for every PNG. To remember the current hashes
and check a later run against them:

```sh
npm run visual -- --update-baseline
npm run visual -- --check
```

`baseline.json` is written next to the PNGs. `--check` exits nonzero when a
file is missing, extra, or has a different hash, naming the screen and viewport
(e.g. `plan-todos @ 390x844 (plan-todos-390x844.png)`). A baseline is local only
(gitignored). It is sensitive to browser version, OS, fonts, and the
limitations listed below.

At the start of every run the old `manifest.json` and `index.md` are deleted, so
a failed run cannot leave a stale manifest describing missing PNGs. The new
manifest records:

- `commit` and `dirty` (`true`/`false`, or `null` when git is unavailable);
- `harnessHash`, a SHA-256 over every file in `tools/visual-harness/`, so a
  screenshot can be tied to the exact harness revision even before a commit;
- locale, timezone, theme, DPR, and browser name/version.

## Screens and fixtures

All fixtures live in `tools/visual-harness/fixtures.mjs`; the screen list and
file naming live in `tools/visual-harness/catalog.mjs`.

| Slug | What it shows | Seeded state |
| --- | --- | --- |
| `chat-idle` | Empty chat / composer | Available Ollama, Codex, and OpenCode Zen providers, models, settings, context strip, one open chat tab |
| `stream-reasoning` | A turn mid-stream with reasoning expanded | User message, running turn, streamed reasoning, partial assistant reply, context usage |
| `change-review` | Expanded change review | Completed turn, three changed files, pending review snapshot |
| `plan-todos` | Plan card with all four steps visible (capture-only expansion) | Conversation plus a pending four-step plan |
| `settings` | Settings → Defaults | Full settings snapshot, opened through `showSettings` |
| `settings-orchestration` | Settings → Orchestration | Full settings snapshot, Orchestration tab |
| `settings-provider-local` | Settings → Providers → Ollama Local | Full settings snapshot with the local provider tab |
| `settings-save-busy` | Settings footer while saving | Host reports a busy save |
| `settings-save-success` | Settings footer after a successful save | Host reports the save outcome |
| `settings-skills-ast` | Settings → Skills → ast-grep | ast-grep enabled, CLI detected, server ready |
| `settings-skills-zvec` | Settings → Skills → zvec-grep | zvec-grep enabled, server ready, workspace index missing |
| `chat-queued` | Composer busy with queued turns | One running turn and two queued messages |

Every screen is captured at **1280x800** and **390x844** (DPR 1), so there are
always 24 expected files. Every navigation, wait, click, text assertion,
row assertion, and screenshot runs inside a per-screen context, so any failure
starts with the screen and viewport:

```text
[visual] FAILED plan-todos @ 390x844: wait for selector .plan-card: Timeout 15000ms exceeded...
```

This covers a webview that never posts `ready`, a missing selector or expected
text, a click or post-click wait that times out, page errors, short body text,
row-count/clipping assertions, and a PNG smaller than a reasonable rendered
frame. A baseline `--check` failure also names the screen and viewport.

### Plan-todos capture adjustment

The product intentionally bounds `.plan-doc` to `max-height: 216px` with its own
scrollbar, so at 1280 the fourth step and at 390 most steps fall below the
clip. For the `plan-todos` capture only, the catalog injects:

```css
.plan-doc { max-height: none !important; overflow: visible !important; }
.transcript-end { display: none !important; }
```

The second rule removes the empty 15vh/35dvh scroll-bottom spacer for this
capture. Without it the taller card makes the transcript's flex layout shrink
and clip both the card's action row and the user bubble. The capture then
asserts there are exactly four `.plan-steps li` rows, each visible and fully
inside the viewport, before taking the screenshot. This is a screenshot aid, not
a product change; scrollbars are no longer hidden by the browser flags, and the
plan is the only screen with a capture-only layout adjustment.

## Determinism

The harness fixes:

- viewport size and device scale factor 1;
- locale `en-US`, timezone `UTC`, `color-scheme: light`;
- the light workbench variables in `tools/visual-harness/theme.css`;
- animations, transitions, smooth scrolling, and the text caret (off);
- scrollbars are left visible rather than suppressed;
- fixture timestamps and IDs;
- the browser executable used for the run.

With the same OS, fonts, browser build, and harness revision, two consecutive
runs produced byte-identical PNGs in the release verification (all 24 files).

Known sources of variation:

- **OS fonts and font rasterization.** The theme asks for Segoe UI, then
  Helvetica Neue/Arial. Text metrics differ across operating systems and font
  versions, so hashes are not portable.
- **Browser version.** Chrome/Edge updates can change layout, rasterization,
  and PNG encoding. The manifest records the browser name and version.
- **Compositor rounding.** A one-gray-level anti-aliasing difference is
  possible on fractional layout edges even with animations disabled.
- **Manifest timestamp and dirty state.** `manifest.json` and `index.md` contain
  a generation timestamp, the git dirty flag, and the harness hash, so they are
  not byte-identical between runs. PNG hashes are compared, not these files.
- **Not a real webview.** There is no VS Code extension host, CSP, webview
  resource rewriting, native title bar, or host theme. The harness proves
  rendering and seeded state, not host-only behavior.

No screenshots are promised to match a real VS Code window pixel-for-pixel.

## Referencing artifacts in a report or review

- Attach or link the specific PNG(s), and name the screen and viewport:
  `change-review-390x844.png`.
- Include the manifest row (file, SHA-256, browser version, commit) when the
  exact rendered state matters.
- State that the image is a **seeded Chromium render**, not a live extension
  host capture. Do not use it to claim provider behavior, auth, CLI execution,
  or CSP results.
- For a UI change, compare the before/after PNG for the same slug and viewport,
  and mention any intended visual difference.

## Limitations

- The harness mocks every host message. A screen is only as truthful as its
  fixture in `fixtures.mjs`.
- Provider calls, credentials, extension-host lifecycle, CSP, native webview
  chrome, theme inheritance, and real file edits are not exercised.
- The `settings` screen is a render of a snapshot; it does not test saving.
- Actions that need a live host (approvals, provider streaming, checkpoint
  restore) are represented by seeded protocol messages, not by real backends.
