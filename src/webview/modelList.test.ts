import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultProviderTab, sortModels } from './modelList.ts';

test('the model picker opens on the provider of the current model', () => {
  assert.equal(defaultProviderTab(['ollama', 'codex'], 'codex'), 'codex');
  assert.equal(defaultProviderTab(['ollama', 'codex'], 'ollama'), 'ollama');
});

test('a missing current provider falls back to the first listed provider', () => {
  assert.equal(defaultProviderTab(['ollama', 'codex'], 'missing'), 'ollama');
  assert.equal(defaultProviderTab(['ollama', 'codex']), 'ollama');
  assert.equal(defaultProviderTab([]), '');
});

test('model order is the same no matter which order a provider returned', () => {
  const alpha = [
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5', label: 'GPT-5' },
    { id: 'codex-mini', label: 'Codex Mini' }
  ];
  const shuffled = [alpha[1], alpha[2], alpha[0]];
  assert.deepEqual(
    sortModels(shuffled).map((model) => model.id),
    sortModels(alpha).map((model) => model.id)
  );
  assert.deepEqual(
    sortModels(shuffled).map((model) => model.id),
    ['codex-mini', 'gpt-5', 'gpt-5.4']
  );
});

test('models that share a label stay ordered by id', () => {
  const models = [
    { id: 'b', label: 'Same' },
    { id: 'a', label: 'Same' }
  ];
  assert.deepEqual(
    sortModels(models).map((model) => model.id),
    ['a', 'b']
  );
  assert.deepEqual(
    sortModels([...models].reverse()).map((model) => model.id),
    ['a', 'b']
  );
});

test('free models sort before paid models with the same label order otherwise', () => {
  const models = [
    { id: 'gpt-5.5', label: 'GPT 5.5' },
    { id: 'big-pickle', label: 'Big Pickle', free: true },
    { id: 'mimo-free', label: 'MiMo Free', free: true }
  ];
  assert.deepEqual(
    sortModels(models).map((model) => model.id),
    ['big-pickle', 'mimo-free', 'gpt-5.5']
  );
});

test('the model picker can open on the OpenCode provider tab', () => {
  assert.equal(defaultProviderTab(['ollama', 'opencode', 'codex'], 'opencode'), 'opencode');
});
