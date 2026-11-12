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

test('the UI thinking vocabulary names every provider tier in presentation order', () => {
  assert.deepEqual(
    [...THINKING_LEVELS],
    ['off', 'on', 'minimal', 'low', 'medium', 'high', 'extra high', 'max', 'ultra']
  );
  for (const level of THINKING_LEVELS) {
    assert.equal(isThinkingLevel(level), true);
  }
  assert.equal(isThinkingLevel('xhigh'), false);
  assert.equal(isThinkingLevel(undefined), false);
  assert.equal(thinkingLevelRank('off'), 0);
  assert.equal(thinkingLevelRank('extra high'), 6);
  assert.equal(thinkingLevelRank('ultra'), 8);
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

test('a level is supported only when the provider reports it', () => {
  assert.equal(supportsThinkingLevel('off', ['off', 'low', 'high']), true);
  assert.equal(supportsThinkingLevel('off', ['low', 'high']), false);
  assert.equal(supportsThinkingLevel('on', ['off', 'on']), true);
  assert.equal(supportsThinkingLevel('high', ['low', 'high']), true);
  assert.equal(supportsThinkingLevel('medium', ['low', 'high']), false);
  // An unknown support set means nothing can be asserted about it.
  assert.equal(supportsThinkingLevel('off', 'unknown'), false);
});

test('unknown is not the same as unsupported', () => {
  // A model known not to reason reports an empty list and has no level to set.
  const nonReasoning = resolveModelSettings({
    providerId: 'ollama',
    modelId: 'm',
    capabilities: caps({ thinking: { supported: [], default: 'unknown' } })
  });
  assert.equal(nonReasoning.thinking, 'unknown');
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
  // No provider default and no app default: the lowest active effort, never a
  // silent switch to off.
  const fallback = resolveModelSettings({ providerId: 'ollama', modelId: 'm', capabilities });
  assert.equal(fallback.thinking, 'low');
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

test('the UI vocabulary maps to Ollama native values, with the top tiers aliasing max', () => {
  assert.equal(ollamaThinkValue('off'), false);
  assert.equal(ollamaThinkValue('on'), true);
  assert.equal(ollamaThinkValue('minimal'), 'minimal');
  assert.equal(ollamaThinkValue('low'), 'low');
  assert.equal(ollamaThinkValue('medium'), 'medium');
  assert.equal(ollamaThinkValue('high'), 'high');
  // Ollama's own levels end at `max`; the higher Codex tiers alias onto it.
  assert.equal(ollamaThinkValue('extra high'), 'max');
  assert.equal(ollamaThinkValue('max'), 'max');
  assert.equal(ollamaThinkValue('ultra'), 'max');
  // The mapping round-trips, including the boolean and `max` specials.
  assert.equal(thinkingLevelFromOllama(false), 'off');
  assert.equal(thinkingLevelFromOllama(true), 'on');
  assert.equal(thinkingLevelFromOllama('max'), 'max');
  assert.equal(thinkingLevelFromOllama('high'), 'high');
  assert.equal(thinkingLevelFromOllama('bogus'), undefined);
});

test('the UI vocabulary maps every Codex native tier without collapsing it', () => {
  assert.equal(codexReasoningEffort('off'), 'none');
  assert.equal(codexReasoningEffort('on'), undefined);
  assert.equal(codexReasoningEffort('minimal'), 'minimal');
  assert.equal(codexReasoningEffort('low'), 'low');
  assert.equal(codexReasoningEffort('medium'), 'medium');
  assert.equal(codexReasoningEffort('high'), 'high');
  assert.equal(codexReasoningEffort('extra high'), 'xhigh');
  assert.equal(codexReasoningEffort('max'), 'max');
  assert.equal(codexReasoningEffort('ultra'), 'ultra');
  assert.equal(thinkingLevelFromCodex('xhigh'), 'extra high');
  assert.equal(thinkingLevelFromCodex('max'), 'max');
  assert.equal(thinkingLevelFromCodex('ultra'), 'ultra');
  assert.equal(thinkingLevelFromCodex('minimal'), 'minimal');
  assert.equal(thinkingLevelFromCodex('none'), 'off');
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

test('the Codex request sends none for off and passes every higher tier through', () => {
  assert.deepEqual(codexNativeRequest(undefined), { summary: 'auto' });
  // `off` is only resolved when the model listed `none`, so it is sent as such.
  assert.deepEqual(codexNativeRequest({ thinking: 'off' }), { effort: 'none', summary: 'auto' });
  assert.deepEqual(codexNativeRequest({ thinking: 'high' }), { effort: 'high', summary: 'auto' });
  assert.deepEqual(codexNativeRequest({ thinking: 'extra high' }), { effort: 'xhigh', summary: 'auto' });
  assert.deepEqual(codexNativeRequest({ thinking: 'max' }), { effort: 'max', summary: 'auto' });
  assert.deepEqual(codexNativeRequest({ thinking: 'ultra' }), { effort: 'ultra', summary: 'auto' });
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
    // A thinking-capable model with no reported controls is a boolean toggle.
    thinking: { supported: ['off', 'on'], default: 'unknown' },
    tools: true,
    modes: ['agent']
  });
});

test('Ollama reports exactly the thinking controls its /api/show body names', () => {
  const gptOss = ollamaCapabilities(
    {
      capabilities: ['completion', 'tools', 'thinking'],
      thinking: { values: ['low', 'medium', 'high'], default: 'medium' }
    },
    ['agent']
  );
  assert.deepEqual(gptOss.thinking, {
    supported: ['off', 'low', 'medium', 'high'],
    default: 'medium'
  });

  const toggle = ollamaCapabilities(
    {
      capabilities: ['completion', 'thinking'],
      thinking: { values: [false, true], default: false }
    },
    ['agent']
  );
  assert.deepEqual(toggle.thinking, { supported: ['off', 'on'], default: 'off' });

  // An unknown native value is dropped, never forced onto the ladder.
  const partly = ollamaCapabilities(
    {
      capabilities: ['thinking'],
      thinking: { values: ['low', 'ultra', 'unheard-of'], default: 'ultra' }
    },
    ['agent']
  );
  assert.deepEqual(partly.thinking, { supported: ['off', 'low', 'ultra'], default: 'ultra' });
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
  // A thinking cap with no controls is a boolean toggle, not the full ladder.
  assert.deepEqual(ollamaThinkingLevels(['thinking']), ['off', 'on']);
  // Reported tier values narrow the offered set to exactly those levels.
  assert.deepEqual(ollamaThinkingLevels(['thinking'], { values: ['low', 'high'] }), ['off', 'low', 'high']);
  assert.deepEqual(ollamaThinkingLevels(['thinking'], { values: [false, true] }), ['off', 'on']);
  // A list of only unrecognized spellings is a provider change, not a toggle.
  assert.equal(ollamaThinkingLevels(['thinking'], { values: ['unheard-of'] }), 'unknown');
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
  assert.deepEqual(reasoning.thinking.supported, ['low', 'high']);
  assert.equal(reasoning.thinking.default, 'high');
  assert.equal(reasoning.tools, true);
  assert.deepEqual(reasoning.modes, ['agent', 'plan', 'ask']);

  // A model that reports the full tier list offers the full effort vocabulary,
  // including the higher max/ultra tiers and `none` as off. `on` is a boolean
  // toggle and is not part of Codex's effort ladder.
  assert.deepEqual(
    codexThinkingLevels([
      { reasoningEffort: 'none' },
      { reasoningEffort: 'minimal' },
      { reasoningEffort: 'low' },
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' },
      { reasoningEffort: 'max' },
      { reasoningEffort: 'ultra' }
    ]),
    ['off', 'minimal', 'low', 'medium', 'high', 'extra high', 'max', 'ultra']
  );
  // Without `none`, the model cannot be switched off and off is not offered.
  assert.deepEqual(codexThinkingLevels([{ reasoningEffort: 'low' }]), ['low']);

  // An empty reported list means the model does not reason; absent stays unknown.
  assert.deepEqual(codexThinkingLevels([]), []);
  assert.equal(codexThinkingLevels(undefined), 'unknown');
  // A reported list we cannot place at all stays unknown rather than guessing.
  assert.equal(codexThinkingLevels([{ reasoningEffort: 'unheard-of' }]), 'unknown');
  assert.equal(codexDefaultThinkingLevel(undefined), 'unknown');
  assert.equal(codexDefaultThinkingLevel('xhigh'), 'extra high');
  assert.equal(codexDefaultThinkingLevel('max'), 'max');
  assert.equal(codexDefaultThinkingLevel('minimal'), 'minimal');
});
