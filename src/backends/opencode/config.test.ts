import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_OPENCODE_API_KEY,
  OPENCODE_AGENT_AGENT,
  OPENCODE_API_KEY_ENV,
  OPENCODE_ASK_AGENT,
  OPENCODE_LOCAL_API_KEY_ENV,
  OPENCODE_LOCAL_PROVIDER_ID,
  OPENCODE_PLAN_AGENT,
  OPENCODE_PROVIDER_ID,
  astGrepReplacePermission,
  buildOpencodeConfig,
  opencodeAgentConfig,
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
  assert.equal(opencodeReasoningEffort('off'), 'none');
  assert.equal(opencodeReasoningEffort('on'), undefined);
  assert.equal(opencodeReasoningEffort('minimal'), 'minimal');
  assert.equal(opencodeReasoningEffort('low'), 'low');
  assert.equal(opencodeReasoningEffort('medium'), 'medium');
  assert.equal(opencodeReasoningEffort('high'), 'high');
  assert.equal(opencodeReasoningEffort('extra high'), 'xhigh');
  assert.equal(opencodeReasoningEffort('max'), 'max');
  assert.equal(opencodeReasoningEffort('ultra'), 'ultra');
});

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

test('modes map onto dedicated, unpredictable custom agent names', () => {
  assert.equal(opencodeAgentForMode('agent', 'fixed'), `${OPENCODE_AGENT_AGENT}-fixed`);
  assert.equal(opencodeAgentForMode('plan', 'fixed'), `${OPENCODE_PLAN_AGENT}-fixed`);
  assert.equal(opencodeAgentForMode('ask', 'fixed'), `${OPENCODE_ASK_AGENT}-fixed`);
  assert.notEqual(OPENCODE_AGENT_AGENT, 'build');
  assert.notEqual(OPENCODE_PLAN_AGENT, 'build');
  // Without an injected nonce each call is a fresh unpredictable name.
  const first = opencodeAgentForMode('agent');
  const second = opencodeAgentForMode('agent');
  assert.match(first, /^melink-agent-[0-9a-f]{16}$/);
  assert.notEqual(first, second);
});

test('every generated agent is explicitly enabled and cannot delegate', () => {
  const permission = opencodePermission('default', 'agent');
  for (const mode of ['agent', 'plan', 'ask'] as const) {
    const definitions = opencodeAgentConfig(mode, permission, 'fixed');
    const names = Object.keys(definitions);
    assert.equal(names.length, 1);
    const agent = definitions[names[0]] as Record<string, unknown>;
    // Inline `disable: false` wins over a workspace `agent.<same name>.disable:
    // true`, so the turn cannot fall back to the workspace's `build` agent.
    assert.equal(agent.disable, false);
    assert.equal((agent.tools as Record<string, unknown>).task, false);
  }
});

test('default auto-allows workspace edits, asks before bash, web access and leaving the project', () => {
  assert.deepEqual(opencodePermission('read-only', 'agent'), FULL_DENY);
  // opencode cannot sandbox a child process or its HTTP tools, so default
  // auto-allows only workspace edits and surfaces everything else as an
  // approval.
  assert.deepEqual(opencodePermission('default', 'agent'), {
    edit: 'allow',
    write: 'allow',
    patch: 'allow',
    bash: 'ask',
    external_directory: 'ask',
    webfetch: 'ask',
    websearch: 'ask',
    task: 'deny'
  });
  assert.equal(opencodePermission('default', 'agent').bash, 'ask');
  assert.equal(opencodePermission('default', 'plan').bash, 'ask');
  assert.equal(opencodePermission('default', 'agent').webfetch, 'ask');
  assert.equal(opencodePermission('default', 'agent').websearch, 'ask');
  assert.deepEqual(opencodePermission('unrestricted', 'agent'), FULL_ALLOW);
  // A workspace-defined subagent must not escape the selected level: only
  // unrestricted may delegate.
  assert.equal(opencodePermission('default', 'agent').task, 'deny');
  assert.equal(opencodePermission('default', 'plan').task, 'deny');
  assert.equal(opencodePermission('read-only', 'agent').task, 'deny');
  assert.equal(opencodePermission('default', 'ask').task, 'deny');
  assert.equal(opencodePermission('unrestricted', 'agent').task, 'allow');
  assert.equal(opencodeRequiresApproval('default', 'agent'), true);
  assert.equal(opencodeRequiresApproval('default', 'plan'), true);
  assert.equal(opencodeRequiresApproval('read-only', 'agent'), false);
  assert.equal(opencodeRequiresApproval('unrestricted', 'agent'), false);
  assert.equal(opencodeRequiresApproval('unrestricted', 'ask'), false);
});

test('ast-grep replace uses the resolved tool name and follows the turn level', () => {
  const build = (level: 'read-only' | 'default' | 'unrestricted', mode: 'agent' | 'plan' | 'ask') =>
    buildOpencodeConfig({
      baseUrl: 'https://ollama.com',
      modelIds: ['m'],
      modelId: 'm',
      mode,
      permissionLevel: level,
      skillMcp: { ast_grep: { type: 'local', command: ['node', 'x.js'], enabled: true } },
      skillPermissions: { ast_grep_search: 'allow' },
      astGrepSkill: true,
      agentNonce: 'fixed'
    }).config.permission as Record<string, unknown>;

  for (const mode of ['agent', 'plan', 'ask'] as const) {
    assert.equal(build('read-only', mode).ast_grep_replace, 'deny', `read-only/${mode}`);
  }
  assert.equal(build('default', 'agent').ast_grep_replace, 'ask');
  assert.equal(build('default', 'plan').ast_grep_replace, 'ask');
  assert.equal(build('default', 'ask').ast_grep_replace, 'deny');
  assert.equal(build('unrestricted', 'agent').ast_grep_replace, 'allow');
  // OpenCode resolves the MCP tool as `<server>_<tool>`; the bare names never
  // matched and let its permissive default apply.
  assert.equal(build('default', 'agent').replace, undefined);
  assert.equal(build('default', 'agent').search, undefined);
  assert.equal(build('default', 'agent').ast_grep_search, 'allow');
  // The bare server key is never emitted: it would cover replace.
  assert.equal(build('default', 'agent').ast_grep, undefined);
  assert.equal(astGrepReplacePermission('default', 'agent'), 'ask');
  assert.equal(astGrepReplacePermission('read-only', 'agent'), 'deny');
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
  assert.match(built.agent, /^melink-agent-[0-9a-f]{16}$/);
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

test('the local provider gets its own id, env var, name, and /v1 base URL', () => {
  const built = buildOpencodeConfig({
    baseUrl: 'http://localhost:11434',
    modelIds: ['qwen2.5-coder:7b'],
    modelId: 'qwen2.5-coder:7b',
    mode: 'agent',
    permissionLevel: 'default',
    providerId: OPENCODE_LOCAL_PROVIDER_ID,
    providerName: 'Ollama Local',
    apiKeyEnv: OPENCODE_LOCAL_API_KEY_ENV
  });
  const provider = (built.config.provider as Record<string, Record<string, unknown>>)[
    OPENCODE_LOCAL_PROVIDER_ID
  ];
  assert.equal(provider.name, 'Ollama Local');
  assert.deepEqual(provider.env, [OPENCODE_LOCAL_API_KEY_ENV]);
  assert.equal((provider.options as Record<string, unknown>).baseURL, 'http://localhost:11434/v1');
  assert.equal(built.modelRef, `${OPENCODE_LOCAL_PROVIDER_ID}/qwen2.5-coder:7b`);
  assert.equal(built.config.small_model, `${OPENCODE_LOCAL_PROVIDER_ID}/qwen2.5-coder:7b`);
  // The Cloud provider entry is not generated as well.
  assert.deepEqual(Object.keys(built.config.provider as Record<string, unknown>), [OPENCODE_LOCAL_PROVIDER_ID]);
  // The placeholder is a runtime env value, never part of the generated config.
  assert.equal(JSON.stringify(built.config).includes(LOCAL_OPENCODE_API_KEY), false);
});

test('the cloud output is unchanged by the optional provider parameters', () => {
  const cloud = buildOpencodeConfig({
    baseUrl: 'https://ollama.com',
    modelIds: ['m'],
    modelId: 'm',
    mode: 'agent',
    permissionLevel: 'default'
  });
  const provider = (cloud.config.provider as Record<string, Record<string, unknown>>)[OPENCODE_PROVIDER_ID];
  assert.equal(provider.name, 'Ollama Cloud');
  assert.deepEqual(provider.env, [OPENCODE_API_KEY_ENV]);
  assert.equal((provider.options as Record<string, unknown>).baseURL, 'https://ollama.com/v1');
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
  assert.deepEqual(model.limit, { context: 65536, output: 32768 });
  assert.deepEqual(model.options, { reasoningEffort: 'high' });
  assert.equal(built.contextApplied, 65536);
  assert.equal(built.reasoningApplied, 'high');
  assert.equal(built.reasoningUnsupported, false);
});

test('output budget follows the selected context window, including a 1024k model', () => {
  const built = buildOpencodeConfig({
    baseUrl: 'https://ollama.com',
    modelIds: ['m'],
    modelId: 'm',
    settings: { contextWindow: 1_048_576 },
    mode: 'agent',
    permissionLevel: 'default'
  });
  const provider = (built.config.provider as Record<string, Record<string, unknown>>)[OPENCODE_PROVIDER_ID];
  const model = (provider.models as Record<string, Record<string, unknown>>).m;
  assert.deepEqual(model.limit, { context: 1_048_576, output: 524_288 });
});

test('a small context window keeps the required output limit inside that window', () => {
  const built = buildOpencodeConfig({
    baseUrl: 'https://ollama.com',
    modelIds: ['m'],
    modelId: 'm',
    settings: { contextWindow: 1000 },
    mode: 'agent',
    permissionLevel: 'default'
  });
  const provider = (built.config.provider as Record<string, Record<string, unknown>>)[OPENCODE_PROVIDER_ID];
  const model = (provider.models as Record<string, Record<string, unknown>>).m;
  assert.deepEqual(model.limit, { context: 1000, output: 500 });
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
  assert.match(ask.agent, /^melink-ask-[0-9a-f]{16}$/);
  const agent = (ask.config.agent as Record<string, Record<string, unknown>>)[ask.agent];
  assert.deepEqual(agent.tools, { write: false, edit: false, patch: false, bash: false, task: false });
  assert.equal(agent.disable, false);
  assert.equal(typeof agent.prompt, 'string');
  assert.ok((agent.prompt as string).length > 0);
  assert.deepEqual(ask.config.permission, FULL_DENY);

  const plan = buildOpencodeConfig({
    baseUrl: 'https://ollama.com',
    modelIds: ['m'],
    modelId: 'm',
    mode: 'plan',
    permissionLevel: 'default'
  });
  assert.match(plan.agent, /^melink-plan-[0-9a-f]{16}$/);
  assert.deepEqual(plan.config.permission, {
    edit: 'allow',
    write: 'allow',
    patch: 'allow',
    bash: 'ask',
    external_directory: 'ask',
    webfetch: 'ask',
    websearch: 'ask',
    task: 'deny'
  });

  const writablePlan = buildOpencodeConfig({
    baseUrl: 'https://ollama.com',
    modelIds: ['m'],
    modelId: 'm',
    mode: 'plan',
    permissionLevel: 'unrestricted'
  });
  assert.deepEqual(writablePlan.config.permission, FULL_ALLOW);
});

test('the generated custom agent carries the computed permission for every mode', () => {
  for (const mode of ['agent', 'plan', 'ask'] as const) {
    for (const level of ['read-only', 'default', 'unrestricted'] as const) {
      const built = buildOpencodeConfig({
        baseUrl: 'https://ollama.com',
        modelIds: ['m'],
        modelId: 'm',
        mode,
        permissionLevel: level
      });
      const agents = built.config.agent as Record<string, Record<string, unknown>>;
      const agent = agents[built.agent];
      assert.deepEqual(Object.keys(agents), [built.agent]);
      assert.equal(agents.build, undefined);
      assert.equal(agent.disable, false);
      assert.equal(typeof agent.prompt, 'string');
      assert.ok((agent.prompt as string).length > 0);
      assert.equal((agent.tools as Record<string, unknown>).task, false);
      assert.deepEqual(agent.permission, built.config.permission);
    }
  }
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
