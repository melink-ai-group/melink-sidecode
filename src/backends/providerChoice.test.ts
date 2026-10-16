import test from 'node:test';
import assert from 'node:assert/strict';
import { backendForTurn } from './providerChoice.ts';

test('an Ollama model pick wins over a Codex thread left behind by a failed switch', () => {
  assert.equal(
    backendForTurn({
      requestedBackendId: 'codex',
      requestedModel: 'gpt-oss:120b',
      composerBackendId: 'ollama',
      composerModelId: 'gpt-oss:120b',
      threadBackendId: 'codex'
    }),
    'ollama'
  );
});

test('a send with no model still follows the requested provider', () => {
  assert.equal(
    backendForTurn({
      requestedBackendId: 'codex',
      composerBackendId: 'ollama',
      composerModelId: 'gpt-oss:120b',
      threadBackendId: 'ollama'
    }),
    'codex'
  );
});
