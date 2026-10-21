import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_OPENCODE_ENABLED_KEY,
  cleanLegacyOpencodeEnabled,
  shouldCleanLegacyOpencodeEnabled
} from './legacySettings.ts';

test('the legacy key is named once', () => {
  assert.equal(LEGACY_OPENCODE_ENABLED_KEY, 'melink.ollama.opencode.enabled');
});

test('a stale global value is cleaned', () => {
  assert.equal(shouldCleanLegacyOpencodeEnabled({ globalValue: true }), true);
  assert.equal(shouldCleanLegacyOpencodeEnabled({ globalValue: false }), true);
});

test('an unset global value is already clean and stays idempotent', () => {
  assert.equal(shouldCleanLegacyOpencodeEnabled(undefined), false);
  assert.equal(shouldCleanLegacyOpencodeEnabled({}), false);
  // After the global value is removed, the same inspect reports nothing to do.
  assert.equal(shouldCleanLegacyOpencodeEnabled({ globalValue: undefined, workspaceValue: true }), false);
});

test('workspace and folder values are never touched', () => {
  assert.equal(shouldCleanLegacyOpencodeEnabled({ workspaceValue: true }), false);
  assert.equal(shouldCleanLegacyOpencodeEnabled({ workspaceFolderValue: false }), false);
  assert.equal(
    shouldCleanLegacyOpencodeEnabled({ workspaceValue: true, workspaceFolderValue: false }),
    false
  );
});

const GLOBAL_TARGET = 1;

function fakeConfiguration(initial: {
  globalValue?: boolean;
  workspaceValue?: boolean;
  workspaceFolderValue?: boolean;
}) {
  let state = { ...initial };
  const calls: { section: string; value: unknown; target: unknown }[] = [];
  return {
    calls,
    configuration: {
      inspect(section: string) {
        assert.equal(section, LEGACY_OPENCODE_ENABLED_KEY);
        return state;
      },
      async update(section: string, value: undefined, target: unknown) {
        calls.push({ section, value, target });
        state = { ...state, globalValue: undefined };
      }
    }
  };
}

test('the host cleanup inspects the unregistered key and updates only the global target', async () => {
  const { calls, configuration } = fakeConfiguration({ globalValue: false, workspaceValue: true });
  assert.equal(await cleanLegacyOpencodeEnabled(configuration, GLOBAL_TARGET), true);
  assert.deepEqual(calls, [
    { section: LEGACY_OPENCODE_ENABLED_KEY, value: undefined, target: GLOBAL_TARGET }
  ]);
});

test('the host cleanup is idempotent and leaves workspace/folder values alone', async () => {
  const global = fakeConfiguration({ globalValue: true });
  assert.equal(await cleanLegacyOpencodeEnabled(global.configuration, GLOBAL_TARGET), true);
  assert.equal(await cleanLegacyOpencodeEnabled(global.configuration, GLOBAL_TARGET), false);
  assert.equal(global.calls.length, 1);

  const workspace = fakeConfiguration({ workspaceValue: true });
  assert.equal(await cleanLegacyOpencodeEnabled(workspace.configuration, GLOBAL_TARGET), false);
  const folder = fakeConfiguration({ workspaceFolderValue: false });
  assert.equal(await cleanLegacyOpencodeEnabled(folder.configuration, GLOBAL_TARGET), false);
  assert.deepEqual(workspace.calls, []);
  assert.deepEqual(folder.calls, []);
});

