# Browser tools (local verification)

sideCode's browser skill lets an agent drive a headless Edge/Chrome page and
show it in an editor tab. It is a **tool for external URLs**; it is not a dev
server for this repository.

## There is no local web app to open

- This repository has **no dev, serve, or start script**, no root `index.html`,
  and no base URL. The product UI is a React webview that only renders inside
  VS Code; it is not served over HTTP.
- The browser tools therefore require an **external URL** (for example a docs
  site, a deployed app, or a throwaway local server you started yourself). Do
  not imply that `localhost` runs a sideCode app.
- **Only Ask mode asks for an origin.** In Agent and Plan, `browser_navigate`
  opens the address directly; the turn's permission level still governs the
  agent's other actions. In Ask mode every http(s) origin asks the user,
  including localhost and loopback addresses, and a granted origin stays
  allowed only for the exact scheme, host and port until the browser is
  stopped. Redirects and in-page link/form navigation are not re-prompted.
- An invalid address, a missing url, or **Deny** (Ask mode only) returns an error
  **before** Edge/Chrome launches: no page, tab or panel is created.

## Enabling it per provider

- `melink.skills.browserCodex` and `melink.skills.browserOpencode` control the
  skill per agent; the legacy `melink.skills.browser` key is the fallback when a
  specific key is unset. All default to on.
- With one provider off, its live thread loses the tools; with **both** off,
  sideCode closes the page, the editor tab and the loopback bridge.
- Each window gets its own bridge token and `browser-endpoint-<pid>-<token>.json`
  file in global storage, so two windows never share a browser. The file is
  removed when that window stops the skill.

## Tools

All tools act on the page in the editor tab the user is watching.

- `browser_navigate` — open an absolute http(s) URL. Validation happens before
  the browser launches; in Ask mode the origin consent comes first too.
- `browser_resize` — set the viewport width/height (200–3840 × 200–2160 CSS px).
- `browser_scroll` — scroll with wheel deltas in CSS pixels (`dx` right, `dy`
  down); at least one non-zero delta is required.
- `browser_snapshot` — return the accessibility tree and a PNG of the viewport.
- `browser_console` — return buffered console messages, page errors, failed
  requests and HTTP ≥ 400 responses (newest 200). The buffer clears when a new
  navigation starts; in-page links, reloads and form submissions keep it.
- `browser_click` — click by CSS selector, visible text, or viewport x/y.
- `browser_type` — type into the focused element or a selector.
- `browser_press` — press a key or chord (for example `Enter`, `Control+a`).
- `browser_assert` — check selector, visible text, exact URL and/or the last
  HTTP status within about 2 seconds. It never navigates.
- `browser_back` / `browser_forward` — move one entry in the page history.
  Fails with `There is no previous page in history.` / `There is no next page
  in history.` instead of silently doing nothing.
- `browser_reload` — reload the current page.
- `browser_close` — close the page and the editor tab. The bridge stays up; the
  next `browser_navigate` opens a fresh page. It does not turn the skill off.

## Errors and a missing browser

- `browser_navigate` tries at most **3** times inside a **15 s** overall
  deadline, with an **8 s** per-attempt `goto` timeout, then polls every
  **150 ms** for `document.readyState` `interactive`/`complete` and real
  content. Real content means non-whitespace text or an image/canvas/svg/video;
  an empty `<div id="root"></div>` shell is not ready.
- Failure text is `<url> is not reachable: <reason>` and distinguishes
  connection refused, DNS failure, other errors, and the deadline.
- If neither Edge nor Chrome starts, the tool says
  `sideCode could not start Edge or Chrome` and no tab is opened.
- Before a page exists, page tools say `The browser is not open.` (or
  `The browser is not open; navigate first.` for `browser_assert`); they do not
  launch a browser by themselves. After a failed navigation, an assertion
  reports `Navigation failed: ...` and can never pass. Stored HTTP status is
  valid only right after a successful navigation; clicks and keystrokes clear
  it.

## Screenshots are local artifacts

- With a workspace folder, every snapshot returns the inline image and also
  writes a PNG under `<workspace>/.melink/reports/browser/`.
- `.melink/` is gitignored, so screenshots stay local and must not be committed.
- A title (or the URL host) names the file; query strings and tokens are never
  part of the name. Names are unique per timestamp and counter, e.g.
  `20261021-123456-789-001-login-page.png`.
- **No workspace folder:** the snapshot still returns the accessibility text and
  inline PNG, with no `path` and a note that it was not saved to disk. It is not
  an error.

## How to verify this work

- **Extension:** `npm run watch`, then `F5` in VS Code to start the Extension
  Development Host. The sidebar appears in the Activity Bar.
- **Prototypes:** static `.design/<uuid>/` prototypes are opened as files in the
  editor; they are not served by a dev server.
- **Unit tests:** `npm test` runs the host-free `node:test` suites. Browser
  navigation/readiness, preflight consent, snapshot naming/no-folder behavior,
  history/scroll/close, and the assertion tool have no VS Code or network
  dependency, so they run there directly.
