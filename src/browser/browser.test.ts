import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_TOOL_NAMES, browserPermissionKeys, codexBrowserConfig, mergeOpencodeMcp, type BrowserCommand } from './config.ts';
import {
  browserSkillEnabled,
  browserSkillEnabledFor,
  configuredSettingValue,
  navigationDecision
} from './policy.ts';
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
  const agent = (on.config.agent as Record<string, { permission: Record<string, string> }>)['melink-ask'];
  assert.equal(agent?.permission.melink_browser, 'allow');
  assert.equal(agent?.permission.bash, 'deny');
});

test('browser permission keys allow the server and each tool', () => {
  const keys = browserPermissionKeys();
  assert.equal(keys.melink_browser, 'allow');
  assert.equal(keys.browser_navigate, 'allow');
  assert.equal(keys.browser_click, 'allow');
});

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
    async assert(input) {
      return { ok: true, message: `Assertion passed for ${JSON.stringify(input)}.` };
    },
    ...overrides
  };
}
