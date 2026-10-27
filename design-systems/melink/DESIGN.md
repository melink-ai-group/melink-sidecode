# sideCode (VS Code / Open VSX extension)

This file is the brand contract for designer-agent prototypes and OpenCode UI work. Tokens live in `tokens.css`.

## 1. Brand

Editor-native, quiet, informative. Never competes with the workbench. Sentence case, no exclamation marks. Theme-following: inherits workbench colors and fonts, brand hue only on provider identity and streaming state. One primary action per region.

Density: **compact**. Default theme: **light**.

## 2. Color

| Token | Hex |
|---|---|
| `--melink-shell` | `#019ACE` |
| `--melink-primary` | `#006F8F` |
| `--melink-bg` | `#F4FAFD` |
| `--melink-surface` | `#FFFFFF` |
| `--melink-text-primary` | `#0F2A33` |
| `--melink-on-accent` | `#1A1604` |
| `--melink-on-primary` | `#FFFFFF` |
| `--melink-scrim` | `#000000` |
| `--melink-mask` | `#000000` |

Semantic: success `#4CAF50`, danger `#E53935`, warning `#F57C00`. Never invent hex values in new UI. Neutral utility tokens: `--melink-on-accent` (text on the yellow accent), `--melink-on-primary` (text on primary/dark overlays), `--melink-scrim` (overlay and shadow mixes), `--melink-mask` (mask gradients). These are not brand hues.

## 3. Typography

- **Inter, -apple-system, 'Segoe UI', sans-serif** for body, UI, nav, and buttons.
- Sizes: sm 11px, md 13px, lg 16px.

## 4. Spacing and radius

Spacing: 4 / 8 / 16.
Radius: sm 4px, md 6px, lg 8px.

## 5. Preview sample

The Design stage preview is a brand sample only. It is not the product layout.
Current sample: **Console**.
Header caption: Example — agent chat.

Console navigation (sample chrome only):
- Desktop: left, collapsed
- Tablet: left, collapsed
- Mobile: bottom, expanded

## 6. Notes

MANDATORY INHERITANCE LAYER — never hardcode these hexes in product UI. `src/webview/styles.css` is checked by `npm run check:hex` (`scripts/check-no-hex.mjs`), which fails on any literal hex or hex `var()` fallback and verifies `tokens.css` is byte-identical to `design-systems/melink/tokens.css`; `src/webview/stylesHygiene.test.ts` runs the same gate under `npm test`. Do not rely on review alone. In the webview: bg -> var(--vscode-sideBar-background); composer input -> var(--vscode-input-background)/--vscode-input-border/--vscode-input-foreground; tool + diff cards -> var(--vscode-editorWidget-background) with var(--vscode-widget-border); body text -> var(--vscode-foreground); meta/status text -> var(--vscode-descriptionForeground); dividers -> var(--vscode-panel-border); focus rings -> var(--vscode-focusBorder); links -> var(--vscode-textLink-foreground); code blocks -> var(--vscode-textCodeBlock-background); hover/selection rows -> var(--vscode-list-hoverBackground) and var(--vscode-list-activeSelectionBackground); chips -> var(--vscode-badge-background)/--vscode-badge-foreground. Semantic states map out: danger -> var(--vscode-errorForeground), warning -> var(--vscode-editorWarning-foreground). Brand hue is reserved for a small set of jobs: provider identity (Ollama Cloud dot/badge = #019ACE; Codex = neutral var(--vscode-foreground) at 55%), the streaming caret, and the plan and user-message highlights. Typography binds to var(--vscode-font-family) and var(--vscode-font-size), Inter is fallback only; transcript code uses var(--vscode-editor-font-family) at var(--vscode-editor-font-size). No dark variant file — themes come from the host. Radius 4/6/8 is intentionally squarer than a consumer-app default so controls sit next to workbench chrome. Model, history, composer control, and context panels float over the transcript with bounded heights; panel contents scroll internally so opening a panel does not resize the chat or composer.

## 7. Enforcement

`src/webview/styles.css` must contain no literal hex colors and no hex `var()` fallbacks. Run `npm run check:hex` (`scripts/check-no-hex.mjs`) to enforce it; the same gate runs in `src/webview/stylesHygiene.test.ts` under `npm test`. The script also requires the neutral utility tokens and verifies `tokens.css` is byte-identical to `design-systems/melink/tokens.css`.
