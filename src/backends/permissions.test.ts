import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_PERMISSION_MAP,
  DEFAULT_PERMISSION_LEVEL,
  PERMISSION_LEVEL_DESCRIPTORS,
  codexPermissionMapping,
  codexSandboxPolicy,
  permissionDescriptor
} from './permissions.ts';
import { effectivePermissionLevel, modeForcesReadOnly, modeRefusesTools } from './modes.ts';

test('every shared permission level maps to a native Codex sandbox and approval policy', () => {
  assert.deepEqual(codexPermissionMapping('read-only'), {
    sandbox: 'read-only',
    approvalPolicy: 'on-request'
  });
  assert.deepEqual(codexPermissionMapping('default'), {
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request'
  });
  assert.deepEqual(codexPermissionMapping('unrestricted'), {
    sandbox: 'danger-full-access',
    approvalPolicy: 'never'
  });
});

test('the mapping uses native generated values and never a deprecated policy', () => {
  // The deprecated `untrusted` policy must not appear anywhere in the mapping:
  // it prompts only on untrusted commands, so building on it would silently
  // widen what runs without a prompt.
  const policies = Object.values(CODEX_PERMISSION_MAP).map((entry) => entry.approvalPolicy);
  assert.ok(!policies.includes('untrusted' as never));
  for (const entry of Object.values(CODEX_PERMISSION_MAP)) {
    assert.ok(['read-only', 'workspace-write', 'danger-full-access'].includes(entry.sandbox));
    assert.ok(['untrusted', 'on-request', 'never'].includes(entry.approvalPolicy as never));
  }
});

test('an unknown level degrades to the sandboxed default, never to unrestricted', () => {
  assert.deepEqual(
    codexPermissionMapping('not-a-level' as never),
    CODEX_PERMISSION_MAP[DEFAULT_PERMISSION_LEVEL]
  );
  assert.equal(DEFAULT_PERMISSION_LEVEL, 'default');
});

test('the sandbox policy mirrors the level so a mid-turn change cannot drift', () => {
  assert.deepEqual(codexSandboxPolicy('read-only', '/work'), { type: 'readOnly', networkAccess: false });
  assert.deepEqual(codexSandboxPolicy('unrestricted', '/work'), { type: 'dangerFullAccess' });
  const workspace = codexSandboxPolicy('default', '/work');
  assert.equal(workspace.type, 'workspaceWrite');
  if (workspace.type === 'workspaceWrite') {
    assert.deepEqual(workspace.writableRoots, ['/work']);
  }
});

test('only unrestricted is flagged as requiring confirmation', () => {
  assert.equal(permissionDescriptor('unrestricted').requiresConfirmation, true);
  assert.equal(permissionDescriptor('default').requiresConfirmation, false);
  assert.equal(permissionDescriptor('read-only').requiresConfirmation, false);
  const dangerous = PERMISSION_LEVEL_DESCRIPTORS.filter((entry) => entry.requiresConfirmation);
  assert.deepEqual(
    dangerous.map((entry) => entry.level),
    ['unrestricted']
  );
});

test('ask mode routes a write attempt to the read-only sandbox, whatever level was picked', () => {
  // Ask forces the effective level to read-only, which maps to Codex's own
  // read-only sandbox even when unrestricted was selected.
  const mode = 'ask' as const;
  assert.equal(modeForcesReadOnly(mode), true);
  const level = effectivePermissionLevel(mode, 'unrestricted');
  assert.equal(level, 'read-only');
  assert.deepEqual(codexPermissionMapping(level), { sandbox: 'read-only', approvalPolicy: 'on-request' });
  assert.deepEqual(codexSandboxPolicy(level, '/work'), { type: 'readOnly', networkAccess: false });
});

test('agent mode keeps the selected level, including unrestricted', () => {
  const level = effectivePermissionLevel('agent', 'unrestricted');
  assert.equal(level, 'unrestricted');
  assert.deepEqual(codexPermissionMapping(level), { sandbox: 'danger-full-access', approvalPolicy: 'never' });
});

test('ask refuses tools outright while plan only narrows permissions', () => {
  assert.equal(modeRefusesTools('ask'), true);
  assert.equal(modeRefusesTools('plan'), false);
});
