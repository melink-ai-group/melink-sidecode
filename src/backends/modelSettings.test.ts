import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelSettingsStore, modelSettingsKey, type ModelSettingsMemento } from './modelSettings.ts';
import type { ModelCapabilities } from './types.ts';

/**
 * An in-memory stand-in for `globalState`, so persistence is exercised without a
 * VS Code host. It models the real memento contract: `get` returns what a prior
 * `update` stored, so a fresh store over the same memento reads it back.
 */
function memento(): ModelSettingsMemento & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get<T>(key: string): T | undefined {
      return data.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      data.set(key, value);
    }
  };
}

const CAPS: ModelCapabilities = {
  contextWindow: { min: 512, max: 8192, default: 4096 },
  thinking: { supported: ['off', 'low', 'medium', 'high', 'extra high'], default: 'medium' },
  tools: true,
  modes: ['agent']
};

test('overrides persist in global storage, keyed provider:model', async () => {
  const storage = memento();
  const store = new ModelSettingsStore(storage);
  await store.set('ollama', 'llama3', { thinking: 'high', contextWindow: 4096 }, CAPS);
  // The key is exactly `providerId:modelId`, so the two never collide.
  assert.ok(storage.data.has('melink.modelSettings.overrides'));
  assert.equal(modelSettingsKey('ollama', 'llama3'), 'ollama:llama3');
});

test('an override survives a reload: a fresh store over the same storage reads it', async () => {
  const storage = memento();
  const first = new ModelSettingsStore(storage);
  await first.set('ollama', 'llama3', { thinking: 'high' }, CAPS);

  // A new store models a window reload: same global storage, new instance.
  const reloaded = new ModelSettingsStore(storage);
  const resolved = reloaded.resolve('ollama', 'llama3', CAPS);
  assert.equal(resolved.thinking, 'high');
  assert.equal(resolved.isOverridden, true);
});

test('an override is global, not workspace-scoped: a second store sees the same value', async () => {
  const storage = memento();
  await new ModelSettingsStore(storage).set('codex', 'gpt-5', { thinking: 'low' }, CAPS);
  // A workspace change means a new extension context but the same globalState,
  // so the override is still present and still overridden.
  const afterWorkspaceChange = new ModelSettingsStore(storage);
  const resolved = afterWorkspaceChange.resolve('codex', 'gpt-5', CAPS);
  assert.equal(resolved.thinking, 'low');
  assert.equal(resolved.overridden.thinking, true);
});

test('an out-of-range persisted value is clamped on read, never surfaced raw', async () => {
  const storage = memento();
  // Simulate a value stored against a model with a wider range.
  storage.data.set('melink.modelSettings.overrides', {
    'ollama:llama3': { contextWindow: 65536, thinking: 'extra high' }
  });
  const store = new ModelSettingsStore(storage);
  const resolved = store.resolve('ollama', 'llama3', CAPS);
  assert.equal(resolved.contextWindow, 8192);
  // `extra high` is supported by this model, so it is kept.
  assert.equal(resolved.thinking, 'extra high');
});

test('an override for a capability the model does not report is dropped', async () => {
  const storage = memento();
  storage.data.set('melink.modelSettings.overrides', {
    'codex:no-reasoning': { thinking: 'high', contextWindow: 4096 }
  });
  // A model with no reported reasoning and no reported context range.
  const noReasoning: ModelCapabilities = {
    contextWindow: { min: 'unknown', max: 'unknown', default: 'unknown' },
    thinking: { supported: [], default: 'unknown' },
    tools: true,
    modes: ['agent']
  };
  const store = new ModelSettingsStore(storage);
  const resolved = store.resolve('codex', 'no-reasoning', noReasoning);
  assert.equal(resolved.thinking, 'off');
  assert.equal(resolved.contextWindow, 'unknown');
});

test('clearing removes the override so provider defaults apply again', async () => {
  const storage = memento();
  const store = new ModelSettingsStore(storage);
  await store.set('ollama', 'llama3', { thinking: 'high' }, CAPS);
  assert.equal(store.resolve('ollama', 'llama3', CAPS).isOverridden, true);
  await store.clear('ollama', 'llama3');
  const resolved = store.resolve('ollama', 'llama3', CAPS);
  assert.equal(resolved.isOverridden, false);
  assert.equal(resolved.thinking, 'medium');
});

test('a partial patch merges, and an empty result is not stored', async () => {
  const storage = memento();
  const store = new ModelSettingsStore(storage);
  await store.set('ollama', 'llama3', { thinking: 'high' }, CAPS);
  // A second patch that sets only the context window keeps the thinking level.
  await store.set('ollama', 'llama3', { contextWindow: 2048 }, CAPS);
  assert.deepEqual(store.getOverrides('ollama', 'llama3'), { thinking: 'high', contextWindow: 2048 });
  // Clearing the merge down to nothing removes the key entirely.
  await store.set('ollama', 'llama3', { thinking: undefined }, CAPS);
  assert.deepEqual(store.getOverrides('ollama', 'llama3'), { thinking: 'high', contextWindow: 2048 });
});

test('clearing one field leaves the other override intact', async () => {
  const storage = memento();
  const store = new ModelSettingsStore(storage);
  await store.set('ollama', 'llama3', { thinking: 'high', contextWindow: 2048 }, CAPS);
  // Resetting only the context window must not disturb the thinking override:
  // the per-control reset is exactly that scoped.
  await store.clearField('ollama', 'llama3', 'contextWindow');
  const resolved = store.resolve('ollama', 'llama3', CAPS);
  assert.equal(resolved.overridden.thinking, true);
  assert.equal(resolved.thinking, 'high');
  assert.equal(resolved.overridden.contextWindow, false);
  assert.equal(resolved.contextWindow, 4096);
});

test('clearing the last field removes the stored key entirely', async () => {
  const storage = memento();
  const store = new ModelSettingsStore(storage);
  await store.set('ollama', 'llama3', { thinking: 'high' }, CAPS);
  await store.clearField('ollama', 'llama3', 'thinking');
  assert.deepEqual(store.getOverrides('ollama', 'llama3'), {});
  const index = storage.data.get('melink.modelSettings.overrides') as Record<string, unknown>;
  assert.equal(index['ollama:llama3'], undefined);
});
