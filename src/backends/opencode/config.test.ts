import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENCODE_API_KEY_ENV,
  OPENCODE_ASK_AGENT,
  OPENCODE_PROVIDER_ID,
  buildOpencodeConfig,
  opencodeAgentForMode,
  opencodeBaseUrl,
  opencodePermission,
  opencodeReasoningEffort,
  opencodeRequiresApproval
} from './config.ts';
import { UNKNOWN_CAPABILITIES } from '../capabilities.ts';
import { THINKING_LEVELS, type ModelCapabilities } from '../types.ts';

function caps(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return { ...UNKNOWN_CAPABILITIES, ...overrides };
}

test('the OpenAI-compatible base URL is derived from the configured base URL', () => {
  // The direct adapter uses the native `/api`; opencode's adapter uses `/v1`.
  assert.equal(opencodeBaseUrl('https://ollama.com'), 'https://ollama.com/v1');
  assert.equal(opencodeBaseUrl('https://ollama.com/'), 'https://ollama.com/v1');
  assert.equal(opencodeBaseUrl('https://ollama.com/api'), 'https://ollama.com/v1');
  // An endpoint that already names /v1 is left alone, so a custom proxy works.
  assert.equal(opencodeBaseUrl('https://proxy.example.com/v1'), 'https://proxy.example.com/v1');
  assert.equal(opencodeBaseUrl('http://localhost:11434'), 'http://localhost:11434/v1');
});

test('the UI thinking ladder maps onto OpenAI-compatible reasoning efforts', () => {
  assert.equal(opencodeReasoningEffort('off'), undefined);
  assert.equal(opencodeReasoningEffort('low'), 'low');
  assert.equal(opencodeReasoningEffort('medium'), 'medium');
  assert.equal(opencodeReasoningEffort('high'), 'high');
  // The top UI level aliases onto the adapter's highest tier, not a new value.
  assert.equal(opencodeReasoningEffort('extra high'), 'high');
});

test('modes map onto opencode primitives: build for agent and plan, and a read-only ask agent', () => {
  assert.equal(opencodeAgentForMode('agent'), 'build');
  assert.equal(opencodeAgentForMode('plan'), 'build');
  assert.equal(opencodeAgentForMode('ask'), OPENCODE_ASK_AGENT);
});

test('ask denies edit/write/patch/bash whatever level was picked', () => {
  for (const level of ['unrestricted', 'default', 'read-only'] as const) {
    assert.deepEqual(opencodePermission(level, 'ask'), {
      edit: 'deny',
      write: 'deny',
      patch: 'deny',
      bash: 'deny'
    });
  }
});

test('read-only and default levels never auto-approve edits or commands', () => {
  // Read-only denies outright.
  assert.deepEqual(opencodePermission('read-only', 'agent'), {
    edit: 'deny',
    write: 'deny',
    patch: 'deny',
    bash: 'deny'
  });
  // Default asks for every edit and command; it never sends `allow`.
  // Only `unrestricted` allows.
  const standard = opencodePermission('default', 'agent');
  assert.equal(standard.edit, 'ask');
  assert.equal(standard.bash, 'ask');
  assert.equal(Object.values(standard).includes('allow'), false);
  // Only unrestricted removes the guard — and the UI gates it behind a labelled
  // confirmation before this value can be selected.
  const unrestricted = opencodePermission('unrestricted', 'agent');
  assert.equal(unrestricted.edit, 'allow');
  assert.equal(unrestricted.bash, 'allow');
  assert.equal(opencodeRequiresApproval('default', 'agent'), true);
  assert.equal(opencodeRequiresApproval('default', 'plan'), true);
  assert.equal(opencodeRequiresApproval('read-only', 'agent'), false);
  assert.equal(opencodeRequiresApproval('unrestricted', 'agent'), false);
  assert.equal(opencodeRequiresApproval('unrestricted', 'ask'), false);
});

test('the generated config points at the configured base URL and the live model ids', () => {
  const modelIds = ['deepseek-v4.1-flash', 'qwen3:8b', 'tomng/nanbeige4.1'];
  const built = buildOpencodeConfig({
    baseUrl: 'https://ollama.com',
    modelIds,
    modelId: 'tomng/nanbeige4.1',
    mode: 'agent',
    permissionLevel: 'default'
  });
  const provider = (built.config.provider as Record<string, Record<string, unknown>>)[OPENCODE_PROVIDER_ID];
  const options = provider.options as Record<string, unknown>;
  assert.equal(options.baseURL, 'https://ollama.com/v1');
  // No model id is rewritten and no list is hardcoded: every live id appears.
  assert.deepEqual(Object.keys(provider.models as Record<string, unknown>).sort(), [...modelIds].sort());
  assert.equal(built.modelRef, `${OPENCODE_PROVIDER_ID}/tomng/nanbeige4.1`);
  assert.equal(built.agent, 'build');
});

test('the provider id is namespaced so a user opencode auth entry cannot override our token', () => {
  // A plain `ollama` id would let an `opencode auth login` entry override the
  // SecretStorage token we supply through the environment.
  assert.notEqual(OPENCODE_PROVIDER_ID, 'ollama');
  const built = buildOpencodeConfig({
    baseUrl: 'https://ollama.com',
    modelIds: ['m'],
    modelId: 'm',
    mode: 'agent',
    permissionLevel: 'default'
  });
  assert.deepEqual(Object.keys(built.config.provider as Record<string, unknown>), [OPENCODE_PROVIDER_ID]);
});

test('the config names the credential env var and never carries the token value', () => {
  const built = buildOpencodeConfig({
    baseUrl: 'https://ollama.com',
    modelIds: ['m'],
    modelId: 'm',
    mode: 'agent',
    permissionLevel: 'default'
  });
  const provider = (built.config.provider as Record<string, Record<string, unknown>>)[OPENCODE_PROVIDER_ID];
  // Only the variable name appears; opencode reads its value from the child env.
  assert.deepEqual(provider.env, [OPENCODE_API_KEY_ENV]);
  assert.equal((provider.options as Record<string, unknown>).apiKey, undefined);
  const serialized = JSON.stringify(built.config);
  assert.equal(serialized.includes('{env:'), false);
  assert.equal(serialized.includes(OPENCODE_API_KEY_ENV), true);
});

test('max context arrives as the model limit and reasoning as a model option', () => {
  const built = buildOpencodeConfig({
    baseUrl: 'https://ollama.com',
    modelIds: ['m'],
    modelId: 'm',
    settings: { contextWindow: 65536, thinking: 'high' },
    capabilities: caps({
      contextWindow: { min: 'unknown', max: 131072, default: 131072 },
      thinking: { supported: [...THINKING_LEVELS], default: 'medium' }
    }),
    mode: 'agent',
    permissionLevel: 'default'
  });
  const provider = (built.config.provider as Record<string, Record<string, unknown>>)[OPENCODE_PROVIDER_ID];
  const model = (provider.models as Record<string, Record<string, unknown>>).m;
  assert.deepEqual(model.limit, { context: 65536 });
  assert.deepEqual(model.options, { reasoningEffort: 'high' });
  assert.equal(built.contextApplied, 65536);
  assert.equal(built.reasoningApplied, 'high');
  assert.equal(built.reasoningUnsupported, false);
});

test('a model with no reasoning control omits the key and reports unsupported', () => {
  const built = buildOpencodeConfig({
    baseUrl: 'https://ollama.com',
    modelIds: ['m'],
    modelId: 'm',
    settings: { thinking: 'high' },
    capabilities: caps({ thinking: { supported: [], default: 'unknown' } }),
    mode: 'agent',
    permissionLevel: 'default'
  });
  const provider = (built.config.provider as Record<string, Record<string, unknown>>)[OPENCODE_PROVIDER_ID];
  const model = (provider.models as Record<string, Record<string, unknown>>).m;
  assert.equal(model.options, undefined);
  assert.equal(built.reasoningApplied, undefined);
  assert.equal(built.reasoningUnsupported, true);
});

test('an unknown reasoning capability never sends a value and never claims unsupported', () => {
  const built = buildOpencodeConfig({
    baseUrl: 'https://ollama.com',
    modelIds: ['m'],
    modelId: 'm',
    settings: { thinking: 'high' },
    capabilities: caps(),
    mode: 'agent',
    permissionLevel: 'default'
  });
  assert.equal(built.reasoningApplied, undefined);
  assert.equal(built.reasoningUnsupported, false);
});

test('ask mode defines a read-only agent and plan mode follows the selected permission', () => {
  const ask = buildOpencodeConfig({
    baseUrl: 'https://ollama.com',
    modelIds: ['m'],
    modelId: 'm',
    mode: 'ask',
    permissionLevel: 'unrestricted'
  });
  assert.equal(ask.agent, OPENCODE_ASK_AGENT);
  const agent = (ask.config.agent as Record<string, Record<string, unknown>>)[OPENCODE_ASK_AGENT];
  assert.deepEqual(agent.tools, { write: false, edit: false, patch: false, bash: false });
  assert.deepEqual(ask.config.permission, { edit: 'deny', write: 'deny', patch: 'deny', bash: 'deny' });

  const plan = buildOpencodeConfig({
    baseUrl: 'https://ollama.com',
    modelIds: ['m'],
    modelId: 'm',
    mode: 'plan',
    permissionLevel: 'default'
  });
  assert.equal(plan.agent, 'build');
  assert.deepEqual(plan.config.permission, { edit: 'ask', write: 'ask', patch: 'ask', bash: 'ask' });

  const writablePlan = buildOpencodeConfig({
    baseUrl: 'https://ollama.com',
    modelIds: ['m'],
    modelId: 'm',
    mode: 'plan',
    permissionLevel: 'unrestricted'
  });
  assert.deepEqual(writablePlan.config.permission, {
    edit: 'allow', write: 'allow', patch: 'allow', bash: 'allow', external_directory: 'allow'
  });
});

test('the generated config disables sharing and autoupdate so a turn has no side effects', () => {
  const built = buildOpencodeConfig({
    baseUrl: 'https://ollama.com',
    modelIds: ['m'],
    modelId: 'm',
    mode: 'agent',
    permissionLevel: 'default'
  });
  assert.equal(built.config.share, 'disabled');
  assert.equal(built.config.autoupdate, false);
  assert.equal(built.config.small_model, `${OPENCODE_PROVIDER_ID}/m`);
});
