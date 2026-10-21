import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GLOBAL_ONLY_KEYS,
  TRUST_SCOPED_KEYS,
  keyAllowsWorkspaceScope,
  saveScopeForKey,
  trustedBoolean,
  trustedOptionalSetting,
  trustedSetting,
  trustedString
} from './trust.ts';
import { fieldSaveOutcome } from './settingsScope.ts';

/**
 * The trust boundary rules, host-free.
 *
 * A workspace `.vscode/settings.json` must never decide where a credential is
 * sent, which binary is spawned, or what the permission default is. These
 * tests pin the rule that makes that true: only the user's own value and the
 * contributed default are ever read.
 */

test('a workspace value is ignored and the global value is used', () => {
  const inspected = {
    defaultValue: 'https://ollama.com',
    globalValue: 'https://user.example',
    workspaceValue: 'https://evil.example'
  };
  assert.equal(trustedSetting(inspected, 'https://ollama.com'), 'https://user.example');
});

test('a workspace-folder value is ignored too', () => {
  const inspected = {
    defaultValue: 'codex',
    globalValue: '/usr/local/bin/codex',
    workspaceFolderValue: './evil'
  };
  assert.equal(trustedSetting(inspected, 'codex'), '/usr/local/bin/codex');
});

test('without a global value the contributed default is used, not the workspace one', () => {
  const inspected = {
    defaultValue: 'https://ollama.com',
    workspaceValue: 'https://evil.example'
  };
  assert.equal(trustedSetting(inspected, 'https://fallback.example'), 'https://ollama.com');
});

test('without a global or a default value the caller fallback is used', () => {
  const inspected = { workspaceValue: 'https://evil.example' };
  assert.equal(trustedSetting(inspected, 'https://fallback.example'), 'https://fallback.example');
});

test('an uninspected key is the caller fallback', () => {
  assert.equal(trustedSetting(undefined, 'fallback'), 'fallback');
});

test('the optional read distinguishes unset from set-to-default', () => {
  assert.equal(trustedOptionalSetting({ defaultValue: 'off' }), 'off');
  assert.equal(trustedOptionalSetting({ globalValue: 'high' }), 'high');
  assert.equal(trustedOptionalSetting({}), undefined);
  assert.equal(trustedOptionalSetting(undefined), undefined);
  // A workspace value alone is still "unset" for the user.
  assert.equal(trustedOptionalSetting({ workspaceValue: 'high' }), undefined);
});

test('the string read trims and falls back on an empty value', () => {
  assert.equal(trustedString({ globalValue: '  codex  ' }, 'fallback'), 'codex');
  assert.equal(trustedString({ globalValue: '   ' }, 'fallback'), 'fallback');
  assert.equal(trustedString({ workspaceValue: 'evil' }, 'fallback'), 'fallback');
});

test('the boolean read keeps an explicit false and ignores a workspace true', () => {
  assert.equal(trustedBoolean({ globalValue: false }, true), false);
  assert.equal(trustedBoolean({ globalValue: true, workspaceValue: false }, false), true);
  assert.equal(trustedBoolean({ workspaceValue: true }, false), false);
});

test('the trust-scoped key list covers the three sensitive decisions', () => {
  // Where the Ollama Cloud bearer token goes.
  assert.equal(TRUST_SCOPED_KEYS.includes('melink.ollama.baseUrl'), true);
  // Where local prompts go.
  assert.equal(TRUST_SCOPED_KEYS.includes('melink.ollamaLocal.baseUrl'), true);
  // Which binary is spawned.
  assert.equal(TRUST_SCOPED_KEYS.includes('melink.ollama.opencode.path'), true);
  assert.equal(TRUST_SCOPED_KEYS.includes('melink.codex.path'), true);
  assert.equal(TRUST_SCOPED_KEYS.includes('melink.skills.zvecGrep.path'), true);
  assert.equal(TRUST_SCOPED_KEYS.includes('melink.skills.astGrep.path'), true);
  // The effective permission default.
  assert.equal(TRUST_SCOPED_KEYS.includes('melink.defaults.permissionLevel'), true);
});

test('only the trust-scoped keys refuse a workspace write', () => {
  assert.equal(keyAllowsWorkspaceScope('melink.ollama.baseUrl'), false);
  assert.equal(keyAllowsWorkspaceScope('melink.defaults.permissionLevel'), false);
  assert.equal(keyAllowsWorkspaceScope('melink.ollama.defaultModel'), true);
  assert.equal(keyAllowsWorkspaceScope('melink.context.maxBytes'), true);
  assert.equal(keyAllowsWorkspaceScope('melink.skills.browserCodex'), true);
});

test('the global-only list is the trust-scoped list', () => {
  assert.deepEqual([...GLOBAL_ONLY_KEYS].sort(), [...TRUST_SCOPED_KEYS].sort());
});

test('a trust-sensitive key is always written to the user settings', () => {
  assert.equal(saveScopeForKey('melink.ollama.baseUrl', 'workspace'), 'global');
  assert.equal(saveScopeForKey('melink.defaults.permissionLevel', 'workspace'), 'global');
  assert.equal(saveScopeForKey('melink.codex.path', 'workspace'), 'global');
  assert.equal(saveScopeForKey('melink.ollama.baseUrl', 'global'), 'global');
});

test('an ordinary key keeps the requested scope', () => {
  assert.equal(saveScopeForKey('melink.ollama.defaultModel', 'workspace'), 'workspace');
  assert.equal(saveScopeForKey('melink.context.maxBytes', 'workspace'), 'workspace');
  assert.equal(saveScopeForKey('melink.context.maxBytes', 'global'), 'global');
});

test('a trust-sensitive field saved to the workspace lands in the user settings', () => {
  const outcome = fieldSaveOutcome('melink.ollama.baseUrl', 'workspace');
  assert.equal(outcome.scope, 'global');
  assert.equal(outcome.redirected, true);
  // The value was persisted, so the message is a notice, not a refusal.
  assert.ok(outcome.notice);
  assert.match(outcome.notice as string, /user settings/);
});

test('a trust-sensitive field saved to the user settings is not redirected', () => {
  const outcome = fieldSaveOutcome('melink.ollama.baseUrl', 'global');
  assert.equal(outcome.scope, 'global');
  assert.equal(outcome.redirected, false);
  assert.equal(outcome.notice, undefined);
});

test('an ordinary field saved to the workspace is not redirected', () => {
  const outcome = fieldSaveOutcome('melink.context.maxBytes', 'workspace');
  assert.equal(outcome.scope, 'workspace');
  assert.equal(outcome.redirected, false);
  assert.equal(outcome.notice, undefined);
});

test('every trust-sensitive field redirects the same way', () => {
  for (const key of GLOBAL_ONLY_KEYS) {
    const outcome = fieldSaveOutcome(key, 'workspace');
    assert.equal(outcome.scope, 'global', key);
    assert.equal(outcome.redirected, true, key);
    assert.ok(outcome.notice, key);
  }
});
