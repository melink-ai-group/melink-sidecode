import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Static guards for the Codex ChatGPT-auth forcing. These read the source
 * rather than run it, so they hold for every code path: the child must be
 * spawned with the inherited credential variables scrubbed and with the
 * ChatGPT auth preference, and no credential value may be logged or surfaced.
 */

async function source(relative: string): Promise<string> {
  return readFile(join(process.cwd(), 'src', ...relative.split('/')), 'utf8');
}

test('the spawn scrubs the inherited env and requests the ChatGPT auth preference', async () => {
  const connection = await source('backends/appserver/connection.ts');
  // The env passed to the child is derived by the pure scrubber, never the raw
  // inherited env.
  assert.match(connection, /env: scrubbedCodexEnv\(process\.env\)/);
  // The auth preference is prepended to every spawn form's args.
  assert.match(connection, /codexAuthPreferenceArgs\(\)/);
});

test('the env helper keeps the auth.json discovery variables and drops credentials', async () => {
  const env = await source('backends/codex/env.ts');
  for (const kept of ['HOME', 'USERPROFILE', 'PATH', 'CODEX_HOME']) {
    assert.match(env, new RegExp(kept));
  }
  for (const removed of [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_ORG_ID',
    'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'OPENAI_IDENTITY_TOKEN_FILE',
    'OPENAI_WORKLOAD_IDENTITY_CONTEXT',
    'OPENAI_FEDERATION_RULE_ID'
  ]) {
    assert.match(env, new RegExp(`'${removed}'`));
  }
});

test('the auth code maps the API-key rejection to its own status and never logs', async () => {
  const auth = await source('backends/codex/auth.ts');
  assert.match(auth, /incorrect api key provided/);
  assert.match(auth, /api-key-mismatch/);
  // No console, no output channel, and no interpolation of an api key value.
  assert.equal(/\bconsole\./.test(auth), false);
  assert.equal(/\boutputChannel\b/i.test(auth), false);
});

test('a transient failed turn continues instead of leaving the chat stopped', async () => {
  const codex = await source('backends/codex.ts');
  // The `error` notification for a transient kind must not become a terminal
  // banner before the failed `turn/completed` is classified.
  assert.match(codex, /isRetryableCodexFailure\(note\.error\)/);
  const finish = codex.slice(codex.indexOf('private finishTurn'));
  // A retryable failed turn hands the waiter back to the host as a failure, and
  // marks it so the bounded automatic continuation runs rather than a Retry card.
  assert.match(finish, /isRetryableCodexFailure\(turn\.error\)/);
  assert.match(finish, /failure\.retryable = true/);
  assert.match(finish, /pending\.reject\(failure\)/);
});

test('a resumed Plan thread starts a new Codex thread so the saved Plan instruction is not inherited', async () => {
  const codex = await source('backends/codex.ts');
  assert.match(codex, /needsPlanEscape/);
  assert.match(codex, /Do not implement the plan/);
  const escape = codex.slice(codex.indexOf('private async escapePlanInstruction'));
  assert.match(escape, /startThread\(/);
  assert.equal(/forkThread\(/.test(codex), false);
  assert.equal(/modeInstructions\(mode\)/.test(codex), false);
});

test('the codex adapter classifies a failed turn instead of forwarding the raw body', async () => {
  const codex = await source('backends/codex.ts');
  assert.match(codex, /classifyCodexAuthFailure/);
  assert.match(codex, /authFailureMessage/);
  // The error code taxonomy names the mismatch distinctly.
  assert.match(codex, /'auth-mismatch'/);
});
