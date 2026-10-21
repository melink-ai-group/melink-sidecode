import test from 'node:test';
import assert from 'node:assert/strict';
import { buildZenOpencodeConfig, ZEN_API_KEY_ENV, ZEN_PROVIDER_ID } from './zenConfig.ts';
import { OPENCODE_AGENT_AGENT, OPENCODE_PLAN_AGENT } from './config.ts';

const FULL_DENY = {
  edit: 'deny',
  write: 'deny',
  patch: 'deny',
  bash: 'deny',
  external_directory: 'deny',
  webfetch: 'deny',
  websearch: 'deny',
  task: 'deny'
} as const;

const FULL_ALLOW = {
  edit: 'allow',
  write: 'allow',
  patch: 'allow',
  bash: 'allow',
  external_directory: 'allow',
  webfetch: 'allow',
  websearch: 'allow',
  task: 'allow'
} as const;

test('Zen config uses a namespaced provider and OPENCODE_API_KEY env name', () => {
  const built = buildZenOpencodeConfig({
    modelIds: ['big-pickle', 'gpt-5.5'],
    modelId: 'big-pickle',
    mode: 'agent',
    permissionLevel: 'default'
  });
  assert.equal(built.modelRef, `${ZEN_PROVIDER_ID}/big-pickle`);
  const provider = (built.config.provider as Record<string, Record<string, unknown>>)[ZEN_PROVIDER_ID];
  assert.ok(provider);
  assert.deepEqual(provider.env, [ZEN_API_KEY_ENV]);
  assert.equal(ZEN_API_KEY_ENV, 'OPENCODE_API_KEY');
  const serialized = JSON.stringify(built.config);
  assert.equal(serialized.includes('sk-'), false);
  assert.match(serialized, /OPENCODE_API_KEY/);
});

test('Zen default asks before edits, commands, and web access, like the Ollama runtime', () => {
  const expectedAgent = { agent: OPENCODE_AGENT_AGENT, plan: OPENCODE_PLAN_AGENT } as const;
  for (const mode of ['agent', 'plan'] as const) {
    const built = buildZenOpencodeConfig({
      modelIds: ['big-pickle'],
      modelId: 'big-pickle',
      mode,
      permissionLevel: 'default'
    });
    assert.match(built.agent, new RegExp(`^${expectedAgent[mode]}-[0-9a-f]{16}$`));
    assert.deepEqual(built.config.permission, {
      edit: 'ask',
      write: 'ask',
      patch: 'ask',
      bash: 'ask',
      external_directory: 'ask',
      webfetch: 'ask',
      websearch: 'ask',
      task: 'deny'
    });
    const agents = built.config.agent as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(agents), [built.agent]);
    assert.equal(agents[built.agent].disable, false);
    assert.equal((agents[built.agent].tools as Record<string, unknown>).task, false);
    assert.deepEqual(agents[built.agent].permission, built.config.permission);
  }
  const readOnly = buildZenOpencodeConfig({
    modelIds: ['big-pickle'],
    modelId: 'big-pickle',
    mode: 'agent',
    permissionLevel: 'read-only'
  });
  assert.deepEqual(readOnly.config.permission, FULL_DENY);
  const unrestricted = buildZenOpencodeConfig({
    modelIds: ['big-pickle'],
    modelId: 'big-pickle',
    mode: 'agent',
    permissionLevel: 'unrestricted'
  });
  assert.deepEqual(unrestricted.config.permission, FULL_ALLOW);
});

test('Zen Ask mode defines the read-only custom agent', () => {
  const built = buildZenOpencodeConfig({
    modelIds: ['big-pickle'],
    modelId: 'big-pickle',
    mode: 'ask',
    permissionLevel: 'default'
  });
  assert.match(built.agent, /^melink-ask-[0-9a-f]{16}$/);
  const agents = built.config.agent as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(agents), [built.agent]);
  assert.equal((agents[built.agent].tools as Record<string, unknown>).task, false);
  assert.deepEqual(agents[built.agent].permission, FULL_DENY);
});

test('Zen validates the agent nonce once so the config key and built.agent match', () => {
  const trimmed = buildZenOpencodeConfig({
    modelIds: ['big-pickle'],
    modelId: 'big-pickle',
    mode: 'agent',
    permissionLevel: 'default',
    agentNonce: '  fixed  '
  });
  assert.equal(trimmed.agent, 'melink-agent-fixed');
  assert.deepEqual(Object.keys(trimmed.config.agent as Record<string, unknown>), [trimmed.agent]);

  // An invalid nonce is replaced by one fresh random suffix, used for both the
  // config key and the reported agent.
  for (const nonce of ['bad nonce', '', 'a/b']) {
    const built = buildZenOpencodeConfig({
      modelIds: ['big-pickle'],
      modelId: 'big-pickle',
      mode: 'agent',
      permissionLevel: 'default',
      agentNonce: nonce
    });
    assert.match(built.agent, /^melink-agent-[0-9a-f]{16}$/);
    assert.deepEqual(Object.keys(built.config.agent as Record<string, unknown>), [built.agent]);
  }
});
