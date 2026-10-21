# Browser tools (local verification)

SideCode's browser skill lets an agent drive a headless Edge/Chrome page and
show it in an editor tab. It is a **tool for external URLs**; it is not a dev
server for this repository.

## There is no local web app to open

- This repository has **no dev, serve, or start script**, no root `index.html`,
  and no base URL. The product UI is a React webview that only renders inside
  VS Code; it is not served over HTTP.
- The browser tools therefore require an **external URL** (for example a docs
  site, a deployed app, or a throwaway local server you started yourself). Do
  not imply that `localhost` runs a SideCode app.
- If you started a server outside this repository, localhost and loopback
  addresses open without the external-site prompt. Every other origin asks the
  user once before the page opens.

## How to verify this work

- **Extension:** `npm run watch`, then `F5` in VS Code to start the Extension
  Development Host. The sidebar appears in the Activity Bar.
- **Prototypes:** static `.design/<uuid>/` prototypes are opened as files in the
  editor; they are not served by a dev server.
- **Unit tests:** `npm test` runs the host-free `node:test` suites. Browser
  navigation/readiness, screenshot naming, and the assertion tool have no
  VS Code or network dependency, so they run there directly.

## Navigation and assertions

- `browser_navigate` tries at most **3** times inside a **15 s** overall
  deadline, with an **8 s** per-attempt `goto` timeout. It then polls for
  `document.readyState` `interactive`/`complete` and real content every
  **150 ms** until the deadline. Real content means non-whitespace text or an
  image/canvas/svg/video; an empty `<div id="root"></div>` shell is not ready,
  and `domcontentloaded` alone is not success. Every page call (`evaluate`,
  title, locator/text counts) is bounded by the same deadline.
- Failure text is `<url> is not reachable: <reason>` and the reason
  distinguishes connection refused, DNS failure, other errors, and the deadline.
- `browser_assert` checks a selector, visible text, exact URL, and/or the last
  HTTP status within about **2 s**. It never navigates and it cannot bypass the
  navigation allow-list. The stored HTTP status is valid only right after a
  successful navigation; clicks and keystrokes clear it.
- When the browser is not open, `browser_assert` does not launch a browser; it
  says `The browser is not open; navigate first.` — it is not reported as
  not-reachable. After a failed navigation, an assertion reports
  `Navigation failed: ...` and can never pass.

## Screenshots are local artifacts

- Every snapshot returns the inline image and also writes a PNG under
  `<workspace>/.melink/reports/browser/`.
- `.melink/` is gitignored, so screenshots stay local and must not be committed.
- A title (or the URL host) names the file; query strings and tokens are never
  part of the name. Names are unique per timestamp and counter, e.g.
  `20261021-123456-789-001-login-page.png`.
- No workspace folder open means the screenshot cannot be saved; the tool throws
  `No workspace folder is open, so the screenshot cannot be saved.`
