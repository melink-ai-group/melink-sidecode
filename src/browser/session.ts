/**
 * One headless page, shown to the user through a screencast rather than a
 * second window. Edge is tried first, then Chrome. Nothing is downloaded.
 */

import { ConsoleBuffer, attachPageDiagnostics } from './consoleBuffer.ts';
import type { AssertInput, AssertResult } from './tools.ts';

const CHANNELS = ['msedge', 'chrome'] as const;

/** Bounded navigation: at most three attempts inside one overall deadline. */
export const NAVIGATION_ATTEMPTS = 3;
export const NAVIGATION_DEADLINE_MS = 15_000;
export const NAVIGATION_GOTO_TIMEOUT_MS = 8_000;
export const NAVIGATION_POLL_MS = 150;

/** Assertions poll briefly so a just-rendered node can settle. */
export const ASSERT_TIMEOUT_MS = 2_000;
export const ASSERT_POLL_MS = 100;

/** Title/location reads outside navigation still must not hang forever. */
const PAGE_METADATA_TIMEOUT_MS = 2_000;

export type NavigationResult =
  | { ok: true; url: string; title: string; status?: number }
  | { ok: false; kind: 'not-reachable' | 'timeout'; url: string; reason: string };

export interface ReadinessSnapshot {
  state?: string;
  hasBody?: boolean;
  hasContent?: boolean;
}

/** The body surface `readinessProbe` inspects; tests can fake it. */
export interface BodyLike {
  textContent?: string | null;
  querySelector(selectors: string): unknown;
}

const MEDIA_SELECTOR = 'img, canvas, svg, video';

/**
 * A shell like `<div id="root"></div>` is not ready. Content means visible
 * text or a media element, not merely a non-empty element tree.
 */
export function hasRenderableContent(body: BodyLike | null | undefined): boolean {
  if (!body) {
    return false;
  }
  const text = (body.textContent ?? '').trim();
  return text.length > 0 || body.querySelector(MEDIA_SELECTOR) !== null;
}

/**
 * Runs inside the page. This function is serialized by Playwright, so it must
 * be self-contained: no module-scope identifiers, only `document` and literals.
 * `interactive` alone is not enough: the body must also exist and carry
 * renderable content, so a skeleton document does not count.
 */
export function readinessProbe(): ReadinessSnapshot {
  const body = typeof document === 'undefined' ? null : document.body;
  const text = body ? String(body.innerText ?? '').trim() : '';
  const hasMedia =
    body !== null && typeof body.querySelector === 'function'
      ? body.querySelector('img, canvas, svg, video') !== null
      : false;
  return {
    state: typeof document === 'undefined' ? '' : document.readyState,
    hasBody: body !== null,
    hasContent: text.length > 0 || hasMedia
  };
}

export function isReady(snapshot: ReadinessSnapshot | undefined): boolean {
  const state = snapshot?.state;
  return (state === 'interactive' || state === 'complete') && snapshot?.hasBody === true && snapshot?.hasContent === true;
}

/** A page call that ran past its deadline, distinct from a driver error. */
export class DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadlineError';
  }
}

/**
 * Bound a page call that has no timeout of its own. The timer is always
 * cleared, so a blocked renderer cannot hold a tool call open.
 */
export async function withDeadline<T>(promise: Promise<T>, remainingMs: number, reason: string): Promise<T> {
  if (!(remainingMs > 0)) {
    void promise.catch(() => undefined);
    throw new DeadlineError(reason);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DeadlineError(reason)), remainingMs);
      })
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** The minimal page surface the navigation loop needs. Tests supply a fake. */
export interface NavigationPage {
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  evaluate<T>(probe: () => T): Promise<T>;
  url(): string;
  title(): Promise<string>;
}

export interface ReadinessOptions {
  attempts?: number;
  deadlineMs?: number;
  gotoTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function responseStatus(response: unknown): number | undefined {
  if (!response || typeof response !== 'object') {
    return undefined;
  }
  const candidate = response as { status?: unknown };
  if (typeof candidate.status === 'function') {
    try {
      const value = (candidate.status as () => unknown)();
      return typeof value === 'number' ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return typeof candidate.status === 'number' ? candidate.status : undefined;
}

/** Map a driver error to the small vocabulary the tool text uses. */
export function classifyNavigationError(error: unknown): { kind: 'not-reachable' | 'timeout'; reason: string } {
  if (error instanceof DeadlineError) {
    return { kind: 'timeout', reason: error.message };
  }
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const upper = raw.toUpperCase();
  if (upper.includes('ECONNREFUSED') || upper.includes('ERR_CONNECTION_REFUSED') || upper.includes('CONNECTION REFUSED')) {
    return { kind: 'not-reachable', reason: 'connection refused' };
  }
  if (
    upper.includes('ENOTFOUND') ||
    upper.includes('EAI_AGAIN') ||
    upper.includes('ERR_NAME_NOT_RESOLVED') ||
    upper.includes('NAME_NOT_RESOLVED') ||
    upper.includes('ERR_NAME_RESOLUTION_FAILED')
  ) {
    return { kind: 'not-reachable', reason: 'DNS lookup failed' };
  }
  if (upper.includes('TIMEOUT') || upper.includes('TIMED OUT') || upper.includes('ERR_TIMED_OUT')) {
    return { kind: 'timeout', reason: 'the page did not respond before the deadline' };
  }
  return { kind: 'not-reachable', reason: raw || 'the page could not be opened' };
}

/** The minimal page surface assertions need. Tests supply a fake. */
export interface AssertionPage {
  url(): string;
  locator(selector: string): { count(): Promise<number> };
  getByText(text: string, options: { exact: boolean }): { count(): Promise<number> };
}

export interface AssertionOptions {
  deadline?: number;
  now?: () => number;
}

export async function checkAssertion(
  page: AssertionPage,
  input: AssertInput,
  lastStatus: number | undefined,
  options: AssertionOptions = {}
): Promise<{ ok: true; matched: string[] } | { ok: false; message: string }> {
  const matched: string[] = [];
  const now = options.now ?? Date.now;
  const deadline = options.deadline ?? now() + ASSERT_TIMEOUT_MS;
  const remaining = (): number => Math.max(1, deadline - now());
  const count = async (promise: Promise<number>, label: string): Promise<number | { timedOut: string }> => {
    try {
      return await withDeadline(promise, remaining(), `Assertion timed out: ${label} at ${page.url()}.`);
    } catch (error) {
      if (error instanceof DeadlineError) {
        return { timedOut: error.message };
      }
      return 0;
    }
  };

  if (input.selector !== undefined) {
    const found = await count(page.locator(input.selector).count(), `selector "${input.selector}"`);
    if (typeof found !== 'number') {
      return { ok: false, message: found.timedOut };
    }
    if (found < 1) {
      return { ok: false, message: `Selector not found: ${input.selector} at ${page.url()}.` };
    }
    matched.push(`selector "${input.selector}"`);
  }
  if (input.text !== undefined) {
    const found = await count(page.getByText(input.text, { exact: false }).count(), `text "${input.text}"`);
    if (typeof found !== 'number') {
      return { ok: false, message: found.timedOut };
    }
    if (found < 1) {
      return { ok: false, message: `Text not found: "${input.text}" at ${page.url()}.` };
    }
    matched.push(`text "${input.text}"`);
  }
  if (input.url !== undefined && page.url() !== input.url) {
    return { ok: false, message: `URL mismatch: expected ${input.url}, got ${page.url() || 'about:blank'}.` };
  }
  if (input.url !== undefined) {
    matched.push(`URL "${input.url}"`);
  }
  if (input.status !== undefined && lastStatus !== input.status) {
    return {
      ok: false,
      message: `Status mismatch: expected ${input.status}, got ${lastStatus ?? 'unknown'}.`
    };
  }
  if (input.status !== undefined) {
    matched.push(`status ${input.status}`);
  }
  return { ok: true, matched };
}

/**
 * Navigate, then wait until the document is genuinely usable. Pure over the
 * `NavigationPage` seam so every outcome can be simulated without Playwright.
 */
export async function navigateWithReadiness(
  page: NavigationPage,
  url: string,
  options: ReadinessOptions = {}
): Promise<NavigationResult> {
  const attempts = options.attempts ?? NAVIGATION_ATTEMPTS;
  const deadlineMs = options.deadlineMs ?? NAVIGATION_DEADLINE_MS;
  const gotoTimeoutMs = options.gotoTimeoutMs ?? NAVIGATION_GOTO_TIMEOUT_MS;
  const pollMs = options.pollMs ?? NAVIGATION_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const deadline = now() + deadlineMs;
  const timeoutReason = `the page did not become ready within ${Math.max(1, Math.round(deadlineMs / 1000))}s`;
  let lastKind: 'not-reachable' | 'timeout' = 'timeout';
  let lastReason = timeoutReason;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      return { ok: false, kind: 'timeout', url, reason: timeoutReason };
    }
    let status: number | undefined;
    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: Math.max(1, Math.min(gotoTimeoutMs, remaining))
      });
      status = responseStatus(response);
      while (true) {
        let snapshot: ReadinessSnapshot | undefined;
        try {
          snapshot = await withDeadline(
            page.evaluate(readinessProbe),
            deadline - now(),
            timeoutReason
          );
        } catch (error) {
          if (error instanceof DeadlineError) {
            return { ok: false, kind: 'timeout', url, reason: timeoutReason };
          }
          snapshot = undefined;
        }
        if (isReady(snapshot)) {
          const title = await withDeadline(page.title(), deadline - now(), timeoutReason);
          return { ok: true, url: page.url(), title, ...(status === undefined ? {} : { status }) };
        }
        const left = deadline - now();
        if (left <= 0) {
          return { ok: false, kind: 'timeout', url, reason: timeoutReason };
        }
        await sleep(Math.min(pollMs, left));
      }
    } catch (error) {
      const classified = classifyNavigationError(error);
      lastKind = classified.kind;
      lastReason = classified.reason;
      if (now() >= deadline) {
        return { ok: false, kind: 'timeout', url, reason: timeoutReason };
      }
    }
  }

  if (now() >= deadline) {
    return { ok: false, kind: 'timeout', url, reason: timeoutReason };
  }
  return { ok: false, kind: lastKind, url, reason: lastReason };
}

interface ScreencastFrame {
  data: string;
  sessionId: number;
}

interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: 'Page.screencastFrame', handler: (frame: ScreencastFrame) => void): void;
  detach(): Promise<void>;
}

/** Where the page ended up after a history move or reload. */
export interface PageLocation {
  url: string;
  title: string;
}

export interface PlaywrightPage {
  on(event: 'console' | 'pageerror' | 'requestfailed' | 'response', handler: (value: unknown) => void): void;
  off?(event: 'console' | 'pageerror' | 'requestfailed' | 'response', handler: (value: unknown) => void): void;
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  goBack(options?: { waitUntil?: 'domcontentloaded'; timeout?: number }): Promise<unknown>;
  goForward(options?: { waitUntil?: 'domcontentloaded'; timeout?: number }): Promise<unknown>;
  reload(options?: { waitUntil?: 'domcontentloaded'; timeout?: number }): Promise<unknown>;
  evaluate<T>(probe: () => T): Promise<T>;
  url(): string;
  title(): Promise<string>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  viewportSize(): { width: number; height: number } | null;
  screenshot(options: { type: 'png' }): Promise<Buffer>;
  locator(selector: string): {
    ariaSnapshot(): Promise<string>;
    click(options: { timeout: number }): Promise<void>;
    count(): Promise<number>;
  };
  getByText(text: string, options: { exact: boolean }): {
    first(): { click(options: { timeout: number }): Promise<void> };
    count(): Promise<number>;
  };
  mouse: { click(x: number, y: number): Promise<void>; wheel(deltaX: number, deltaY: number): Promise<void> };
  keyboard: { type(text: string): Promise<void>; press(key: string): Promise<void>; insertText?(text: string): Promise<void> };
  context(): { newCDPSession(page: PlaywrightPage): Promise<CdpSession> };
}

export interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

/** The exact text for an assertion attempted after a failed navigation. */
export function navigationFailureMessage(lastNavigation: NavigationResult | undefined): string | undefined {
  if (!lastNavigation || lastNavigation.ok) {
    return undefined;
  }
  return `Navigation failed: ${lastNavigation.reason} at ${lastNavigation.url}.`;
}

export interface PlaywrightModule {
  chromium: {
    launch(options: { channel: string; headless: boolean }): Promise<PlaywrightBrowser>;
  };
}

export class BrowserPage {
  private browser?: PlaywrightBrowser;
  private page?: PlaywrightPage;
  private cdp?: CdpSession;
  private width = 1280;
  private height = 800;
  private readonly diagnostics = new ConsoleBuffer();
  private readonly playwright?: PlaywrightModule;
  private detachDiagnostics?: () => void;
  /** Kept so a navigation after `close` can open a fresh browser. */
  private onFrame?: (jpegBase64: string) => void;

  /** `playwright` is a test seam; production leaves it undefined and loads the module on open. */
  constructor(playwright?: PlaywrightModule) {
    this.playwright = playwright;
  }
  private lastStatus?: number;
  private lastNavigation?: NavigationResult;

  /** Launch Edge, then Chrome. Throws a plain message when neither starts. */
  async open(onFrame: (jpegBase64: string) => void): Promise<void> {
    this.onFrame = onFrame;
    if (this.page) {
      return;
    }
    const playwright = this.playwright ?? ((await import('playwright-core')) as PlaywrightModule);
    let last: unknown;
    for (const channel of CHANNELS) {
      try {
        this.browser = await playwright.chromium.launch({ channel, headless: true });
        break;
      } catch (error) {
        last = error;
        this.browser = undefined;
      }
    }
    if (!this.browser) {
      const detail = last instanceof Error ? last.message : '';
      throw new Error(
        detail
          ? `sideCode could not start Edge or Chrome. ${detail}`
          : 'sideCode could not start Edge or Chrome, so the browser tab is unavailable.'
      );
    }
    this.page = await this.browser.newPage();
    await this.page.setViewportSize({ width: this.width, height: this.height });
    this.detachDiagnostics = attachPageDiagnostics(this.page, this.diagnostics);
    await this.startScreencast(onFrame);
  }

  async navigate(url: string): Promise<NavigationResult> {
    const page = await this.ensureOpen();
    this.diagnostics.clear();
    this.lastStatus = undefined;
    const result = await navigateWithReadiness(page, url);
    this.lastNavigation = result;
    if (result.ok) {
      this.lastStatus = result.status;
    }
    return result;
  }

  /** Scroll the page by a wheel delta; positive dy scrolls down. */
  async scroll(dx: number, dy: number): Promise<void> {
    const page = this.requirePage();
    await page.mouse.wheel(dx, dy);
  }

  /** Go back one entry in the page history, failing when there is none. */
  async back(): Promise<PageLocation> {
    return this.travel('back');
  }

  /** Go forward one entry in the page history, failing when there is none. */
  async forward(): Promise<PageLocation> {
    return this.travel('forward');
  }

  /** Reload the current page and report where it landed. */
  async reload(): Promise<PageLocation> {
    const page = this.requirePage();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_GOTO_TIMEOUT_MS });
    this.invalidateNavigation();
    return this.location();
  }

  private async travel(direction: 'back' | 'forward'): Promise<PageLocation> {
    const page = this.requirePage();
    const options = { waitUntil: 'domcontentloaded' as const, timeout: NAVIGATION_GOTO_TIMEOUT_MS };
    const response = direction === 'back' ? await page.goBack(options) : await page.goForward(options);
    if (response === null || response === undefined) {
      throw new Error(
        direction === 'back' ? 'There is no previous page in history.' : 'There is no next page in history.'
      );
    }
    this.invalidateNavigation();
    return this.location();
  }

  /** Buffered console, page-error and network diagnostics since the last navigation. */
  consoleText(): string {
    return this.diagnostics.format();
  }

  /** HTTP status from the last successful `goto`, for assertions. */
  status(): number | undefined {
    return this.lastStatus;
  }

  async resize(width: number, height: number): Promise<{ width: number; height: number }> {
    const page = this.requirePage();
    this.width = width;
    this.height = height;
    await page.setViewportSize({ width, height });
    return { width, height };
  }

  /** Start the screencast again so the picture matches a new viewport. */
  async restartScreencast(onFrame: (jpegBase64: string) => void): Promise<void> {
    if (this.cdp) {
      await this.cdp.send('Page.stopScreencast').catch(() => undefined);
      await this.cdp.detach().catch(() => undefined);
      this.cdp = undefined;
    }
    await this.startScreencast(onFrame);
  }

  async snapshot(): Promise<{ text: string; pngBase64: string; url: string; title: string }> {
    const page = this.requirePage();
    const title = await withDeadline(
      page.title(),
      PAGE_METADATA_TIMEOUT_MS,
      'The page title did not respond.'
    ).catch(() => '');
    let text = '';
    try {
      text = await page.locator('body').ariaSnapshot();
    } catch {
      text = title;
    }
    const png = await page.screenshot({ type: 'png' });
    return {
      text,
      pngBase64: png.toString('base64'),
      url: page.url(),
      title
    };
  }

  /** Check the current page within a short bound. Never navigates. */
  async assert(input: AssertInput): Promise<AssertResult> {
    const page = this.page;
    if (!page) {
      throw new Error('The browser is not open; navigate first.');
    }
    const failedNavigation = navigationFailureMessage(this.lastNavigation);
    if (failedNavigation) {
      return { ok: false, message: failedNavigation };
    }
    const deadline = Date.now() + ASSERT_TIMEOUT_MS;
    let message = '';
    while (true) {
      const attempt = await checkAssertion(page, input, this.lastStatus, { deadline });
      if (attempt.ok) {
        return { ok: true, message: `Assertion passed: ${attempt.matched.join(', ')} at ${page.url()}.` };
      }
      message = attempt.message;
      if (Date.now() >= deadline) {
        return { ok: false, message };
      }
      await delay(ASSERT_POLL_MS);
    }
  }

  async click(input: { selector?: string; text?: string; x?: number; y?: number }): Promise<string> {
    const page = this.requirePage();
    this.invalidateNavigation();
    if (input.selector) {
      await page.locator(input.selector).click({ timeout: 5_000 });
      return `Clicked ${input.selector}.`;
    }
    if (input.text) {
      await page.getByText(input.text, { exact: false }).first().click({ timeout: 5_000 });
      return `Clicked “${input.text}”.`;
    }
    if (input.x !== undefined && input.y !== undefined) {
      await page.mouse.click(input.x, input.y);
      return `Clicked ${Math.round(input.x)}, ${Math.round(input.y)}.`;
    }
    throw new Error('Provide a selector, visible text, or both x and y.');
  }

  /** `x` and `y` are fractions of the viewport, from the editor tab. */
  async clickFraction(x: number, y: number): Promise<void> {
    const page = this.requirePage();
    this.invalidateNavigation();
    const size = page.viewportSize() ?? { width: this.width, height: this.height };
    const px = Math.min(size.width - 1, Math.max(0, x * size.width));
    const py = Math.min(size.height - 1, Math.max(0, y * size.height));
    await page.mouse.click(px, py);
  }

  async type(text: string, selector?: string): Promise<void> {
    const page = this.requirePage();
    this.invalidateNavigation();
    if (selector) {
      await page.locator(selector).click({ timeout: 5_000 });
    }
    await page.keyboard.type(text);
  }

  async press(key: string): Promise<void> {
    const page = this.requirePage();
    this.invalidateNavigation();
    if (key.length === 1) {
      await page.keyboard.type(key);
      return;
    }
    await page.keyboard.press(key);
  }

  viewport(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  async location(): Promise<{ url: string; title: string }> {
    const page = this.requirePage();
    const title = await withDeadline(
      page.title(),
      PAGE_METADATA_TIMEOUT_MS,
      'The page title did not respond.'
    ).catch(() => '');
    return { url: page.url(), title };
  }

  async close(): Promise<void> {
    const cdp = this.cdp;
    this.cdp = undefined;
    if (cdp) {
      await cdp.detach().catch(() => undefined);
    }
    this.detachDiagnostics?.();
    this.detachDiagnostics = undefined;
    this.diagnostics.clear();
    this.lastStatus = undefined;
    this.lastNavigation = undefined;
    const browser = this.browser;
    this.page = undefined;
    this.browser = undefined;
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }

  private async ensureOpen(): Promise<PlaywrightPage> {
    if (!this.page) {
      if (!this.onFrame) {
        throw new Error('The browser is not open; navigate first.');
      }
      await this.open(this.onFrame);
    }
    return this.requirePage();
  }

  private requirePage(): PlaywrightPage {
    if (!this.page) {
      throw new Error('The browser is not open.');
    }
    return this.page;
  }

  /** A click or keystroke can navigate or replace content: status is stale. */
  private invalidateNavigation(): void {
    this.lastStatus = undefined;
    this.lastNavigation = undefined;
  }

  private async startScreencast(onFrame: (jpegBase64: string) => void): Promise<void> {
    const page = this.requirePage();
    const cdp = await page.context().newCDPSession(page);
    this.cdp = cdp;
    cdp.on('Page.screencastFrame', (frame) => {
      onFrame(frame.data);
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: this.width,
      maxHeight: this.height,
      everyNthFrame: 1
    });
  }
}
