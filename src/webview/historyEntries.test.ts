import test from 'node:test';
import assert from 'node:assert/strict';
import { historyEntries, historyLoading } from './historyEntries.ts';

test('history lists every provider, newest first, not the selected one', () => {
  const entries = historyEntries(
    [
      { id: 'ollama', label: 'Ollama' },
      { id: 'codex', label: 'Codex' }
    ],
    {
      ollama: [{ threadId: 'old', title: 'Earlier', updatedAt: 10 }],
      codex: [{ threadId: 'new', title: 'Later', model: 'gpt-5', updatedAt: 20 }]
    }
  );
  assert.deepEqual(
    entries.map((entry) => entry.threadId),
    ['new', 'old']
  );
  assert.equal(entries[0]?.backendLabel, 'Codex');
  assert.equal(entries[1]?.backendLabel, 'Ollama');
});

test('a provider that is no longer listed still contributes its loaded threads', () => {
  const entries = historyEntries([{ id: 'ollama', label: 'Ollama' }], {
    ollama: [],
    codex: [{ threadId: 'kept', title: 'From Codex', updatedAt: 5 }]
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.backendId, 'codex');
  assert.equal(entries[0]?.threadId, 'kept');
});

test('history stays loading until every requested provider has answered', () => {
  const providers = [{ id: 'ollama' }, { id: 'codex' }];
  assert.equal(historyLoading(providers, { ollama: false, codex: true }), true);
  assert.equal(historyLoading(providers, { ollama: false, codex: false }), false);
});
