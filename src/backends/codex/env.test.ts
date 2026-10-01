import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_AUTH_PREFERENCE_ARGS,
  CODEX_CREDENTIAL_ENV_VARS,
  codexAuthPreferenceArgs,
  scrubbedCodexEnv
} from './env.ts';

test('the credential and base-URL variables are removed from the spawn env', () => {
  const env = scrubbedCodexEnv({
    OPENAI_API_KEY: 'sk-svcacct-fake',
    OPENAI_BASE_URL: 'https://example.invalid/v1',
    OPENAI_ORG_ID: 'org-fake',
    OPENAI_ORGANIZATION: 'org-fake',
    CODEX_API_KEY: 'sk-codex-fake',
    CODEX_ACCESS_TOKEN: 'token-fake',
    PATH: '/usr/bin'
  });
  for (const name of CODEX_CREDENTIAL_ENV_VARS) {
    assert.equal(env[name], undefined, `${name} must be removed`);
  }
});

test('the variables Codex needs to find auth.json and run are preserved', () => {
  const env = scrubbedCodexEnv({
    HOME: '/home/user',
    USERPROFILE: 'C:\\Users\\user',
    PATH: '/usr/bin:/bin',
    CODEX_HOME: '/home/user/.codex',
    OPENAI_API_KEY: 'sk-svcacct-fake'
  });
  assert.equal(env.HOME, '/home/user');
  assert.equal(env.USERPROFILE, 'C:\\Users\\user');
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.CODEX_HOME, '/home/user/.codex');
  // A blocked value really is gone while the rest of the env survives.
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test('scrubbing is case-insensitive so a mixed-case key cannot slip through', () => {
  const env = scrubbedCodexEnv({ Openai_Api_Key: 'sk-fake', CODEX_home: '/home/user/.codex' });
  assert.equal(env.Openai_Api_Key, undefined);
  assert.equal(env.CODEX_home, '/home/user/.codex');
});

test('the caller env is not mutated in place', () => {
  const original: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-fake', PATH: '/usr/bin' };
  scrubbedCodexEnv(original);
  assert.equal(original.OPENAI_API_KEY, 'sk-fake');
});

test('the auth preference is a config override naming chatgpt with no credential', () => {
  assert.deepEqual(codexAuthPreferenceArgs(), ['-c', 'forced_login_method="chatgpt"']);
  assert.equal(CODEX_AUTH_PREFERENCE_ARGS.join(' ').includes('sk-'), false);
  // Mutating the returned copy must not affect the shared constant.
  codexAuthPreferenceArgs().push('mutated');
  assert.deepEqual([...CODEX_AUTH_PREFERENCE_ARGS], ['-c', 'forced_login_method="chatgpt"']);
});

test('the config key used is the one the installed CLI accepts', () => {
  // `forced_login_method` is the key the installed 0.156.1 binary parses (with
  // values `chatgpt`/`api`); `preferred_auth_method` does not exist.
  assert.match(CODEX_AUTH_PREFERENCE_ARGS.join(' '), /forced_login_method="chatgpt"/);
  assert.equal(CODEX_AUTH_PREFERENCE_ARGS.join(' ').includes('preferred_auth_method'), false);
});
