import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

interface VsCodeApiLike {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

let selectionText = '';
let persistedState: unknown;

export const postMessage = vi.fn<(message: unknown) => void>();
export const getState = vi.fn<() => unknown>(() => persistedState);
export const setState = vi.fn<(state: unknown) => void>((state) => {
  persistedState = state;
});

const vscodeApi: VsCodeApiLike = { postMessage, getState, setState };

const globalWithApi = globalThis as typeof globalThis & {
  acquireVsCodeApi?: () => VsCodeApiLike;
};
globalWithApi.acquireVsCodeApi = () => vscodeApi;

function currentSelection(): Selection {
  return { toString: () => selectionText } as unknown as Selection;
}

window.getSelection = currentSelection as unknown as typeof window.getSelection;

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;

const noop = (): void => {};

window.scrollTo = noop as typeof window.scrollTo;
(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = noop;
(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = noop;

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: noop,
    removeListener: noop,
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
}

/** Change what `window.getSelection()` reports to the component. */
export function setSelectionText(text: string): void {
  selectionText = text;
}

/** Every message the webview posted to the host, oldest first. */
export function hostMessages(): unknown[] {
  return postMessage.mock.calls.map((call) => call[0]);
}

/** Deliver one host-to-webview message through the real `message` listener. */
export function sendHostMessage(message: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

/** Drop recorded host messages between assertions or tests. */
export function clearHostMessages(): void {
  postMessage.mockClear();
}

beforeEach(() => {
  selectionText = '';
  persistedState = undefined;
  postMessage.mockClear();
  getState.mockClear();
  setState.mockClear();
});

afterEach(() => {
  cleanup();
  selectionText = '';
  postMessage.mockClear();
});
