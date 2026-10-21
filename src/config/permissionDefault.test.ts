import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDefaultPermissionLevel } from './permissionDefault.ts';
import { codexPermissionMapping, permissionDescriptor } from '../backends/permissions.ts';

/**
 * The effective permission default.
 *
 * A repository must not be able to raise it: opening a workspace would then
 * be enough to remove the sandbox and the prompts for every new conversation.
 */

test('a workspace value of unrestricted is ignored', () => {
  const inspected = {
    defaultValue: 'default',
    workspaceValue: 'unrestricted'
  };
  assert.equal(resolveDefaultPermissionLevel(inspected), 'default');
});

test('a workspace-folder value of unrestricted is ignored', () => {
  const inspected = {
    defaultValue: 'default',
    workspaceFolderValue: 'unrestricted'
  };
  assert.equal(resolveDefaultPermissionLevel(inspected), 'default');
});

test('the global value of unrestricted is respected', () => {
  const inspected = {
    defaultValue: 'default',
    globalValue: 'unrestricted',
    workspaceValue: 'read-only'
  };
  assert.equal(resolveDefaultPermissionLevel(inspected), 'unrestricted');
});

test('the default stays default when nothing is set', () => {
  assert.equal(resolveDefaultPermissionLevel(undefined), 'default');
  assert.equal(resolveDefaultPermissionLevel({}), 'default');
  assert.equal(resolveDefaultPermissionLevel({ defaultValue: 'default' }), 'default');
});

test('a read-only global value is respected', () => {
  assert.equal(resolveDefaultPermissionLevel({ globalValue: 'read-only' }), 'read-only');
});

test('an unknown value degrades to default, never to unrestricted', () => {
  assert.equal(resolveDefaultPermissionLevel({ globalValue: 'yolo' }), 'default');
  assert.equal(resolveDefaultPermissionLevel({ globalValue: '' }), 'default');
});

test('an ignored workspace value leaves the sandbox and the prompts in place', () => {
  const level = resolveDefaultPermissionLevel({
    defaultValue: 'default',
    workspaceValue: 'unrestricted'
  });
  const mapping = codexPermissionMapping(level);
  // `never` (no approval prompts) and `danger-full-access` (no sandbox) are
  // reachable only for `unrestricted`.
  assert.notEqual(mapping.approvalPolicy, 'never');
  assert.notEqual(mapping.sandbox, 'danger-full-access');
  // And the level that asks for a confirmation is not the effective one.
  assert.equal(permissionDescriptor(level).requiresConfirmation, false);
});

test('a respected global unrestricted still maps to the dangerous pair', () => {
  const level = resolveDefaultPermissionLevel({ globalValue: 'unrestricted' });
  assert.equal(level, 'unrestricted');
  const mapping = codexPermissionMapping(level);
  assert.equal(mapping.sandbox, 'danger-full-access');
  assert.equal(mapping.approvalPolicy, 'never');
  // The labelled confirmation gate is a separate rule and is unchanged.
  assert.equal(permissionDescriptor(level).requiresConfirmation, true);
});
