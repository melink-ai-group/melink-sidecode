import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  bindHelpers,
  clampedFraction,
  drawnFrame,
  pointFraction,
  safeCursor,
  selectionFraction,
  wheelPixels
} from './panelInput.ts';
import { urlInputError } from './url.ts';

/** What the editor tab shows above the page. */
export interface BrowserTabState {
  url: string;
  title: string;
  width: number;
  height: number;
}

/** A pressed mouse button from the panel: the DOM's 0, 1, or 2. */
export interface BrowserPointerOptions {
  button?: number;
  clickCount?: number;
}

/** Everything the tab can ask the host to do on the page. */
export interface BrowserPanelHandlers {
  navigate(url: string): void;
  resize(width: number, height: number): void;
  pointer(action: 'move' | 'down' | 'up', x: number, y: number, options?: BrowserPointerOptions): void;
  wheel(x: number, y: number, dx: number, dy: number): void;
  keyDown(key: string): void;
  keyUp(key: string): void;
  insertText(text: string): void;
  /** Read the host clipboard and insert it into the page. */
  paste(): void;
  hover(x: number, y: number): void;
  /** The pointer left the image; clear the page's hover state. */
  leave(): void;
  /** No rect means the whole viewport; a rect is a viewport fraction. */
  capture(rect?: { x: number; y: number; width: number; height: number }): void;
  blur(): void;
}

interface PanelMessage {
  type?: string;
  url?: unknown;
  width?: unknown;
  height?: unknown;
  action?: unknown;
  x?: unknown;
  y?: unknown;
  dx?: unknown;
  dy?: unknown;
  button?: unknown;
  clickCount?: unknown;
  key?: unknown;
  text?: unknown;
  rect?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
}

/**
 * Editor tab that paints the same page the agent is driving.
 *
 * Frames are JPEG screencast shots. Clicks, drags, wheel input, keys, composed
 * text, and the page's own cursor go back to that page. The toolbar can resize
 * the viewport and attach a full page or a dragged snippet to the open chat.
 */
export class BrowserPanel {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private pendingState?: BrowserTabState;
  private pendingError = '';
  private lastFrame?: string;
  private frameTimer?: ReturnType<typeof setTimeout>;
  private readonly handlers: BrowserPanelHandlers;

  constructor(handlers: BrowserPanelHandlers) {
    this.handlers = handlers;
  }

  show(state: BrowserTabState): void {
    this.pendingState = state;
    this.pendingError = '';
    if (!this.panel) {
      this.ready = false;
      this.panel = vscode.window.createWebviewPanel('melink.browser', 'Browser', vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true
      });
      this.panel.webview.html = html(this.panel.webview);
      this.panel.webview.onDidReceiveMessage((raw: unknown) => {
        this.receive(raw);
      });
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.ready = false;
        this.pendingError = '';
        this.lastFrame = undefined;
        if (this.frameTimer) {
          clearTimeout(this.frameTimer);
          this.frameTimer = undefined;
        }
        this.handlers.blur();
      });
    }
    this.flush();
  }

  /** Coalesce screencast frames to about ten a second. */
  frame(jpegBase64: string): void {
    if (!this.panel) {
      return;
    }
    this.lastFrame = jpegBase64;
    if (this.frameTimer) {
      return;
    }
    this.frameTimer = setTimeout(() => {
      this.frameTimer = undefined;
      this.flushFrame();
    }, 100);
  }

  state(state: BrowserTabState): void {
    this.pendingState = state;
    this.pendingError = '';
    if (this.panel) {
      this.panel.title = state.title || 'Browser';
    }
    this.flush();
  }

  /** Show one inline error above the page; the next successful state clears it. */
  showError(message: string): void {
    const text = typeof message === 'string' ? message.trim() : '';
    this.pendingError = text;
    if (this.ready && this.panel) {
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  /** Mirror the page's cursor on the image. */
  cursor(value: string): void {
    if (this.ready && this.panel) {
      void this.panel.webview.postMessage({ type: 'cursor', value });
    }
  }

  /** Report that a capture joined the open chat's composer. */
  attached(message: string): void {
    if (this.ready && this.panel) {
      void this.panel.webview.postMessage({ type: 'attached', message });
    }
  }

  /** Report why a capture could not be attached. */
  attachError(message: string): void {
    if (this.ready && this.panel) {
      void this.panel.webview.postMessage({ type: 'attachError', message });
    }
  }

  close(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.ready = false;
    this.pendingError = '';
    this.lastFrame = undefined;
    if (this.frameTimer) {
      clearTimeout(this.frameTimer);
      this.frameTimer = undefined;
    }
  }

  private receive(raw: unknown): void {
    if (!raw || typeof raw !== 'object') {
      return;
    }
    const message = raw as PanelMessage;
    if (message.type === 'ready') {
      this.ready = true;
      this.flush();
      return;
    }
    if (message.type === 'blur') {
      this.handlers.blur();
      return;
    }
    if (message.type === 'navigate') {
      if (typeof message.url === 'string') {
        this.handlers.navigate(message.url);
      }
      return;
    }
    if (message.type === 'resize') {
      const width = finite(message.width);
      const height = finite(message.height);
      if (width !== undefined && height !== undefined) {
        this.handlers.resize(width, height);
      }
      return;
    }
    if (message.type === 'pointer') {
      const action = message.action;
      const x = fraction(message.x);
      const y = fraction(message.y);
      if ((action !== 'move' && action !== 'down' && action !== 'up') || x === undefined || y === undefined) {
        return;
      }
      this.handlers.pointer(action, x, y, {
        ...(finite(message.button) !== undefined ? { button: finite(message.button) } : {}),
        ...(finite(message.clickCount) !== undefined ? { clickCount: finite(message.clickCount) } : {})
      });
      return;
    }
    if (message.type === 'wheel') {
      const x = fraction(message.x);
      const y = fraction(message.y);
      const dx = finite(message.dx);
      const dy = finite(message.dy);
      if (x === undefined || y === undefined || dx === undefined || dy === undefined) {
        return;
      }
      this.handlers.wheel(x, y, dx, dy);
      return;
    }
    if (message.type === 'keyDown' || message.type === 'keyUp') {
      if (typeof message.key !== 'string') {
        return;
      }
      if (message.type === 'keyDown') {
        this.handlers.keyDown(message.key);
      } else {
        this.handlers.keyUp(message.key);
      }
      return;
    }
    if (message.type === 'insertText') {
      if (typeof message.text === 'string' && message.text.length > 0) {
        this.handlers.insertText(message.text);
      }
      return;
    }
    if (message.type === 'paste') {
      this.handlers.paste();
      return;
    }
    if (message.type === 'leave') {
      this.handlers.leave();
      return;
    }
    if (message.type === 'hover') {
      const x = fraction(message.x);
      const y = fraction(message.y);
      if (x !== undefined && y !== undefined) {
        this.handlers.hover(x, y);
      }
      return;
    }
    if (message.type === 'capture') {
      const rect = message.rect;
      if (!rect) {
        this.handlers.capture();
        return;
      }
      const x = fraction(rect.x);
      const y = fraction(rect.y);
      const width = fraction(rect.width);
      const height = fraction(rect.height);
      if (x === undefined || y === undefined || width === undefined || height === undefined) {
        return;
      }
      if (!(width > 0) || !(height > 0)) {
        return;
      }
      this.handlers.capture({ x, y, width, height });
    }
  }

  private flush(): void {
    if (!this.ready || !this.panel || !this.pendingState) {
      return;
    }
    void this.panel.webview.postMessage({ type: 'state', ...this.pendingState, error: this.pendingError });
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

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function fraction(value: unknown): number | undefined {
  const number = finite(value);
  return number !== undefined && number >= 0 && number <= 1 ? number : undefined;
}

function html(webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString('hex');
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:`;
  // The production bundle minifies function names, so bind each serialized body
  // to the name the panel script calls. A bare `toString()` would otherwise
  // declare `gg` while the script asks for `drawnFrame`.
  const helpers = bindHelpers([
    ['drawnFrame', drawnFrame],
    ['pointFraction', pointFraction],
    ['clampedFraction', clampedFraction],
    ['selectionFraction', selectionFraction],
    ['wheelPixels', wheelPixels],
    ['safeCursor', safeCursor],
    ['urlInputError', urlInputError]
  ]);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Browser</title>
<style>
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; height: 100vh; display: flex; flex-direction: column; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font: 13px var(--vscode-font-family); }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .toolbar { row-gap: 6px; }
  input, button { font: inherit; color: inherit; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; }
  input { padding: 4px 8px; }
  #url { flex: 1 1 320px; min-width: 0; }
  input[type="number"] { width: 76px; }
  button { padding: 4px 10px; cursor: pointer; }
  button[aria-pressed="true"] { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  button:disabled { opacity: 0.5; cursor: default; }
  .field { display: flex; align-items: center; gap: 4px; white-space: nowrap; opacity: 0.9; }
  .grow { flex: 1 1 auto; }
  .meta { white-space: nowrap; opacity: 0.8; }
  .error, .hint, .status { margin: 0; padding: 6px 8px; font-size: 12px; border-bottom: 1px solid var(--vscode-panel-border); }
  .error { color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground)); background: var(--vscode-inputValidation-errorBackground, transparent); border-bottom-color: var(--vscode-inputValidation-errorBorder, transparent); }
  .hint, .status { color: var(--vscode-descriptionForeground, inherit); }
  .hint { position: absolute; z-index: 2; top: 8px; left: 8px; right: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); pointer-events: none; }
  main { position: relative; flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; overflow: hidden; background: var(--vscode-editor-background); }
  img { max-width: 100%; max-height: 100%; object-fit: contain; cursor: default; user-select: none; -webkit-user-drag: none; touch-action: none; }
  img:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  #selection { position: absolute; z-index: 1; border: 1px dashed var(--vscode-focusBorder); background: var(--vscode-editor-selectionBackground); pointer-events: none; }
  p { margin: 0; padding: 24px; opacity: 0.75; }
</style>
</head>
<body>
<header class="bar">
  <input id="url" type="url" spellcheck="false" aria-label="Address" placeholder="http://localhost:3000" />
  <button id="go" type="button">Open</button>
</header>
<div class="bar toolbar">
  <label class="field" for="width">Width <input id="width" type="number" min="200" max="3840" step="1" inputmode="numeric" aria-label="Viewport width" /></label>
  <label class="field" for="height">Height <input id="height" type="number" min="200" max="2160" step="1" inputmode="numeric" aria-label="Viewport height" /></label>
  <button id="apply" type="button">Apply</button>
  <span class="grow"></span>
  <button id="snippet" type="button" aria-pressed="false" title="Drag over the page to attach that area to the chat">Snippet</button>
  <button id="capture" type="button">Capture page</button>
  <span class="meta" id="meta"></span>
</div>
<p class="error" id="error" role="alert" hidden></p>
<p class="status" id="status" role="status" aria-live="polite" hidden></p>
<main id="stage">
  <p id="placeholder">The page appears here when the agent opens it.</p>
  <div id="selection" hidden></div>
  <p class="hint" id="hint" hidden>Drag over the page to attach that area to the chat. Press Escape to cancel.</p>
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  ${helpers}
  const url = document.getElementById('url');
  const widthInput = document.getElementById('width');
  const heightInput = document.getElementById('height');
  const meta = document.getElementById('meta');
  const errorLine = document.getElementById('error');
  const hint = document.getElementById('hint');
  const statusLine = document.getElementById('status');
  const stage = document.getElementById('stage');
  const placeholder = document.getElementById('placeholder');
  const selectionBox = document.getElementById('selection');
  const snippetButton = document.getElementById('snippet');
  const captureButton = document.getElementById('capture');
  const applyButton = document.getElementById('apply');
  const modifiers = { Control: true, Alt: true, Meta: true, Shift: true };
  const held = Object.create(null);
  let img;
  let snippet = false;
  let pressed = false;
  let pressedButton = 0;
  let pressedClickCount = 1;
  let lastClickAt = 0;
  let lastClickX = 0;
  let lastClickY = 0;
  let lastClickCount = 0;
  let selecting = false;
  let selectStart;
  let selectEnd;
  let hoverTimer;
  let hoverPending;
  let hoverAt = 0;
  let cursor = 'default';
  let composing = false;
  let busy = false;
  let busyTimer;
  let statusTimer;

  function post(message) { vscode.postMessage(message); }
  function isField(target) { return !!(target && target.closest && target.closest('input, button, select, textarea')); }
  function pageFrame() {
    if (!img || !img.naturalWidth || !img.naturalHeight) return undefined;
    return drawnFrame(img.getBoundingClientRect(), img.naturalWidth, img.naturalHeight);
  }
  function showError(text) {
    errorLine.textContent = text || '';
    errorLine.hidden = !text;
    if (text) showStatus('');
  }
  function showStatus(text) {
    statusLine.textContent = text || '';
    statusLine.hidden = !text;
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = undefined; }
    if (text) statusTimer = setTimeout(function () { statusLine.hidden = true; }, 5000);
  }
  function applyCursor() {
    if (!img) return;
    img.style.cursor = snippet ? 'crosshair' : safeCursor(cursor);
  }
  function setSnippet(on) {
    snippet = on;
    snippetButton.setAttribute('aria-pressed', on ? 'true' : 'false');
    hint.hidden = !on;
    if (!on) cancelSelection();
    if (on) { cancelHover(); post({ type: 'leave' }); }
    applyCursor();
  }
  function cancelSelection() {
    selecting = false;
    selectStart = undefined;
    selectEnd = undefined;
    selectionBox.hidden = true;
  }
  function drawSelection() {
    const frame = pageFrame();
    if (!frame || !selectStart || !selectEnd) { selectionBox.hidden = true; return; }
    const stageRect = stage.getBoundingClientRect();
    const left = Math.max(frame.left, Math.min(selectStart.clientX, selectEnd.clientX));
    const right = Math.min(frame.left + frame.width, Math.max(selectStart.clientX, selectEnd.clientX));
    const top = Math.max(frame.top, Math.min(selectStart.clientY, selectEnd.clientY));
    const bottom = Math.min(frame.top + frame.height, Math.max(selectStart.clientY, selectEnd.clientY));
    if (right - left < 1 || bottom - top < 1) { selectionBox.hidden = true; return; }
    selectionBox.style.left = (left - stageRect.left) + 'px';
    selectionBox.style.top = (top - stageRect.top) + 'px';
    selectionBox.style.width = (right - left) + 'px';
    selectionBox.style.height = (bottom - top) + 'px';
    selectionBox.hidden = false;
  }
  function requestHover(point) {
    hoverPending = point;
    if (hoverTimer) return;
    const wait = Math.max(0, 60 - (Date.now() - hoverAt));
    hoverTimer = setTimeout(function () {
      hoverTimer = undefined;
      const next = hoverPending;
      hoverPending = undefined;
      if (!next) return;
      hoverAt = Date.now();
      post({ type: 'hover', x: next.x, y: next.y });
    }, wait);
  }
  function cancelHover() {
    hoverPending = undefined;
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = undefined; }
  }
  function releasePointer(event) {
    if (img && img.hasPointerCapture && img.hasPointerCapture(event.pointerId)) {
      img.releasePointerCapture(event.pointerId);
    }
  }
  function clickCountFor(event) {
    const now = Date.now();
    const near = Math.abs(event.clientX - lastClickX) <= 4 && Math.abs(event.clientY - lastClickY) <= 4;
    const count = now - lastClickAt <= 400 && near ? lastClickCount + 1 : 1;
    lastClickAt = now;
    lastClickX = event.clientX;
    lastClickY = event.clientY;
    lastClickCount = count;
    return Math.max(count, event.detail || 0);
  }
  function finishPress(event) {
    if (!pressed) return;
    pressed = false;
    const frame = pageFrame();
    if (frame) {
      const point = clampedFraction(frame, event.clientX, event.clientY);
      post({ type: 'pointer', action: 'up', x: point.x, y: point.y, button: pressedButton, clickCount: pressedClickCount });
    }
    releasePointer(event);
  }
  function finishSelection(event) {
    if (!selecting) return;
    selectEnd = { clientX: event.clientX, clientY: event.clientY };
    const frame = pageFrame();
    const start = selectStart;
    const end = selectEnd;
    selecting = false;
    releasePointer(event);
    selectionBox.hidden = true;
    selectStart = undefined;
    selectEnd = undefined;
    if (!frame || !start) return;
    const rect = selectionFraction(frame, start, end);
    if (!rect) { showError('Select a larger area.'); return; }
    showError('');
    setSnippet(false);
    requestCapture(rect);
  }
  function setBusy(value) {
    busy = value;
    snippetButton.disabled = value;
    captureButton.disabled = value;
    applyButton.disabled = value;
    if (busyTimer) { clearTimeout(busyTimer); busyTimer = undefined; }
    if (value) busyTimer = setTimeout(function () {
      busyTimer = undefined;
      setBusy(false);
      showError('The capture did not finish.');
    }, 15000);
  }
  function requestCapture(rect) {
    if (busy) return;
    if (!img) { showError('The browser is not open yet.'); return; }
    setBusy(true);
    showError('');
    showStatus('Capturing…');
    post(rect ? { type: 'capture', rect: rect } : { type: 'capture' });
  }
  function applySize() {
    const width = Number(widthInput.value);
    const height = Number(heightInput.value);
    if (!Number.isInteger(width) || width < 200 || width > 3840) {
      showError('Width must be a whole number from 200 to 3840.');
      return;
    }
    if (!Number.isInteger(height) || height < 200 || height > 2160) {
      showError('Height must be a whole number from 200 to 2160.');
      return;
    }
    showError('');
    post({ type: 'resize', width: width, height: height });
  }
  function ensureImage() {
    if (img) return img;
    if (placeholder) placeholder.hidden = true;
    img = document.createElement('img');
    img.alt = 'Browser page';
    img.title = 'Browser page. Press Escape to leave the page.';
    img.tabIndex = 0;
    img.draggable = false;
    img.addEventListener('dragstart', function (event) { event.preventDefault(); });
    img.addEventListener('contextmenu', function (event) { event.preventDefault(); });
    img.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
      const frame = pageFrame();
      if (!frame) return;
      img.focus();
      if (snippet) {
        const point = pointFraction(frame, event.clientX, event.clientY);
        if (!point) return;
        event.preventDefault();
        selecting = true;
        selectStart = { clientX: event.clientX, clientY: event.clientY };
        selectEnd = selectStart;
        try { img.setPointerCapture(event.pointerId); } catch {}
        drawSelection();
        return;
      }
      const point = pointFraction(frame, event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      cancelHover();
      pressed = true;
      pressedButton = event.button;
      pressedClickCount = clickCountFor(event);
      try { img.setPointerCapture(event.pointerId); } catch {}
      post({ type: 'pointer', action: 'down', x: point.x, y: point.y, button: pressedButton, clickCount: pressedClickCount });
    });
    img.addEventListener('pointermove', function (event) {
      const frame = pageFrame();
      if (!frame) return;
      if (snippet) {
        if (!selecting) return;
        selectEnd = { clientX: event.clientX, clientY: event.clientY };
        drawSelection();
        return;
      }
      if (pressed) {
        const point = clampedFraction(frame, event.clientX, event.clientY);
        post({ type: 'pointer', action: 'move', x: point.x, y: point.y });
        return;
      }
      const point = pointFraction(frame, event.clientX, event.clientY);
      if (!point) { cancelHover(); cursor = 'default'; applyCursor(); return; }
      requestHover(point);
    });
    img.addEventListener('pointerup', function (event) {
      if (snippet) { finishSelection(event); return; }
      finishPress(event);
    });
    img.addEventListener('pointercancel', function (event) {
      if (snippet) { cancelSelection(); return; }
      finishPress(event);
    });
    img.addEventListener('pointerleave', function () {
      cancelHover();
      cursor = 'default';
      applyCursor();
      if (!pressed) post({ type: 'leave' });
    });
    img.addEventListener('wheel', function (event) {
      if (snippet) return;
      const frame = pageFrame();
      if (!frame) return;
      const point = pointFraction(frame, event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      const pixels = wheelPixels(event, img.naturalHeight || frame.height);
      if (pixels.dx === 0 && pixels.dy === 0) return;
      post({ type: 'wheel', x: point.x, y: point.y, dx: pixels.dx, dy: pixels.dy });
    }, { passive: false });
    stage.appendChild(img);
    return img;
  }
  document.getElementById('go').addEventListener('click', openUrl);
  url.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') openUrl();
  });
  function openUrl() {
    const value = url.value.trim();
    const problem = urlInputError(value);
    if (problem) {
      showError(problem);
      return;
    }
    showError('');
    post({ type: 'navigate', url: value });
  }
  widthInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); applySize(); }
  });
  heightInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); applySize(); }
  });
  applyButton.addEventListener('click', applySize);
  snippetButton.addEventListener('click', function () {
    setSnippet(!snippet);
    if (snippet) { showError(''); showStatus(''); }
  });
  captureButton.addEventListener('click', function () { requestCapture(undefined); });
  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && (snippet || selecting)) {
      event.preventDefault();
      setSnippet(false);
      return;
    }
    if (event.key === 'Escape' && document.activeElement === img) {
      event.preventDefault();
      img.blur();
      url.focus();
      return;
    }
    if (isField(event.target)) return;
    if (snippet) return;
    if (composing || event.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'v') {
      event.preventDefault();
      post({ type: 'paste' });
      return;
    }
    if (!modifiers[event.key]) event.preventDefault();
    if (modifiers[event.key]) {
      if (!event.repeat) {
        held[event.key] = true;
        post({ type: 'keyDown', key: event.key });
      }
      return;
    }
    held[event.key] = true;
    post({ type: 'keyDown', key: event.key });
  });
  window.addEventListener('keyup', function (event) {
    if (!held[event.key]) return;
    delete held[event.key];
    post({ type: 'keyUp', key: event.key });
  });
  window.addEventListener('compositionstart', function () { composing = true; });
  window.addEventListener('compositionend', function (event) {
    composing = false;
    if (event.data) post({ type: 'insertText', text: event.data });
  });
  window.addEventListener('paste', function (event) {
    if (isField(event.target)) return;
    if (snippet) return;
    const data = event.clipboardData;
    const text = data ? data.getData('text') : '';
    if (!text) return;
    event.preventDefault();
    post({ type: 'insertText', text: text });
  });
  window.addEventListener('blur', function () {
    for (const key in held) delete held[key];
    post({ type: 'blur' });
  });
  stage.addEventListener('dragstart', function (event) { event.preventDefault(); });
  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message) return;
    if (message.type === 'state') {
      if (document.activeElement !== url) url.value = message.url || '';
      if (document.activeElement !== widthInput && message.width) widthInput.value = String(message.width);
      if (document.activeElement !== heightInput && message.height) heightInput.value = String(message.height);
      meta.textContent = message.width && message.height ? message.width + ' × ' + message.height : '';
      showError(message.error || '');
    } else if (message.type === 'error') {
      showError(message.message || '');
    } else if (message.type === 'cursor') {
      cursor = safeCursor(message.value);
      applyCursor();
    } else if (message.type === 'attached') {
      setBusy(false);
      showStatus(message.message || 'Attached to the chat.');
    } else if (message.type === 'attachError') {
      setBusy(false);
      showError(message.message || 'The capture could not be attached.');
    } else if (message.type === 'frame' && message.jpeg) {
      ensureImage().src = 'data:image/jpeg;base64,' + message.jpeg;
    }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
