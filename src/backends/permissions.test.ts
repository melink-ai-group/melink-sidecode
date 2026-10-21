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
    approvalPolicy: {
      granular: {
        sandbox_approval: true,
        rules: false,
        skill_approval: true,
        request_permissions: true,
        mcp_elicitations: true
      }
    }
  });
  assert.deepEqual(codexPermissionMapping('unrestricted'), {
    sandbox: 'danger-full-access',
    approvalPolicy: 'never'
  });
});

test('Codex default can prompt for sandboxed commands so the safety gate runs', () => {
  const policy = codexPermissionMapping('default').approvalPolicy;
  assert.equal(typeof policy, 'object');
  if (typeof policy !== 'object' || policy === null || !('granular' in policy)) {
    assert.fail('expected a granular approval policy');
  }
  assert.equal(policy.granular.sandbox_approval, true);
  assert.equal(policy.granular.rules, false);
  assert.equal(policy.granular.skill_approval, true);
  assert.equal(policy.granular.request_permissions, true);
  assert.equal(policy.granular.mcp_elicitations, true);
});

test('the mapping uses native generated values and never a deprecated policy', () => {
  // The deprecated `untrusted` policy must not appear anywhere in the mapping.
  const policies = Object.values(CODEX_PERMISSION_MAP).map((entry) => entry.approvalPolicy);
  assert.ok(!policies.includes('untrusted' as never));
  for (const entry of Object.values(CODEX_PERMISSION_MAP)) {
    assert.ok(['read-only', 'workspace-write', 'danger-full-access'].includes(entry.sandbox));
    const policy = entry.approvalPolicy;
    const native =
      policy === 'on-request' ||
      policy === 'never' ||
      (typeof policy === 'object' && policy !== null && 'granular' in policy);
    assert.equal(native, true);
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
    // Default stays inside the workspace and denies the network, matching the
    // documented sandbox rather than silently opening it.
    assert.equal(workspace.networkAccess, false);
  }
});

test('default denies network access while unrestricted keeps full access', () => {
  // Assert each policy in full: a short-circuited `type === ... && network`
  // check would pass even if the sandbox type were wrong.
  assert.deepEqual(codexSandboxPolicy('read-only', '/work'), {
    type: 'readOnly',
    networkAccess: false
  });
  assert.deepEqual(codexSandboxPolicy('default', '/work'), {
    type: 'workspaceWrite',
    writableRoots: ['/work'],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  });
  assert.deepEqual(codexSandboxPolicy('unrestricted', '/work'), {
    type: 'dangerFullAccess'
  });
  assert.deepEqual(codexPermissionMapping('default').sandbox, 'workspace-write');
  assert.deepEqual(codexPermissionMapping('unrestricted').approvalPolicy, 'never');
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

test('all three permission levels keep their labels and meaning in the descriptor map', () => {
  assert.deepEqual(
    PERMISSION_LEVEL_DESCRIPTORS.map((entry) => entry.level),
    ['read-only', 'default', 'unrestricted']
  );
  assert.deepEqual(
    PERMISSION_LEVEL_DESCRIPTORS.map((entry) => entry.label),
    ['Read-only', 'Default', 'Unrestricted']
  );

  const readOnly = permissionDescriptor('read-only');
  assert.equal(readOnly.level, 'read-only');
  assert.match(readOnly.description, /^Read-only\b/);
  assert.match(readOnly.description, /write/i);

  const workspace = permissionDescriptor('default');
  assert.equal(workspace.level, 'default');
  assert.match(workspace.description, /inside the workspace/i);
  assert.match(workspace.description, /outside the sandbox/i);

  const unrestricted = permissionDescriptor('unrestricted');
  assert.equal(unrestricted.level, 'unrestricted');
  assert.match(unrestricted.description, /no sandbox/i);
  assert.match(unrestricted.description, /no prompts/i);
});

test('permission descriptors name no provider, so the copy stays provider-neutral', () => {
  const providerNames = /Codex|Ollama|OpenCode|Zen/i;
  for (const entry of PERMISSION_LEVEL_DESCRIPTORS) {
    assert.equal(providerNames.test(entry.description), false, `${entry.level}: ${entry.description}`);
    assert.ok(entry.description.length > 0, `${entry.level} has no description`);
    assert.equal(permissionDescriptor(entry.level).label, entry.label);
  }
});
