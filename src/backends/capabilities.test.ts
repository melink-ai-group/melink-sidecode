import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNKNOWN_CAPABILITIES,
  clampContextWindow,
  clampThinkingLevel,
  codexCapabilities,
  codexDefaultThinkingLevel,
  codexNativeRequest,
  codexReasoningEffort,
  codexThinkingLevels,
  isKnown,
  isThinkingLevel,
  normalizeContextWindow,
  ollamaCapabilities,
  ollamaNativeRequest,
  ollamaThinkValue,
  ollamaThinkingLevels,
  ollamaToolSupport,
  overridesFromResolved,
  parseOllamaCapabilities,
  parseOllamaContextLength,
  resolveModelSettings,
  sanitizeOverrides,
  supportsThinkingLevel,
  thinkingLevelFromCodex,
  thinkingLevelFromOllama,
  thinkingLevelRank
} from './capabilities.ts';
import { THINKING_LEVELS, type ModelCapabilities, type ThinkingLevel } from './types.ts';

function caps(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return { ...UNKNOWN_CAPABILITIES, ...overrides };
}

test('the UI thinking vocabulary is exactly the documented five levels, in order', () => {
  assert.deepEqual([...THINKING_LEVELS], ['off', 'low', 'medium', 'high', 'extra high']);
  for (const level of THINKING_LEVELS) {
    assert.equal(isThinkingLevel(level), true);
  }
  assert.equal(isThinkingLevel('max'), false);
  assert.equal(isThinkingLevel('minimal'), false);
  assert.equal(isThinkingLevel(undefined), false);
  assert.equal(thinkingLevelRank('off'), 0);
  assert.equal(thinkingLevelRank('extra high'), 4);
  assert.equal(thinkingLevelRank('bogus'), -1);
});

test('a missing context range is unknown, never a fabricated maximum', () => {
  assert.deepEqual(normalizeContextWindow({}), { min: 'unknown', max: 'unknown', default: 'unknown' });
  // A non-positive or non-integer bound is not a real bound.
  assert.deepEqual(normalizeContextWindow({ min: 0, max: -1, default: 1.5 }), {
    min: 'unknown',
    max: 'unknown',
    default: 'unknown'
  });
});

test('a reported context range is normalized and a default outside it is dropped', () => {
  assert.deepEqual(normalizeContextWindow({ min: 512, max: 131072, default: 4096 }), {
    min: 512,
    max: 131072,
    default: 4096
  });
  // A default above the maximum is not the provider's own default any more.
  assert.deepEqual(normalizeContextWindow({ min: 512, max: 1000, default: 2000 }), {
    min: 512,
    max: 1000,
    default: 'unknown'
  });
});

test('an out-of-range persisted context window is clamped on read, never sent raw', () => {
  const range = normalizeContextWindow({ min: 512, max: 8192 });
  assert.equal(clampContextWindow(65536, range), 8192);
  assert.equal(clampContextWindow(128, range), 512);
  assert.equal(clampContextWindow(4096, range), 4096);
  // A non-finite request cannot be clamped; it is dropped.
  assert.equal(clampContextWindow('nope', range), undefined);
  assert.equal(clampContextWindow(Number.NaN, range), undefined);
});

test('with no reported maximum the context window is not guessed at', () => {
  const minOnly = normalizeContextWindow({ min: 512 });
  // No known maximum: only the floor can be enforced, so a large value is kept
  // (it cannot be proven out of range) and a too-small one is raised. No
  // maximum is ever invented.
  assert.equal(clampContextWindow(99999, minOnly), 99999);
  assert.equal(clampContextWindow(128, minOnly), 512);
  // Nothing reported at all: a value cannot be bounded, so it is not sent, since
  // any bound applied would be fabricated.
  const unbounded = normalizeContextWindow({});
  assert.equal(clampContextWindow(99999, unbounded), undefined);
});

test('thinking levels clamp to what the model supports, nearest at or below', () => {
  const supported: ThinkingLevel[] = ['off', 'low', 'high'];
  assert.equal(clampThinkingLevel('high', supported), 'high');
  assert.equal(clampThinkingLevel('medium', supported), 'low');
  assert.equal(clampThinkingLevel('extra high', supported), 'high');
  // A request below everything supported falls to the lowest supported level.
  assert.equal(clampThinkingLevel('off', ['low', 'high']), 'low');
  // Nothing supported to choose from yields nothing sent.
  assert.equal(clampThinkingLevel('high', []), undefined);
  assert.equal(clampThinkingLevel('high', 'unknown'), undefined);
  assert.equal(clampThinkingLevel('bogus', supported), undefined);
});

test('off is meaningful for any reasoning model even if not enumerated', () => {
  assert.equal(supportsThinkingLevel('off', ['low', 'high']), true);
  assert.equal(supportsThinkingLevel('high', ['low', 'high']), true);
  assert.equal(supportsThinkingLevel('medium', ['low', 'high']), false);
  // An unknown support set means nothing can be asserted about it.
  assert.equal(supportsThinkingLevel('off', 'unknown'), false);
});

test('unknown is not the same as unsupported', () => {
  // A model known not to reason reports an empty list, not `unknown`.
  const nonReasoning = resolveModelSettings({
    providerId: 'ollama',
    modelId: 'm',
    capabilities: caps({ thinking: { supported: [], default: 'unknown' } })
  });
  assert.equal(nonReasoning.thinking, 'off');
  assert.equal(nonReasoning.isOverridden, false);

  // A model whose reasoning support was never reported stays unknown.
  const unknown = resolveModelSettings({ providerId: 'ollama', modelId: 'm' });
  assert.equal(unknown.thinking, 'unknown');
  assert.equal(unknown.contextWindow, 'unknown');
  assert.equal(isKnown(unknown.thinking), false);
});

test('a model with no reported capability data yields unknown for every capability', () => {
  const resolved = resolveModelSettings({ providerId: 'codex', modelId: 'gpt-5' });
  assert.deepEqual(resolved.contextWindow, 'unknown');
  assert.deepEqual(resolved.thinking, 'unknown');
  assert.equal(resolved.overridden.thinking, false);
  assert.equal(resolved.overridden.contextWindow, false);
  assert.equal(resolved.isOverridden, false);
});

test('effective settings resolve override > provider default > app default', () => {
  const capabilities = caps({
    contextWindow: { min: 512, max: 8192, default: 4096 },
    thinking: { supported: ['off', 'low', 'medium', 'high', 'extra high'], default: 'medium' }
  });

  // Provider default wins over the app default when there is no override.
  const fromProvider = resolveModelSettings({
    providerId: 'ollama',
    modelId: 'm',
    capabilities,
    appDefaults: { thinking: 'low' }
  });
  assert.equal(fromProvider.thinking, 'medium');
  assert.equal(fromProvider.contextWindow, 4096);
  assert.equal(fromProvider.isOverridden, false);
  assert.equal(fromProvider.overridden.thinking, false);

  // A user override wins over the provider default.
  const fromOverride = resolveModelSettings({
    providerId: 'ollama',
    modelId: 'm',
    capabilities,
    overrides: { thinking: 'high', contextWindow: 2048 }
  });
  assert.equal(fromOverride.thinking, 'high');
  assert.equal(fromOverride.contextWindow, 2048);
  assert.equal(fromOverride.isOverridden, true);
  assert.equal(fromOverride.overridden.thinking, true);
  assert.equal(fromOverride.overridden.contextWindow, true);
});

test('the app default applies only when the provider reports no default', () => {
  const capabilities = caps({
    contextWindow: { min: 512, max: 8192, default: 'unknown' },
    thinking: { supported: ['off', 'low', 'medium'], default: 'unknown' }
  });
  const resolved = resolveModelSettings({
    providerId: 'ollama',
    modelId: 'm',
    capabilities,
    appDefaults: { thinking: 'low' }
  });
  assert.equal(resolved.thinking, 'low');
  assert.equal(resolved.isOverridden, false);
  // No provider default and no app default: the lowest supported effort.
  const fallback = resolveModelSettings({ providerId: 'ollama', modelId: 'm', capabilities });
  assert.equal(fallback.thinking, 'off');
});

test('an override the model cannot support is clamped rather than surfaced raw', () => {
  const capabilities = caps({
    contextWindow: { min: 512, max: 4096, default: 2048 },
    thinking: { supported: ['off', 'low', 'medium'], default: 'low' }
  });
  const resolved = resolveModelSettings({
    providerId: 'ollama',
    modelId: 'm',
    capabilities,
    overrides: { thinking: 'extra high', contextWindow: 65536 }
  });
  assert.equal(resolved.thinking, 'medium');
  assert.equal(resolved.contextWindow, 4096);
  // Still reported as overridden: a stored value was honored, just clamped.
  assert.equal(resolved.isOverridden, true);
});

test('sanitizeOverrides drops what cannot be sent and keeps what can', () => {
  const capabilities = caps({
    contextWindow: { min: 512, max: 4096, default: 2048 },
    thinking: { supported: ['off', 'low'], default: 'low' }
  });
  assert.deepEqual(sanitizeOverrides({ contextWindow: 99999, thinking: 'off' }, capabilities), {
    contextWindow: 4096,
    thinking: 'off'
  });
  // An unsupported level and a context window with no known range are dropped.
  assert.deepEqual(sanitizeOverrides({ thinking: 'extra high', contextWindow: 1000 }), {});
});

test('the UI vocabulary maps to Ollama native values, with extra high aliasing max', () => {
  assert.equal(ollamaThinkValue('off'), false);
  assert.equal(ollamaThinkValue('low'), 'low');
  assert.equal(ollamaThinkValue('medium'), 'medium');
  assert.equal(ollamaThinkValue('high'), 'high');
  // The UI's top level aliases onto Ollama's top tier, which is `max`.
  assert.equal(ollamaThinkValue('extra high'), 'max');
  // The mapping round-trips, including the boolean and `max` specials.
  assert.equal(thinkingLevelFromOllama(false), 'off');
  assert.equal(thinkingLevelFromOllama('max'), 'extra high');
  assert.equal(thinkingLevelFromOllama('high'), 'high');
  assert.equal(thinkingLevelFromOllama('bogus'), undefined);
});

test('the UI vocabulary maps to Codex native tiers, with extra high aliasing the top tier', () => {
  assert.equal(codexReasoningEffort('off'), undefined);
  assert.equal(codexReasoningEffort('low'), 'low');
  assert.equal(codexReasoningEffort('medium'), 'medium');
  assert.equal(codexReasoningEffort('high'), 'high');
  assert.equal(codexReasoningEffort('extra high'), 'xhigh');
  assert.equal(thinkingLevelFromCodex('xhigh'), 'extra high');
  assert.equal(thinkingLevelFromCodex('high'), 'high');
  assert.equal(thinkingLevelFromCodex('bogus'), undefined);
});

test('the Ollama request carries only fields the host resolved', () => {
  assert.deepEqual(ollamaNativeRequest(undefined), {});
  assert.deepEqual(ollamaNativeRequest({ thinking: 'off' }), { think: false });
  assert.deepEqual(ollamaNativeRequest({ contextWindow: 4096 }), { options: { num_ctx: 4096 } });
  assert.deepEqual(ollamaNativeRequest({ thinking: 'extra high', contextWindow: 8192 }), {
    think: 'max',
    options: { num_ctx: 8192 }
  });
});

test('the Codex request omits the effort for off and maps the rest to native tiers', () => {
  assert.deepEqual(codexNativeRequest(undefined), { summary: 'auto' });
  // `off` is the absence of a tier: nothing is sent, so the model default holds.
  assert.deepEqual(codexNativeRequest({ thinking: 'off' }), { summary: 'auto' });
  assert.deepEqual(codexNativeRequest({ thinking: 'high' }), { effort: 'high', summary: 'auto' });
  assert.deepEqual(codexNativeRequest({ thinking: 'extra high' }), { effort: 'xhigh', summary: 'auto' });
});

test('overridesFromResolved drops unknown values so the adapter leaves the field alone', () => {
  const unknown = resolveModelSettings({ providerId: 'ollama', modelId: 'm' });
  assert.deepEqual(overridesFromResolved(unknown), {});
  const known = resolveModelSettings({
    providerId: 'ollama',
    modelId: 'm',
    capabilities: caps({
      contextWindow: { min: 512, max: 8192, default: 4096 },
      thinking: { supported: ['off', 'low', 'high'], default: 'low' }
    })
  });
  assert.deepEqual(overridesFromResolved(known), { contextWindow: 4096, thinking: 'low' });
});

test('Ollama context length is read from a namespaced model_info key, never fabricated', () => {
  assert.equal(parseOllamaContextLength({ 'llama.context_length': 131072 }), 131072);
  assert.equal(parseOllamaContextLength({ 'qwen2.context_length': 32768 }), 32768);
  // Malformed or absent data yields nothing; no maximum is invented.
  assert.equal(parseOllamaContextLength({ 'llama.context_length': 0 }), undefined);
  assert.equal(parseOllamaContextLength({ 'llama.context_length': -1 }), undefined);
  assert.equal(parseOllamaContextLength({ other: 4096 }), undefined);
  assert.equal(parseOllamaContextLength(undefined), undefined);
  assert.equal(parseOllamaContextLength(null), undefined);
});

test('Ollama capabilities build the descriptor from a live /api/show body', () => {
  const show = {
    model_info: { 'llama.context_length': 131072 },
    capabilities: ['completion', 'tools', 'thinking']
  };
  assert.deepEqual(parseOllamaCapabilities(show), ['completion', 'tools', 'thinking']);
  const descriptor = ollamaCapabilities(show, ['agent']);
  assert.deepEqual(descriptor, {
    inputModalities: ['text'],
    contextWindow: { min: 'unknown', max: 131072, default: 131072 },
    thinking: { supported: [...THINKING_LEVELS], default: 'unknown' },
    tools: true,
    modes: ['agent']
  });
});

test('an Ollama model with no reported capability data yields unknown, not defaults', () => {
  const descriptor = ollamaCapabilities({}, ['agent']);
  assert.deepEqual(descriptor.contextWindow, { min: 'unknown', max: 'unknown', default: 'unknown' });
  assert.deepEqual(descriptor.thinking, { supported: 'unknown', default: 'unknown' });
  assert.equal(descriptor.tools, 'unknown');
});

test('a reported capabilities list without thinking means "does not reason", not unknown', () => {
  const descriptor = ollamaCapabilities({ capabilities: ['completion'] }, ['agent']);
  assert.deepEqual(descriptor.thinking.supported, []);
  assert.equal(descriptor.tools, false);
});

test('Ollama capability helpers distinguish a reported list from no list at all', () => {
  // No list: the provider said nothing, so every capability stays unknown.
  assert.equal(ollamaThinkingLevels(undefined), 'unknown');
  assert.equal(ollamaToolSupport(undefined), 'unknown');
  // A reported list with `thinking`/`tools` means the model supports them.
  assert.deepEqual(ollamaThinkingLevels(['thinking']), [...THINKING_LEVELS]);
  assert.equal(ollamaToolSupport(['tools']), true);
  // A reported list without them means the model is known not to support them.
  assert.deepEqual(ollamaThinkingLevels(['completion']), []);
  assert.equal(ollamaToolSupport(['completion']), false);
});

test('Codex reasoning tiers come from the generated model fields, not a hardcoded list', () => {
  // The offered set follows the provider's own reported tiers, mapped onto the
  // UI ladder in presentation order: a model reporting low/high offers low/high.
  const reasoning = codexCapabilities(
    { supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'high' },
    ['agent', 'plan', 'ask']
  );
  assert.deepEqual(reasoning.thinking.supported, ['off', 'low', 'high']);
  assert.equal(reasoning.thinking.default, 'high');
  assert.equal(reasoning.tools, true);
  assert.deepEqual(reasoning.modes, ['agent', 'plan', 'ask']);

  // A model that reports the full tier list offers the full UI vocabulary.
  assert.deepEqual(
    codexThinkingLevels([
      { reasoningEffort: 'minimal' },
      { reasoningEffort: 'low' },
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' }
    ]),
    [...THINKING_LEVELS]
  );

  // An empty reported list means the model does not reason; absent stays unknown.
  assert.deepEqual(codexThinkingLevels([]), []);
  assert.equal(codexThinkingLevels(undefined), 'unknown');
  // A reported list we cannot place at all stays unknown rather than guessing.
  assert.equal(codexThinkingLevels([{ reasoningEffort: 'unheard-of' }]), 'unknown');
  assert.equal(codexDefaultThinkingLevel(undefined), 'unknown');
  assert.equal(codexDefaultThinkingLevel('xhigh'), 'extra high');
  assert.equal(codexDefaultThinkingLevel('minimal'), 'low');
});
