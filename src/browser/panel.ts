import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/** What the editor tab shows above the page. */
export interface BrowserTabState {
  url: string;
  title: string;
  width: number;
  height: number;
}

/**
 * Editor tab that paints the same page the agent is driving.
 * Frames are JPEG screencast shots. Clicks and keys go back to that page.
 */
export class BrowserPanel {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private pendingState?: BrowserTabState;
  private lastFrame?: string;
  private frameTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly onClick: (x: number, y: number) => void,
    private readonly onKey: (key: string) => void,
    private readonly onNavigate: (url: string) => void,
    private readonly onResize: (width: number, height: number) => void
  ) {}

  show(state: BrowserTabState): void {
    this.pendingState = state;
    if (!this.panel) {
      this.ready = false;
      this.panel = vscode.window.createWebviewPanel('melink.browser', 'Browser', vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true
      });
      this.panel.webview.html = html(this.panel.webview);
      this.panel.webview.onDidReceiveMessage((message: { type?: string; x?: number; y?: number; key?: string; url?: string; width?: number; height?: number }) => {
        if (message?.type === 'ready') {
          this.ready = true;
          this.flush();
          return;
        }
        if (message?.type === 'click' && typeof message.x === 'number' && typeof message.y === 'number') {
          this.onClick(message.x, message.y);
          return;
        }
        if (message?.type === 'key' && typeof message.key === 'string') {
          this.onKey(message.key);
          return;
        }
        if (message?.type === 'navigate' && typeof message.url === 'string') {
          this.onNavigate(message.url);
          return;
        }
        if (message?.type === 'resize' && typeof message.width === 'number' && typeof message.height === 'number') {
          this.onResize(message.width, message.height);
        }
      });
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.ready = false;
        if (this.frameTimer) {
          clearTimeout(this.frameTimer);
          this.frameTimer = undefined;
        }
      });
    }
    this.flush();
  }

  /** Coalesce screencast frames to about ten a second. */
  frame(jpegBase64: string): void {
    this.lastFrame = jpegBase64;
    if (this.frameTimer || !this.panel) {
      return;
    }
    this.frameTimer = setTimeout(() => {
      this.frameTimer = undefined;
      this.flushFrame();
    }, 100);
  }

  state(state: BrowserTabState): void {
    this.pendingState = state;
    if (this.panel) {
      this.panel.title = state.title || 'Browser';
    }
    this.flush();
  }

  close(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.ready = false;
  }

  private flush(): void {
    if (!this.ready || !this.panel || !this.pendingState) {
      return;
    }
    void this.panel.webview.postMessage({ type: 'state', ...this.pendingState });
    this.flushFrame();
  }

  private flushFrame(): void {
    if (!this.ready || !this.panel || !this.lastFrame) {
      return;
    }
    const jpeg = this.lastFrame;
    this.lastFrame = undefined;
    void this.panel.webview.postMessage({ type: 'frame', jpeg });
  }
}

function html(webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString('hex');
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Browser</title>
<style>
  body { margin: 0; height: 100vh; display: flex; flex-direction: column; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font: 13px var(--vscode-font-family); }
  header { display: flex; gap: 8px; align-items: center; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  input, button { font: inherit; color: inherit; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; }
  input { flex: 1; padding: 4px 8px; }
  button { padding: 4px 10px; cursor: pointer; }
  .meta { white-space: nowrap; opacity: 0.8; }
  main { flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; background: var(--vscode-editor-background); }
  img { max-width: 100%; max-height: 100%; object-fit: contain; cursor: crosshair; }
  p { margin: 0; padding: 24px; opacity: 0.75; }
</style>
</head>
<body>
<header>
  <input id="url" type="url" spellcheck="false" aria-label="Address" placeholder="http://localhost:3000" />
  <button id="go" type="button">Open</button>
  <span class="meta" id="meta"></span>
</header>
<main id="stage"><p>The page appears here when the agent opens it.</p></main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const url = document.getElementById('url');
  const meta = document.getElementById('meta');
  const stage = document.getElementById('stage');
  let img;
  function ensureImage() {
    if (img) return img;
    stage.textContent = '';
    img = document.createElement('img');
    img.alt = 'Browser page';
    img.addEventListener('click', (event) => {
      const rect = img.getBoundingClientRect();
      const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
      const drawnW = img.naturalWidth * scale;
      const drawnH = img.naturalHeight * scale;
      const offsetX = (rect.width - drawnW) / 2;
      const offsetY = (rect.height - drawnH) / 2;
      const x = (event.clientX - rect.left - offsetX) / drawnW;
      const y = (event.clientY - rect.top - offsetY) / drawnH;
      if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
        vscode.postMessage({ type: 'click', x, y });
      }
    });
    stage.appendChild(img);
    return img;
  }
  document.getElementById('go').addEventListener('click', openUrl);
  url.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') openUrl();
  });
  function openUrl() {
    const value = url.value.trim();
    if (value) vscode.postMessage({ type: 'navigate', url: value });
  }
  window.addEventListener('keydown', (event) => {
    if (event.target === url) return;
    event.preventDefault();
    vscode.postMessage({ type: 'key', key: event.key });
  });
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message) return;
    if (message.type === 'state') {
      if (document.activeElement !== url) url.value = message.url || '';
      meta.textContent = message.width && message.height ? message.width + ' × ' + message.height : '';
    } else if (message.type === 'frame' && message.jpeg) {
      ensureImage().src = 'data:image/jpeg;base64,' + message.jpeg;
    }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
