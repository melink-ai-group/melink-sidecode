import test from 'node:test';
import assert from 'node:assert/strict';
import { browserPermissionKeys, codexBrowserConfig, mergeOpencodeMcp, type BrowserCommand } from './config.ts';
import {
  browserSkillEnabled,
  browserSkillEnabledFor,
  configuredSettingValue,
  navigationDecision
} from './policy.ts';
import { runBrowserTool, type BrowserActions } from './tools.ts';
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
});

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
