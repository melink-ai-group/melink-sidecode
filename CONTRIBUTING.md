# Contributing to sideCode

Thanks for taking the time to improve sideCode. This project is a TypeScript VS Code extension with a React webview, four provider backends, and a host-free test suite.

## Before you start

- Node.js **22.6+** for tests and typecheck; CI uses **22.12**. Building and packaging need Node **20+**.
- VS Code **1.93+** for the Extension Development Host.
- Read [README.md](README.md), [docs/usage.md](docs/usage.md), and [docs/settings-audit.md](docs/settings-audit.md) before changing provider or permission behavior.

## Set up

```sh
npm ci
npm run build
```

Press **F5** in VS Code to launch the Extension Development Host. For a rebuild loop, run `npm run watch` in a terminal first.

## Commands

| Command | What it does |
|---|---|
| `npm ci` | Install exactly the locked dependency tree. |
| `npm run build` | Build `dist/extension.js`, `dist/webview.js`, and `dist/webview.css`. |
| `npm run typecheck` | `tsc --noEmit`; `npm run lint` is an alias. |
| `npm test` | Node unit suite, `tools/**/*.test.mjs` suite, and the jsdom/Testing Library webview suite. |
| `npm run verify` | Check `docs/manual-test.md` version, node test file/test counts, hex counts, and typecheck baseline against the tree. |
| `npm run check:hex` | Fail on literal hex colours in `src/webview/styles.css` or a drift between `tokens.css` and `design-systems/melink/tokens.css`. |
| `npm run eval` | Run the deterministic offline golden-scenario eval. |
| `npm run visual` | Render the built webview in installed Chrome or Edge and write screenshots under `.melink/reports/visual/`. |
| `npm run package` | Build a VSIX for the current host. |
| `npm run package-platform -- --target win32-x64` | Build a platform-named VSIX after `npm run build` and `npm run verify:dictation`. |

## Project shape

- `src/extension.ts` — activation, commands, registrations.
- `src/sidebarView.ts` — webview/host glue, reload and restore lifecycle.
- `src/backends/` — provider-neutral adapter seam, Codex app-server, Ollama/OpenCode runtime, modes, permissions.
- `src/webview/` — React sidebar UI, state reducer, and styles.
- `src/context/` — bounded project snapshot, conventions, and repo map.
- `src/changes/` — turn journal, blob store, review, and native diff planning.
- `docs/` — usage, manual test, browser, CLI pin, visual harness, and settings audit.

## Code conventions

- TypeScript, two-space indentation, double quotes, semicolons.
- Keep host-free modules free of `vscode` imports; put the binding in a separate file.
- Do not hardcode colours in `src/webview/styles.css`. Use the CSS variables and the brand tokens; run `npm run check:hex`.
- Keep user-visible copy in the existing surfaces and use real typographic characters (for example `…` and `→`), not double-encoded text.
- Do not add network telemetry. Project content must go only to the provider the user selected.

## Tests and documentation

- Add a `*.test.ts` next to the module you change. DOM tests use `*.dom.test.tsx` and the harness in `src/webview/domSetup.ts`.
- Run `npm test`, `npm run typecheck`, and `npm run verify` before opening a pull request.
- If you add or remove a node test, update the **Node test files** and **Node tests** counts in `docs/manual-test.md`; `npm run verify` checks them.
- If you change a setting, update `package.json`, the settings screen, `docs/usage.md`, and `docs/settings-audit.md`.

## Pull requests

- Branch from `main` and keep commits focused. Imperative commit subjects are preferred.
- Describe the user-visible behavior, the tests you ran, and any provider or host limitation.
- Never commit a token, `.env`, `.vscode/settings.json`, a personal absolute path, or a generated `.vsix`.
- Do not bundle unrelated formatting changes with a behavior change.
- By contributing, you agree that your contribution is licensed under the MIT License.

## Security

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md) and use GitHub private vulnerability reporting.
