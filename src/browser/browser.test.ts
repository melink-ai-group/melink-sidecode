import test from 'node:test';
import assert from 'node:assert/strict';
import { browserPermissionKeys, codexBrowserConfig, mergeOpencodeMcp, type BrowserCommand } from './config.ts';
import {
  browserSkillEnabled,
  browserSkillEnabledFor,
  configuredSettingValue,
  navigationDecision,
  originApprovalCopy,
  SessionOrigins
} from './policy.ts';
import { runBrowserTool, type BrowserActions, type OriginApproval, type ToolResult } from './tools.ts';
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

function resultText(result: ToolResult): string {
  return result.content.map((part) => part.text ?? '').join('\n');
}

function fakeActions(opened: string[]): BrowserActions {
  return {
    async navigate(url) {
      opened.push(url);
      return { url, title: 'Page' };
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
    }
  };
}
