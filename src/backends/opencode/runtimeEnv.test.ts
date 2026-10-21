import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEnv, DEFAULT_OPENCODE_API_KEY_ENV } from './runtime.ts';

test('buildEnv defaults the credential to OLLAMA_API_KEY for the Ollama runtime', () => {
  const env = buildEnv({
    executable: 'opencode',
    cwd: '.',
    config: { share: 'disabled' },
    modelRef: 'melink-ollama-cloud/m',
    agent: 'build',
    prompt: 'hi',
    token: 'secret-token'
  });
  assert.equal(env[DEFAULT_OPENCODE_API_KEY_ENV], 'secret-token');
  assert.equal(env.OLLAMA_API_KEY, 'secret-token');
  // The workspace config is still loaded; the inline generated config wins on
  // overlapping keys, so the child no longer needs a project-config off switch.
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, undefined);
});

test('buildEnv can place the credential under OPENCODE_API_KEY for Zen', () => {
  const env = buildEnv({
    executable: 'opencode',
    cwd: '.',
    config: { share: 'disabled' },
    modelRef: 'melink-opencode-zen/big-pickle',
    agent: 'build',
    prompt: 'hi',
    token: 'zen-secret',
    apiKeyEnv: 'OPENCODE_API_KEY'
  });
  assert.equal(env.OPENCODE_API_KEY, 'zen-secret');
});
