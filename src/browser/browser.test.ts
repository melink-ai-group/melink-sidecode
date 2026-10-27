import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_TOOL_NAMES,
  browserAgentCallAllowed,
  browserEndpointFileName,
  browserPermissionKeys,
  codexBrowserConfig,
  mergeOpencodeMcp,
  type BrowserCommand
} from './config.ts';
import { ConsoleBuffer, EMPTY_CONSOLE_TEXT, attachPageDiagnostics, navigatePage } from './consoleBuffer.ts';
import {
  browserSkillEnabled,
  browserSkillEnabledFor,
  configuredSettingValue,
  navigationDecision,
  originApprovalCopy,
  originApprovalRequired,
  SessionOrigins
} from './policy.ts';
import { BrowserPage, type PlaywrightModule, type PlaywrightPage } from './session.ts';
import { BROWSER_TOOLS, runBrowserTool, type BrowserActions, type OriginApproval, type ToolResult } from './tools.ts';
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

test('only Ask mode asks for an origin', () => {
  assert.equal(originApprovalRequired('ask'), true);
  assert.equal(originApprovalRequired('agent'), false);
  assert.equal(originApprovalRequired('plan'), false);
});

test('navigation asks for localhost too until that exact origin is granted', () => {
  const granted = new SessionOrigins();
  assert.equal(navigationDecision('http://localhost:3000/app', granted), 'ask');
  assert.equal(navigationDecision('http://127.0.0.1:5173/', granted), 'ask');
  assert.equal(navigationDecision('http://[::1]/', granted), 'ask');
  assert.equal(navigationDecision('https://example.com/page', granted), 'ask');

  granted.add('http://localhost:3000');
  assert.equal(navigationDecision('http://localhost:3000/other', granted), 'allow');
  assert.equal(navigationDecision('http://localhost:5173/', granted), 'ask');
  assert.equal(navigationDecision('http://127.0.0.1:3000/', granted), 'ask');
  assert.equal(navigationDecision('http://[::1]:3000/', granted), 'ask');
  assert.equal(navigationDecision('https://localhost:3000/', granted), 'ask');
  assert.equal(navigationDecision('https://example.com/page', granted), 'ask');
});

test('a grant covers only the same scheme, host alias and port', () => {
  const granted = new SessionOrigins().add('https://example.com');
  assert.equal(navigationDecision('https://example.com/other', granted), 'allow');
  assert.equal(navigationDecision('http://example.com/', granted), 'ask');
  assert.equal(navigationDecision('https://example.com:8443/', granted), 'ask');
  assert.equal(navigationDecision('https://www.example.com/', granted), 'ask');
});

test('only http and https addresses are valid', () => {
  const granted = new SessionOrigins();
  for (const url of [
    'file:///C:/secret.html',
    'javascript:alert(1)',
    'ftp://example.com/file',
    'about:blank',
    'data:text/html,hi',
    'not a url'
  ]) {
    assert.equal(navigationDecision(url, granted), 'invalid', url);
  }
});

test('allow once opens one navigation and asks again on the next call', async () => {
  const opened: string[] = [];
  const actions = fakeActions(opened);
  const granted = new SessionOrigins();
  const asked: string[] = [];
  const allow = async (origin: string): Promise<OriginApproval> => {
    asked.push(origin);
    return 'once';
  };

  const first = await runBrowserTool(actions, 'browser_navigate', { url: 'http://localhost:3000/' }, allow, granted);
  const second = await runBrowserTool(actions, 'browser_navigate', { url: 'http://localhost:3000/next' }, allow, granted);

  assert.equal(first.isError, undefined);
  assert.equal(second.isError, undefined);
  assert.deepEqual(opened, ['http://localhost:3000/', 'http://localhost:3000/next']);
  assert.deepEqual(asked, ['http://localhost:3000', 'http://localhost:3000']);
  assert.equal(granted.has('http://localhost:3000'), false);
});

test('allow for this session grants the exact origin and stops asking until cleared', async () => {
  const opened: string[] = [];
  const actions = fakeActions(opened);
  const granted = new SessionOrigins();
  let asked = 0;
  const allow = async (origin: string): Promise<OriginApproval> => {
    asked += 1;
    granted.add(origin);
    return 'session';
  };

  await runBrowserTool(actions, 'browser_navigate', { url: 'http://localhost:3000/a' }, allow, granted);
  await runBrowserTool(actions, 'browser_navigate', { url: 'http://localhost:3000/b' }, allow, granted);
  assert.equal(asked, 1);
  assert.equal(granted.has('http://localhost:3000'), true);

  const other = await runBrowserTool(
    actions,
    'browser_navigate',
    { url: 'http://localhost:5173/' },
    async (origin) => {
      asked += 1;
      granted.add(origin);
      return 'session';
    },
    granted
  );
  assert.equal(other.isError, undefined);
  assert.equal(asked, 2);

  granted.clear();
  assert.equal(granted.has('http://localhost:3000'), false);
  assert.equal(granted.has('http://localhost:5173'), false);
  assert.equal(navigationDecision('http://localhost:3000/', granted), 'ask');
});

test('the tool reports the choice without granting the origin itself', async () => {
  const opened: string[] = [];
  const granted = new SessionOrigins();
  const result = await runBrowserTool(
    fakeActions(opened),
    'browser_navigate',
    { url: 'https://example.com/docs' },
    async () => 'session',
    granted
  );
  assert.equal(result.isError, undefined);
  assert.deepEqual(opened, ['https://example.com/docs']);
  assert.equal(granted.has('https://example.com'), false);
});

test('a denied origin is not opened and the error says it was denied', async () => {
  const opened: string[] = [];
  const actions = fakeActions(opened);
  const denied = await runBrowserTool(
    actions,
    'browser_navigate',
    { url: 'https://example.com' },
    async () => 'deny',
    new SessionOrigins()
  );
  assert.equal(denied.isError, true);
  assert.match(resultText(denied), /Navigation to https:\/\/example\.com was denied\./);
  assert.deepEqual(opened, []);

  const local = await runBrowserTool(
    actions,
    'browser_navigate',
    { url: 'http://localhost:3000' },
    async () => 'deny',
    new SessionOrigins()
  );
  assert.equal(local.isError, true);
  assert.match(resultText(local), /denied/);
  assert.deepEqual(opened, []);
});

test('origin approval copy names the ungated actions and both allow choices', () => {
  const copy = originApprovalCopy('http://localhost:3000');
  assert.match(copy, /http:\/\/localhost:3000/);
  for (const action of ['browser_click', 'browser_type', 'browser_press', 'browser_snapshot']) {
    assert.match(copy, new RegExp(action));
  }
  assert.match(copy, /Allow once/);
  assert.match(copy, /Allow for this session/);
  assert.match(copy, /one navigation/);
  assert.match(copy, /until the browser is stopped/);
  assert.match(copy, /browser tab you are watching/);
  assert.match(copy, /[Rr]edirects and in-page link or form navigation are not re-prompted/);
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
  assert.equal((off.config.permission as Record<string, string>).melink_browser_browser_navigate, undefined);

  const on = buildOpencodeConfig({
    baseUrl: 'https://ollama.com',
    modelIds: ['m'],
    modelId: 'm',
    mode: 'ask',
    permissionLevel: 'default',
    browser: command
  });
  assert.equal((on.config.permission as Record<string, string>).edit, 'deny');
  assert.equal((on.config.permission as Record<string, string>).melink_browser_browser_navigate, 'allow');
  assert.equal((on.config.permission as Record<string, string>).melink_browser_browser_snapshot, 'allow');
  assert.equal((on.config.permission as Record<string, string>).melink_browser, undefined);
  assert.equal((on.config.permission as Record<string, string>).browser_navigate, undefined);
  const mcp = on.config.mcp as Record<string, { type: string }>;
  assert.equal(mcp.melink_browser?.type, 'local');
  const agent = (on.config.agent as Record<string, { permission: Record<string, string> }>)[on.agent];
  assert.equal(agent?.permission.melink_browser_browser_navigate, 'allow');
  assert.equal(agent?.permission.bash, 'deny');
});

test('browser permission keys are the resolved server_tool names, never the bare ones', () => {
  const keys = browserPermissionKeys();
  const tools = BROWSER_TOOLS.map((tool) => tool.name);
  assert.deepEqual(Object.keys(keys).sort(), tools.map((name) => `melink_browser_${name}`).sort());
  assert.equal(keys.melink_browser_browser_navigate, 'allow');
  assert.equal(keys.melink_browser_browser_click, 'allow');
  assert.equal(keys.melink_browser_browser_console, 'allow');
  assert.equal(keys.melink_browser, undefined);
  assert.equal(keys.browser_navigate, undefined);
  assert.equal(keys.browser_click, undefined);
});

test('a tool added to the list gets a permission key without a second list', () => {
  // BROWSER_TOOL_NAMES is derived from BROWSER_TOOLS so Dev B's new tools are
  // covered by the same rule; pin the invariant rather than a fixed count.
  assert.deepEqual([...BROWSER_TOOL_NAMES], BROWSER_TOOLS.map((tool) => tool.name));
  for (const name of BROWSER_TOOL_NAMES) {
    assert.equal(browserPermissionKeys()[`melink_browser_${name}`], 'allow', name);
  }
});

test('each window endpoint file is unique and keeps the pid', () => {
  const a = browserEndpointFileName('a'.repeat(48), 1234);
  const b = browserEndpointFileName('b'.repeat(48), 1234);
  assert.notEqual(a, b);
  assert.match(a, /^browser-endpoint-1234-a+\.json$/);
  assert.match(browserEndpointFileName('../evil token?', 7), /^browser-endpoint-7-eviltoken\.json$/);
  assert.match(browserEndpointFileName('', 7), /^browser-endpoint-7-window\.json$/);
});

test('an agent call uses only its own provider; panel calls need either', () => {
  const settings = { codex: false, opencode: true };
  const enabled = (provider?: 'codex' | 'opencode'): boolean =>
    provider === undefined ? settings.codex || settings.opencode : settings[provider];
  assert.equal(browserAgentCallAllowed('codex', enabled), false);
  assert.equal(browserAgentCallAllowed('opencode', enabled), true);
  assert.equal(browserAgentCallAllowed(undefined, enabled), true);
  assert.equal(browserAgentCallAllowed('codex', () => false), false);
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
  const result = await runBrowserTool(fakeActions([]), 'browser_console', {}, async () => 'deny' as const, new Set());
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
  const result = await runBrowserTool(actions, 'browser_console', {}, async () => 'deny' as const, new Set());
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

  async goBack(): Promise<unknown> {
    return undefined;
  }

  async goForward(): Promise<unknown> {
    return undefined;
  }

  async reload(): Promise<unknown> {
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

  readonly mouse = {
    click: async (_x: number, _y: number) => undefined,
    wheel: async (_dx: number, _dy: number) => undefined
  };
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
  assert.equal(browserPermissionKeys().melink_browser_browser_assert, 'allow');
});

test('an unreachable navigation is an error with the reason in the text', async () => {
  const actions = fakeActions([], {
    async navigate(url) {
      return { ok: false, kind: 'not-reachable', url, reason: 'connection refused' };
    }
  });
  const result = await runBrowserTool(actions, 'browser_navigate', { url: 'http://localhost:9' }, async () => 'session' as const, new Set());
  assert.equal(result.isError, true);
  assert.equal(result.content[0]?.text, 'http://localhost:9 is not reachable: connection refused');
});

test('a timeout navigation is an error and never reads as opened', async () => {
  const actions = fakeActions([], {
    async navigate(url) {
      return { ok: false, kind: 'timeout', url, reason: 'the page did not become ready within 15s' };
    }
  });
  const result = await runBrowserTool(actions, 'browser_navigate', { url: 'https://example.com' }, async () => 'session' as const, new Set());
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
  const pass = await runBrowserTool(passing, 'browser_assert', { selector: '#save', url: 'http://localhost:3000/' }, async () => 'session' as const, new Set());
  assert.equal(pass.isError, undefined);
  assert.match(pass.content[0]?.text ?? '', /Assertion passed/);
  assert.deepEqual(calls, [{ selector: '#save', url: 'http://localhost:3000/' }]);

  const failing = fakeActions([], {
    async assert() {
      return { ok: false, message: 'Selector not found: #missing at http://localhost:3000/.' };
    }
  });
  const fail = await runBrowserTool(failing, 'browser_assert', { selector: '#missing' }, async () => 'session' as const, new Set());
  assert.equal(fail.isError, true);
  assert.equal(fail.content[0]?.text, 'Selector not found: #missing at http://localhost:3000/.');
});

test('browser_assert needs at least one criterion', async () => {
  const result = await runBrowserTool(fakeActions([]), 'browser_assert', {}, async () => 'session' as const, new Set());
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
  const navigation = await runBrowserTool(actions, 'browser_navigate', { url: 'http://missing.invalid' }, async () => 'session' as const, new Set());
  const assertion = await runBrowserTool(actions, 'browser_assert', { text: 'Dashboard' }, async () => 'session' as const, new Set());
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
  const result = await runBrowserTool(actions, 'browser_assert', { selector: '#save' }, async () => 'session' as const, new Set());
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
  const result = await runBrowserTool(actions, 'browser_snapshot', {}, async () => 'session' as const, new Set());
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
  const result = await runBrowserTool(fakeActions([]), 'browser_snapshot', {}, async () => 'session' as const, new Set());
  assert.doesNotMatch(result.content[0]?.text ?? '', /Screenshot saved/);
});

function resultText(result: ToolResult): string {
  return result.content.map((part) => part.text ?? '').join('\n');
}

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