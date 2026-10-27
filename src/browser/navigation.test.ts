import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BrowserPage,
  type PlaywrightBrowser,
  type PlaywrightModule,
  type PlaywrightPage
} from './session.ts';
import { runBrowserTool, type BrowserActions, type OriginApproval, type ToolResult } from './tools.ts';

class FakeCdp {
  async send(_method: string): Promise<unknown> {
    return undefined;
  }

  on(_event: 'Page.screencastFrame', _handler: (frame: { data: string; sessionId: number }) => void): void {
    return undefined;
  }

  async detach(): Promise<void> {
    return undefined;
  }
}

class NavPage implements PlaywrightPage {
  currentUrl = 'about:blank';
  historyBack: unknown = { status: 200 };
  historyForward: unknown = { status: 200 };
  readonly gotoCalls: string[] = [];
  readonly wheelCalls: [number, number][] = [];
  readonly moves: string[] = [];
  private size = { width: 1280, height: 800 };

  on(_event: string, _handler: (value: unknown) => void): void {}
  off(_event: string, _handler: (value: unknown) => void): void {}

  async goto(url: string): Promise<unknown> {
    this.gotoCalls.push(url);
    this.currentUrl = url;
    return { status: () => 200 };
  }

  async goBack(): Promise<unknown> {
    this.moves.push('back');
    if (this.historyBack !== null) this.currentUrl = 'http://localhost:3000/one';
    return this.historyBack;
  }

  async goForward(): Promise<unknown> {
    this.moves.push('forward');
    if (this.historyForward !== null) this.currentUrl = 'http://localhost:3000/two';
    return this.historyForward;
  }

  async reload(): Promise<unknown> {
    this.moves.push('reload');
    return { status: () => 200 };
  }

  async evaluate<T, A = undefined>(_probe: (arg: A) => T, _arg?: A): Promise<T> {
    return { state: 'complete', hasBody: true, hasContent: true } as T;
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return 'Page';
  }

  async setViewportSize(size: { width: number; height: number }): Promise<void> {
    this.size = size;
  }

  viewportSize(): { width: number; height: number } {
    return this.size;
  }

  async screenshot(_options?: {
    type: 'png';
    clip?: { x: number; y: number; width: number; height: number };
  }): Promise<Buffer> {
    return Buffer.from('png');
  }

  locator(_selector: string): {
    ariaSnapshot(): Promise<string>;
    click(options: { timeout: number }): Promise<void>;
    count(): Promise<number>;
  } {
    return { ariaSnapshot: async () => 'tree', click: async () => undefined, count: async () => 1 };
  }

  getByText(_text: string, _options: { exact: boolean }): {
    first(): { click(options: { timeout: number }): Promise<void> };
    count(): Promise<number>;
  } {
    return { first: () => ({ click: async () => undefined }), count: async () => 1 };
  }

  readonly mouse = {
    click: async (_x: number, _y: number) => undefined,
    move: async (_x: number, _y: number) => undefined,
    down: async (_options?: { button?: 'left' | 'middle' | 'right'; clickCount?: number }) => undefined,
    up: async (_options?: { button?: 'left' | 'middle' | 'right'; clickCount?: number }) => undefined,
    wheel: async (dx: number, dy: number) => {
      this.wheelCalls.push([dx, dy]);
    }
  };

  readonly keyboard = {
    type: async (_text: string) => undefined,
    press: async (_key: string) => undefined,
    down: async (_key: string) => undefined,
    up: async (_key: string) => undefined,
    insertText: async (_text: string) => undefined
  };

  context(): { newCDPSession(page: PlaywrightPage): Promise<FakeCdp> } {
    return { newCDPSession: async () => new FakeCdp() };
  }
}

class NavBrowser implements PlaywrightBrowser {
  readonly pages: NavPage[] = [];
  closed = false;

  async newPage(): Promise<PlaywrightPage> {
    const page = new NavPage();
    this.pages.push(page);
    return page;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function fakePlaywright(): { module: PlaywrightModule; browsers: NavBrowser[] } {
  const browsers: NavBrowser[] = [];
  return {
    browsers,
    module: {
      chromium: {
        async launch() {
          const browser = new NavBrowser();
          browsers.push(browser);
          return browser;
        }
      }
    }
  };
}

function text(result: ToolResult): string {
  return result.content.map((part) => part.text ?? '').join('\n');
}

function actions(overrides: Partial<BrowserActions> = {}): BrowserActions {
  return {
    async navigate(url) {
      return { ok: true, url, title: 'Page', status: 200 };
    },
    async resize(width, height) {
      return { width, height };
    },
    async snapshot() {
      return { text: 'tree', pngBase64: 'abc' };
    },
    async click() {
      return 'clicked';
    },
    async type() {
      return undefined;
    },
    async press() {
      return undefined;
    },
    async console() {
      return 'no console output';
    },
    async assert() {
      return { ok: true, message: 'Assertion passed.' };
    },
    ...overrides
  };
}

async function call(actionsUnderTest: BrowserActions, name: string, raw: unknown = {}): Promise<ToolResult> {
  const allow = async (_origin: string): Promise<OriginApproval> => {
    throw new Error('read-only tools must not ask for origin approval');
  };
  return runBrowserTool(actionsUnderTest, name, raw, allow, new Set());
}

test('BrowserPage scrolls, moves through history, reloads, and closes the browser', async () => {
  const { module, browsers } = fakePlaywright();
  const browserPage = new BrowserPage(module);
  await browserPage.open(() => undefined);
  const page = browsers[0]?.pages[0];
  assert.ok(page);

  await browserPage.scroll(0, 400);
  await browserPage.scroll(-120, 0);
  assert.deepEqual(page.wheelCalls, [
    [0, 400],
    [-120, 0]
  ]);

  page.currentUrl = 'http://localhost:3000/one';
  assert.deepEqual(await browserPage.back(), { url: 'http://localhost:3000/one', title: 'Page' });
  assert.deepEqual(await browserPage.forward(), { url: 'http://localhost:3000/two', title: 'Page' });
  assert.deepEqual(await browserPage.reload(), { url: 'http://localhost:3000/two', title: 'Page' });
  assert.deepEqual(page.moves, ['back', 'forward', 'reload']);

  await browserPage.close();
  assert.equal(browsers[0]?.closed, true);
});

test('BrowserPage reports a missing history entry instead of succeeding', async () => {
  const { module, browsers } = fakePlaywright();
  const browserPage = new BrowserPage(module);
  await browserPage.open(() => undefined);
  const page = browsers[0]?.pages[0];
  assert.ok(page);
  page.historyBack = null;
  page.historyForward = null;

  await assert.rejects(() => browserPage.back(), /no previous page in history/);
  await assert.rejects(() => browserPage.forward(), /no next page in history/);
  await browserPage.close();
});

test('BrowserPage refuses page actions before a page exists', async () => {
  const browserPage = new BrowserPage();
  await assert.rejects(() => browserPage.scroll(0, 10), /not open/);
  await assert.rejects(() => browserPage.back(), /not open/);
  await assert.rejects(() => browserPage.forward(), /not open/);
  await assert.rejects(() => browserPage.reload(), /not open/);
});

test('a navigation after close opens a fresh browser page', async () => {
  const { module, browsers } = fakePlaywright();
  const browserPage = new BrowserPage(module);
  await browserPage.open(() => undefined);
  await browserPage.close();

  const result = await browserPage.navigate('http://localhost:3000/again');
  assert.equal(result.ok, true);
  assert.equal(browsers.length, 2);
  assert.equal(browsers[0]?.closed, true);
  assert.deepEqual(browsers[1]?.pages[0]?.gotoCalls, ['http://localhost:3000/again']);
  await browserPage.close();
});

test('browser_scroll sends wheel deltas and reports the amount', async () => {
  const calls: [number, number][] = [];
  const result = await call(
    actions({
      async scroll(dx, dy) {
        calls.push([dx, dy]);
      }
    }),
    'browser_scroll',
    { dx: 0, dy: 480 }
  );
  assert.deepEqual(calls, [[0, 480]]);
  assert.equal(result.isError, undefined);
  assert.equal(text(result), 'Scrolled by 0, 480.');
});

test('browser_scroll needs at least one finite, non-zero delta', async () => {
  const noDelta = await call(
    actions({ async scroll() {} }),
    'browser_scroll',
    {}
  );
  assert.equal(noDelta.isError, true);
  assert.match(text(noDelta), /dx, dy, or both/);

  const zero = await call(
    actions({ async scroll() {} }),
    'browser_scroll',
    { dx: 0, dy: 0 }
  );
  assert.equal(zero.isError, true);
  assert.match(text(zero), /non-zero/);

  const bad = await call(
    actions({ async scroll() {} }),
    'browser_scroll',
    { dx: 'left' }
  );
  assert.equal(bad.isError, true);
});

test('back, forward, reload, and close call their actions and report success', async () => {
  const calls: string[] = [];
  const tools = actions({
    async back() {
      calls.push('back');
      return { url: 'http://localhost:3000/one', title: 'One' };
    },
    async forward() {
      calls.push('forward');
      return { url: 'http://localhost:3000/two', title: 'Two' };
    },
    async reload() {
      calls.push('reload');
      return { url: 'http://localhost:3000/two', title: 'Two' };
    },
    async close() {
      calls.push('close');
    }
  });

  const back = await call(tools, 'browser_back');
  assert.equal(text(back), 'Went back to http://localhost:3000/one (One).');
  const forward = await call(tools, 'browser_forward');
  assert.equal(text(forward), 'Went forward to http://localhost:3000/two (Two).');
  const reload = await call(tools, 'browser_reload');
  assert.equal(text(reload), 'Reloaded http://localhost:3000/two.');
  const close = await call(tools, 'browser_close');
  assert.match(text(close), /Closed the browser page/);
  assert.deepEqual(calls, ['back', 'forward', 'reload', 'close']);
  assert.equal([back, forward, reload, close].every((result) => result.isError === undefined), true);
});

test('history and close errors surface as tool errors', async () => {
  const missing = await call(
    actions({
      async back() {
        throw new Error('There is no previous page in history.');
      }
    }),
    'browser_back'
  );
  assert.equal(missing.isError, true);
  assert.match(text(missing), /no previous page/);

  const closed = await call(
    actions({
      async scroll() {
        throw new Error('The browser is not open.');
      }
    }),
    'browser_scroll',
    { dy: 10 }
  );
  assert.equal(closed.isError, true);
  assert.match(text(closed), /not open/);
});

test('a tool the build has not wired yet reports that instead of throwing', async () => {
  for (const name of ['browser_scroll', 'browser_back', 'browser_forward', 'browser_reload', 'browser_close']) {
    const result = await call(actions(), name, name === 'browser_scroll' ? { dy: 100 } : {});
    assert.equal(result.isError, true, name);
    assert.match(text(result), /not available in this build/, name);
  }
});
