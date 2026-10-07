import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearPinnedModelSettingField,
  clearPinnedModelSettings,
  parseStoredComposer,
  pinModelSettings,
  pinnedModelSettings,
  withPinnedDefaults
} from './composerControls.ts';

test('a chat pins its own model settings and ignores a later shared default', () => {
  const shared = { thinking: 'medium' as const };
  const pinned = withPinnedDefaults({}, 'codex', 'gpt', shared);
  assert.deepEqual(pinnedModelSettings(pinned, 'codex', 'gpt'), { thinking: 'medium' });

  const changed = pinModelSettings(pinned, 'codex', 'gpt', { thinking: 'high' }, { thinking: 'low' });
  assert.deepEqual(pinnedModelSettings(changed, 'codex', 'gpt'), { thinking: 'high' });
  assert.deepEqual(pinnedModelSettings(pinned, 'codex', 'gpt'), { thinking: 'medium' });
});

test('the first settings change copies the shared default before the patch', () => {
  const changed = pinModelSettings({}, 'codex', 'gpt', { thinking: 'high' }, { thinking: 'medium', contextWindow: 8192 });
  assert.deepEqual(pinnedModelSettings(changed, 'codex', 'gpt'), { thinking: 'high', contextWindow: 8192 });
});

test('reset keeps the chat pinned to the model default', () => {
  const pinned = pinModelSettings({}, 'codex', 'gpt', { thinking: 'high' }, {});
  const cleared = clearPinnedModelSettings(pinned, 'codex', 'gpt');
  assert.deepEqual(pinnedModelSettings(cleared, 'codex', 'gpt'), {});
  const field = clearPinnedModelSettingField(
    pinModelSettings({}, 'codex', 'gpt', {}, { thinking: 'high', contextWindow: 4096 }),
    'codex',
    'gpt',
    'thinking',
    {}
  );
  assert.deepEqual(pinnedModelSettings(field, 'codex', 'gpt'), { contextWindow: 4096 });
});

test('saved composer choices drop malformed fields and keep a reset pin', () => {
  assert.deepEqual(
    parseStoredComposer({
      mode: 'plan',
      permissionLevel: 'read-only',
      composerBackendId: 'codex',
      composerModelId: 'gpt-6',
      modelSettings: {
        'codex:gpt-6': { thinking: 'high', contextWindow: 16000 },
        'codex:reset': {},
        'codex:bad': { thinking: 'huge', contextWindow: 'wide' }
      }
    }),
    {
      mode: 'plan',
      permissionLevel: 'read-only',
      composerBackendId: 'codex',
      composerModelId: 'gpt-6',
      modelSettings: {
        'codex:gpt-6': { thinking: 'high', contextWindow: 16000 },
        'codex:reset': {},
        'codex:bad': {}
      }
    }
  );
  assert.deepEqual(parseStoredComposer({ mode: 'nope', permissionLevel: 'root' }), {});
});
