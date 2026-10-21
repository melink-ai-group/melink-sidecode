import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_TOOL_NAMES, browserPermissionKeys, codexBrowserConfig, mergeOpencodeMcp, type BrowserCommand } from './config.ts';
import { ConsoleBuffer, EMPTY_CONSOLE_TEXT, attachPageDiagnostics, navigatePage } from './consoleBuffer.ts';
import {
  browserSkillEnabled,
  browserSkillEnabledFor,
  configuredSettingValue,
  navigationDecision
} from './policy.ts';
import { BrowserPage, type PlaywrightModule, type PlaywrightPage } from './session.ts';
import { BROWSER_TOOLS, runBrowserTool, type BrowserActions } from './tools.ts';
import { buildOpencodeConfig } from '../backends/opencode/config.ts';

const command: BrowserCommand = {
  command: 'C:\\Program Files\\Code.exe',
  args: ['C:\\ext\\dist\\browser-mcp.js', '--endpoint-file', 'C:\\data\\browser-endpoint.json'],
  env: { ELECTRON_RUN_AS_NODE: '1' }
};

test('browser control defaults on and stays off only when set off', () => {
  assert.equal(browserSkillEnabled(undefined), true);
  assert.equal(browserSkillEnabled(true), true);
  assert.equal(browserSkillEnabled(false), false);
});

test('per-provider browser flags fall back to the legacy browser key', () => {
  assert.equal(browserSkillEnabledFor('codex', {}), true);
  assert.equal(browserSkillEnabledFor('opencode', { browser: false }), false);
  assert.equal(browserSkillEnabledFor('codex', { browser: false, browserCodex: true }), true);
  assert.equal(browserSkillEnabledFor('opencode', { browser: true, browserOpencode: false }), false);
});

test('configuredSettingValue ignores package defaults', () => {
  assert.equal(configuredSettingValue(undefined), undefined);
  assert.equal(configuredSettingValue({ defaultValue: true } as { globalValue?: boolean }), undefined);
  assert.equal(configuredSettingValue({ globalValue: false }), false);
  assert.equal(configuredSettingValue({ workspaceValue: true, globalValue: false }), true);
});

test('navigation allows localhost and asks before any other origin', () => {
  const allowed = new Set<string>();
  assert.equal(navigationDecision('http://localhost:3000/app', allowed), 'allow');
  assert.equal(navigationDecision('http://127.0.0.1:5173/', allowed), 'allow');
  assert.equal(navigationDecision('http://[::1]/', allowed), 'allow');
  assert.equal(navigationDecision('https://example.com/page', allowed), 'ask');
  assert.equal(navigationDecision('file:///C:/secret.html', allowed), 'invalid');
  allowed.add('https://example.com');
  assert.equal(navigationDecision('https://example.com/other', allowed), 'allow');
});

test('a denied external address is not opened, and an allowed one is', async () => {
  const opened: string[] = [];
  const actions = fakeActions(opened);
  const denied = await runBrowserTool(actions, 'browser_navigate', { url: 'https://example.com' }, async () => false, new Set());
  assert.equal(denied.isError, true);
  assert.deepEqual(opened, []);

  const allowed = new Set<string>();
  const accepted = await runBrowserTool(
    actions,
    'browser_navigate',
    { url: 'https://example.com/docs' },
    async (origin) => {
      allowed.add(origin);
      return true;
    },
    allowed
  );
  assert.equal(accepted.isError, undefined);
  assert.deepEqual(opened, ['https://example.com/docs']);

  const local = await runBrowserTool(actions, 'browser_navigate', { url: 'http://localhost:3000' }, async () => false, new Set());
  assert.equal(local.isError, undefined);
  assert.deepEqual(opened, ['https://example.com/docs', 'http://localhost:3000']);
});

test('codex thread config includes the browser server only when the skill is on', () => {
  assert.equal(codexBrowserConfig(undefined), null);
  const config = codexBrowserConfig(command);
  assert.ok(config);
  const servers = config.mcp_servers as { melink_browser: { command: string; args: string[]; env: Record<string, string>; enabled: boolean } };
  assert.equal(servers.melink_browser.command, command.command);
  assert.deepEqual(servers.melink_browser.args, command.args);
  assert.equal(servers.melink_browser.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(servers.melink_browser.enabled, true);
});

test('opencode keeps an existing mcp server when the browser server is added', () => {
  assert.equal(mergeOpencodeMcp({ zvec_grep: { command: ['zg'] } }, undefined)?.zvec_grep !== undefined, true);
  const merged = mergeOpencodeMcp({ zvec_grep: { command: ['zg'] } }, command);
  assert.deepEqual(merged?.zvec_grep, { command: ['zg'] });
  const server = merged?.melink_browser as { command: string[] };
  assert.deepEqual(server.command, [command.command, ...command.args]);
});

test('an opencode turn config carries the browser server only when asked', () => {
  const off = buildOpencodeConfig({
    baseUrl: 'https://ollama.com',
    modelIds: ['m'],
    modelId: 'm',
    mode: 'agent',
    permissionLevel: 'default'
  });
  assert.equal(off.config.mcp, undefined);
  assert.equal((off.config.permission as Record<string, string>).melink_browser, undefined);

  const on = buildOpencodeConfig({
    baseUrl: 'https://ollama.com',
    modelIds: ['m'],
    modelId: 'm',
    mode: 'ask',
    permissionLevel: 'default',
    browser: command
  });
  assert.equal((on.config.permission as Record<string, string>).edit, 'deny');
  assert.equal((on.config.permission as Record<string, string>).melink_browser, 'allow');
  assert.equal((on.config.permission as Record<string, string>).browser_snapshot, 'allow');
  const mcp = on.config.mcp as Record<string, { type: string }>;
  assert.equal(mcp.melink_browser?.type, 'local');
  const agent = (on.config.agent as Record<string, { permission: Record<string, string> }>)[on.agent];
  assert.equal(agent?.permission.melink_browser, 'allow');
  assert.equal(agent?.permission.bash, 'deny');
});

test('browser permission keys allow the server and each tool', () => {
  const keys = browserPermissionKeys();
  assert.equal(keys.melink_browser, 'allow');
  assert.equal(keys.browser_navigate, 'allow');
  assert.equal(keys.browser_click, 'allow');
  assert.equal(keys.browser_console, 'allow');
});

test('browser_console is listed with an empty schema and states the buffer behavior', () => {
  const tool = BROWSER_TOOLS.find((item) => item.name === 'browser_console');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  assert.match(tool.description, /200/);
  assert.match(tool.description, /address bar or browser_navigate starts a navigation/i);
  assert.match(tool.description, /in-page links, reloads and form submissions do not clear/i);
});

test('browser_console dispatches to the actions and returns formatted text', async () => {
  const result = await runBrowserTool(fakeActions([]), 'browser_console', {}, async () => false, new Set());
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.content, [{ type: 'text', text: EMPTY_CONSOLE_TEXT }]);
});

test('browser_console returns the buffer text the actions provide', async () => {
  const actions: BrowserActions = {
    ...fakeActions([]),
    async console() {
      return '[error] http://localhost:3000 [404]: HTTP 404 Not Found';
    }
  };
  const result = await runBrowserTool(actions, 'browser_console', {}, async () => false, new Set());
  assert.deepEqual(result.content, [{ type: 'text', text: '[error] http://localhost:3000 [404]: HTTP 404 Not Found' }]);
});

test('attachPageDiagnostics captures all events in order, detaches, and reattaches without duplicates', () => {
  const buffer = new ConsoleBuffer();
  const page = new FakePage();
  const detach = attachPageDiagnostics(page, buffer);

  page.emit('console', consoleMessage('one'));
  page.emit('pageerror', { message: 'boom', stack: 'Error: boom\n    at handler (app.js:1:2)' });
  page.emit('requestfailed', { url: () => 'http://localhost:3000/api', failure: () => ({ errorText: 'net::ERR_FAILED' }) });
  page.emit('response', { url: () => 'http://localhost:3000/missing', status: () => 404, statusText: () => 'Not Found' });

  assert.deepEqual(
    buffer.entries().map((entry) => entry.level),
    ['log', 'error', 'error', 'error']
  );
  assert.equal(buffer.size(), 4);

  const beforeDetach = buffer.format();
  detach();
  page.emit('console', consoleMessage('after detach'));
  assert.equal(buffer.format(), beforeDetach);

  const detachAgain = attachPageDiagnostics(page, buffer);
  page.emit('console', consoleMessage('reattached'));
  assert.equal(buffer.size(), 5);
  assert.equal(firstLineCount(buffer.format()), 5);
  detachAgain();
});

test('navigatePage clears before goto and keeps entries emitted during the new load', async () => {
  const buffer = new ConsoleBuffer();
  const page = new FakePage();
  attachPageDiagnostics(page, buffer);
  buffer.push({ level: 'log', text: 'stale', url: 'http://localhost:3000/' });

  let atGoto = '';
  page.beforeGoto = () => {
    atGoto = buffer.format();
  };
  const result = await navigatePage(page, buffer, 'http://localhost:3000/next');
  assert.equal(atGoto, EMPTY_CONSOLE_TEXT);
  assert.deepEqual(page.gotoCalls, ['http://localhost:3000/next']);
  assert.deepEqual(result, { url: 'http://localhost:3000/next', title: 'Page' });

  page.emit('console', consoleMessage('loaded'));
  assert.match(buffer.format(), /loaded/);
  assert.doesNotMatch(buffer.format(), /stale/);
});

test('open attaches diagnostics once per page and close removes them and clears the buffer', async () => {
  const { module, browsers } = fakePlaywright();
  const browserPage = new BrowserPage(module);

  await browserPage.open(() => undefined);
  const first = browsers[0]?.pages[0];
  assert.ok(first);
  assert.deepEqual(first.added, ['console', 'pageerror', 'requestfailed', 'response']);

  first.emit('console', consoleMessage('first page'));
  assert.equal(firstLineCount(browserPage.consoleText()), 1);

  await browserPage.close();
  assert.deepEqual(first.removed, ['console', 'pageerror', 'requestfailed', 'response']);
  assert.equal(browserPage.consoleText(), EMPTY_CONSOLE_TEXT);
  assert.equal(browsers[0]?.closed, true);
  first.emit('console', consoleMessage('after close'));
  assert.equal(browserPage.consoleText(), EMPTY_CONSOLE_TEXT);

  await browserPage.open(() => undefined);
  const second = browsers[1]?.pages[0];
  assert.ok(second);
  assert.deepEqual(second.added, ['console', 'pageerror', 'requestfailed', 'response']);
  second.emit('console', consoleMessage('second page'));
  assert.equal(firstLineCount(browserPage.consoleText()), 1);
  assert.match(browserPage.consoleText(), /second page/);
  await browserPage.close();
});

test('navigate clears before goto and keeps entries emitted afterwards', async () => {
  const { module, browsers } = fakePlaywright();
  const browserPage = new BrowserPage(module);
  await browserPage.open(() => undefined);
  const page = browsers[0]?.pages[0];
  assert.ok(page);

  page.emit('console', consoleMessage('before navigation'));
  assert.match(browserPage.consoleText(), /before navigation/);

  let atGoto = '';
  page.beforeGoto = () => {
    atGoto = browserPage.consoleText();
  };
  await browserPage.navigate('http://localhost:3000/next');
  assert.equal(atGoto, EMPTY_CONSOLE_TEXT);
  assert.deepEqual(page.gotoCalls, ['http://localhost:3000/next']);

  page.emit('console', consoleMessage('after navigation'));
  page.emit('response', { url: () => 'http://localhost:3000/next', status: () => 500 });
  const text = browserPage.consoleText();
  assert.match(text, /after navigation/);
  assert.doesNotMatch(text, /before navigation/);
  assert.match(text, /\[error\] http:\/\/localhost:3000\/next \[500\]: HTTP 500/);
  await browserPage.close();
});

test('non-navigation actions do not clear buffered diagnostics', async () => {
  const { module, browsers } = fakePlaywright();
  const browserPage = new BrowserPage(module);
  await browserPage.open(() => undefined);
  const page = browsers[0]?.pages[0];
  assert.ok(page);

  page.emit('console', consoleMessage('kept'));
  const before = browserPage.consoleText();
  await browserPage.resize(900, 700);
  await browserPage.snapshot();
  await browserPage.click({ selector: '#save' });
  await browserPage.click({ text: 'Save' });
  await browserPage.click({ x: 10, y: 20 });
  await browserPage.type('hello', '#name');
  await browserPage.type('hello');
  await browserPage.press('Enter');
  await browserPage.press('a');
  assert.equal(browserPage.consoleText(), before);
  await browserPage.close();
});

function firstLineCount(text: string): number {
  return text === EMPTY_CONSOLE_TEXT ? 0 : text.split('\n').length;
}

function consoleMessage(text: string): {
  type: () => string;
  text: () => string;
  location: () => { url: string };
} {
  return {
    type: () => 'log',
    text: () => text,
    location: () => ({ url: 'http://localhost:3000/' })
  };
}

type PageEventName = 'console' | 'pageerror' | 'requestfailed' | 'response';

class FakeCdp {
  readonly sent: string[] = [];
  detaches = 0;

  async send(method: string): Promise<unknown> {
    this.sent.push(method);
    return undefined;
  }

  on(_event: 'Page.screencastFrame', _handler: (frame: { data: string; sessionId: number }) => void): void {
    return undefined;
  }

  async detach(): Promise<void> {
    this.detaches += 1;
  }
}

class FakePage implements PlaywrightPage {
  readonly added: PageEventName[] = [];
  readonly removed: PageEventName[] = [];
  readonly gotoCalls: string[] = [];
  readonly cdp = new FakeCdp();
  beforeGoto?: () => void;
  private readonly handlers = new Map<PageEventName, Set<(value: unknown) => void>>();
  private currentUrl = 'about:blank';
  private size = { width: 1280, height: 800 };

  on(event: PageEventName, handler: (value: unknown) => void): void {
    this.added.push(event);
    const handlers = this.handlers.get(event) ?? new Set<(value: unknown) => void>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
  }

  off(event: PageEventName, handler: (value: unknown) => void): void {
    this.removed.push(event);
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: PageEventName, value: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(value);
    }
  }

  async goto(url: string): Promise<unknown> {
    this.gotoCalls.push(url);
    this.beforeGoto?.();
    this.currentUrl = url;
    return undefined;
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return 'Page';
  }

  async evaluate<T>(_probe: () => T): Promise<T> {
    return { state: 'complete', hasBody: true, hasContent: true } as T;
  }

  async setViewportSize(size: { width: number; height: number }): Promise<void> {
    this.size = size;
  }

  viewportSize(): { width: number; height: number } {
    return this.size;
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from('png');
  }

  locator(_selector: string): {
    ariaSnapshot(): Promise<string>;
    click(options: { timeout: number }): Promise<void>;
    count(): Promise<number>;
  } {
    return {
      ariaSnapshot: async () => 'button "Save"',
      click: async () => undefined,
      count: async () => 1
    };
  }

  getByText(_text: string, _options: { exact: boolean }): {
    first(): { click(options: { timeout: number }): Promise<void> };
    count(): Promise<number>;
  } {
    return { first: () => ({ click: async () => undefined }), count: async () => 1 };
  }

  readonly mouse = { click: async (_x: number, _y: number) => undefined };
  readonly keyboard = {
    type: async (_text: string) => undefined,
    press: async (_key: string) => undefined,
    insertText: async (_text: string) => undefined
  };

  context(): { newCDPSession(page: PlaywrightPage): Promise<FakeCdp> } {
    return { newCDPSession: async () => this.cdp };
  }
}

class FakeBrowser {
  readonly pages: FakePage[] = [];
  closed = false;

  async newPage(): Promise<PlaywrightPage> {
    const page = new FakePage();
    this.pages.push(page);
    return page;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function fakePlaywright(): { module: PlaywrightModule; browsers: FakeBrowser[] } {
  const browsers: FakeBrowser[] = [];
  return {
    browsers,
    module: {
      chromium: {
        async launch() {
          const browser = new FakeBrowser();
          browsers.push(browser);
          return browser;
        }
      }
    }
  };
}

test('browser_navigate does not imply SideCode runs a localhost app', () => {
  const tool = BROWSER_TOOLS.find((entry) => entry.name === 'browser_navigate');
  assert.ok(tool);
  assert.doesNotMatch(tool.description, /usually localhost/i);
  assert.match(tool.description, /user provides/);
  assert.match(tool.description, /already running/);
});

test('browser_assert is listed with a bounded schema and its permission key', () => {
  const tool = BROWSER_TOOLS.find((entry) => entry.name === 'browser_assert');
  assert.ok(tool);
  assert.match(tool.description, /2 seconds/);
  const schema = tool.inputSchema as {
    properties: Record<string, unknown>;
    additionalProperties: boolean;
    anyOf: Array<{ required: string[] }>;
  };
  assert.deepEqual(Object.keys(schema.properties).sort(), ['selector', 'status', 'text', 'url']);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.anyOf.length, 4);
  assert.deepEqual(
    schema.anyOf.map((entry) => entry.required[0]),
    ['selector', 'text', 'url', 'status']
  );
  assert.ok((BROWSER_TOOL_NAMES as readonly string[]).includes('browser_assert'));
  assert.equal(browserPermissionKeys().browser_assert, 'allow');
});

test('an unreachable navigation is an error with the reason in the text', async () => {
  const actions = fakeActions([], {
    async navigate(url) {
      return { ok: false, kind: 'not-reachable', url, reason: 'connection refused' };
    }
  });
  const result = await runBrowserTool(actions, 'browser_navigate', { url: 'http://localhost:9' }, async () => true, new Set());
  assert.equal(result.isError, true);
  assert.equal(result.content[0]?.text, 'http://localhost:9 is not reachable: connection refused');
});

test('a timeout navigation is an error and never reads as opened', async () => {
  const actions = fakeActions([], {
    async navigate(url) {
      return { ok: false, kind: 'timeout', url, reason: 'the page did not become ready within 15s' };
    }
  });
  const result = await runBrowserTool(actions, 'browser_navigate', { url: 'https://example.com' }, async () => true, new Set());
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /is not reachable: the page did not become ready/);
  assert.doesNotMatch(result.content[0]?.text ?? '', /^Opened/);
});

test('browser_assert returns pass and mismatch results from the actions', async () => {
  const calls: unknown[] = [];
  const passing = fakeActions([], {
    async assert(input) {
      calls.push(input);
      return { ok: true, message: 'Assertion passed: selector "#save", URL "http://localhost:3000/".' };
    }
  });
  const pass = await runBrowserTool(passing, 'browser_assert', { selector: '#save', url: 'http://localhost:3000/' }, async () => true, new Set());
  assert.equal(pass.isError, undefined);
  assert.match(pass.content[0]?.text ?? '', /Assertion passed/);
  assert.deepEqual(calls, [{ selector: '#save', url: 'http://localhost:3000/' }]);

  const failing = fakeActions([], {
    async assert() {
      return { ok: false, message: 'Selector not found: #missing at http://localhost:3000/.' };
    }
  });
  const fail = await runBrowserTool(failing, 'browser_assert', { selector: '#missing' }, async () => true, new Set());
  assert.equal(fail.isError, true);
  assert.equal(fail.content[0]?.text, 'Selector not found: #missing at http://localhost:3000/.');
});

test('browser_assert needs at least one criterion', async () => {
  const result = await runBrowserTool(fakeActions([]), 'browser_assert', {}, async () => true, new Set());
  assert.equal(result.isError, true);
  assert.equal(result.content[0]?.text, 'Provide a selector, text, url, or status to assert.');
});

test('assertion mismatch and unreachable navigation stay distinct', async () => {
  const actions = fakeActions([], {
    async navigate(url) {
      return { ok: false, kind: 'not-reachable', url, reason: 'DNS lookup failed' };
    },
    async assert() {
      return { ok: false, message: 'Text not found: "Dashboard" at http://missing.invalid/.' };
    }
  });
  const navigation = await runBrowserTool(actions, 'browser_navigate', { url: 'http://missing.invalid' }, async () => true, new Set());
  const assertion = await runBrowserTool(actions, 'browser_assert', { text: 'Dashboard' }, async () => true, new Set());
  assert.equal(navigation.isError, true);
  assert.match(navigation.content[0]?.text ?? '', /is not reachable: DNS lookup failed/);
  assert.equal(assertion.isError, true);
  assert.equal(assertion.content[0]?.text, 'Text not found: "Dashboard" at http://missing.invalid/.');
  assert.doesNotMatch(assertion.content[0]?.text ?? '', /not reachable/i);
});

test('an assertion with no page open says so instead of not-reachable', async () => {
  const actions = fakeActions([], {
    async assert() {
      throw new Error('The browser is not open; navigate first.');
    }
  });
  const result = await runBrowserTool(actions, 'browser_assert', { selector: '#save' }, async () => true, new Set());
  assert.equal(result.isError, true);
  assert.equal(result.content[0]?.text, 'The browser is not open; navigate first.');
  assert.doesNotMatch(result.content[0]?.text ?? '', /not reachable/i);
});

test('snapshot text carries the saved path and keeps the inline image', async () => {
  const path = 'C:\\work\\.melink\\reports\\browser\\20261021-123456-789-001-login-page.png';
  const actions = fakeActions([], {
    async snapshot() {
      return {
        text: 'button "Save"',
        pngBase64: 'image-bytes',
        path,
        url: 'https://example.com/login?token=SECRET',
        title: 'Login page'
      };
    }
  });
  const result = await runBrowserTool(actions, 'browser_snapshot', {}, async () => true, new Set());
  const text = result.content[0]?.text ?? '';
  assert.match(text, /button "Save"/);
  assert.match(text, /Screenshot saved to C:\\work\\\.melink\\reports\\browser\\/);
  assert.match(text, /https:\/\/example\.com\/login\?token=SECRET/);
  assert.match(text, /Login page/);
  const image = result.content[1];
  assert.equal(image?.type, 'image');
  assert.equal(image?.data, 'image-bytes');
  assert.equal(image?.mimeType, 'image/png');
  assert.equal(result.isError, undefined);
});

test('snapshot text omits the saved path when the action did not write one', async () => {
  const result = await runBrowserTool(fakeActions([]), 'browser_snapshot', {}, async () => true, new Set());
  assert.doesNotMatch(result.content[0]?.text ?? '', /Screenshot saved/);
});

function fakeActions(opened: string[], overrides: Partial<BrowserActions> = {}): BrowserActions {
  return {
    async navigate(url) {
      opened.push(url);
      return { ok: true, url, title: 'Page', status: 200 };
    },
    async resize(width, height) {
      return { width, height };
    },
    async snapshot() {
      return { text: 'button "Save"', pngBase64: 'abc' };
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
      return new ConsoleBuffer().format();
    },
    async assert(_input) {
      return { ok: true, message: 'Assertion passed.' };
    },
    ...overrides
  };
}