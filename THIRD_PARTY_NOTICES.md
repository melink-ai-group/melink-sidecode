# Third-party notices

sideCode is licensed under the [sideCode Source-Available License](LICENSE.md). It bundles or downloads third-party software that remains under its own license.

## Direct production dependencies

| Package | Version range | License | Use |
|---|---|---|---|
| `@xenova/transformers` | `^2.17.2` | Apache-2.0 | Local Whisper transcription runtime. |
| `ffmpeg-static` | `^5.3.0` | GPL-3.0-or-later | Staged FFmpeg binary used for dictation audio. |
| `playwright-core` | `^1.56.1` | Apache-2.0 | Browser automation used by the optional browser tools. |
| `react` | `^18.3.1` | MIT | Webview UI. |
| `react-dom` | `^18.3.1` | MIT | Webview UI. |

The production dependency tree contains 102 packages. The generated inventory reports 63 MIT, 15 Apache-2.0, 12 BSD-3-Clause, 7 ISC, 1 BSD, 1 Apache-2.0-compatible dual license, and `ffmpeg-static` under GPL-3.0-or-later. Regenerate the inventory with:

```sh
npx --yes license-checker --production --summary
```

## FFmpeg and GPL-3.0-or-later

`ffmpeg-static@5.3.0` downloads an FFmpeg binary from the
[ffmpeg-static b6.1.1 release](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1).
The binary is distributed under the **GNU General Public License, version 3 or later**. The sideCode source remains under the [sideCode Source-Available License](LICENSE.md); the GPL applies to the bundled FFmpeg binary and its corresponding source.

- GPL-3.0 text: <https://www.gnu.org/licenses/gpl-3.0.txt>
- FFmpeg source: <https://ffmpeg.org/download.html>
- The exact binary release and checksums are published on the `ffmpeg-static` release page linked above.

The FFmpeg binary itself may be redistributed under GPL-3.0-or-later; keep this notice and the FFmpeg license with it, and make the corresponding source available as the GPL requires. The sideCode license restricts redistribution of the rest of a VSIX, but it does not remove GPL rights in this binary. If you prefer not to ship GPL binaries, build a VSIX without the dictation assets or replace the binary with an LGPL-compatible build.

## Whisper model

The dictation runtime downloads the `Xenova/whisper-tiny` model on first use. The model card and its license are published at <https://huggingface.co/Xenova/whisper-tiny>. The model is cached locally by the Transformers.js runtime; it is not part of this repository.

## Development-only packages

The test, typecheck, lint, packaging, and visual harness use additional development dependencies (for example TypeScript, Vitest, esbuild, jsdom, Testing Library, and `@vscode/vsce`). They are not part of the runtime VSIX. Their licenses are recorded in the generated inventory above.

## Trademarks

sideCode and the meLink logo are project marks. Cline, Cursor, VS Code, Open VSX, Ollama, OpenAI Codex, OpenCode, and other names are trademarks of their respective owners. References in the README are informational and do not imply endorsement.
