import test from 'node:test';
import assert from 'node:assert/strict';
import { historyEntries, historyLoading, historyThreadTitle } from './historyEntries.ts';

const MODE =
  'Work in Agent mode. The available modes are Agent (act on the workspace), Plan (investigate and write a plan document, revising it only when the user asks), and Ask (answer questions without acting).';

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

test('a history title is the user message, not the mode instruction', () => {
  assert.equal(historyThreadTitle('Fix the login', MODE), 'Fix the login');
  assert.equal(historyThreadTitle(MODE, 'Fix the login'), 'Fix the login');
  assert.equal(historyThreadTitle(undefined, `${MODE}\n\n<project-context>name: app</project-context>\n\nFix the login`), 'Fix the login');
  assert.equal(historyThreadTitle(MODE, undefined), undefined);
  assert.equal(historyThreadTitle(`${'a'.repeat(80)}`), `${'a'.repeat(60)}...`);
});

test('history stays loading until every requested provider has answered', () => {
  const providers = [{ id: 'ollama' }, { id: 'codex' }];
  assert.equal(historyLoading(providers, { ollama: false, codex: true }), true);
  assert.equal(historyLoading(providers, { ollama: false, codex: false }), false);
});
