import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelCapabilities, ResolvedModelSettings } from '../backends/types.ts';
import {
  contextControl,
  dropsEarlierTurns,
  estimateConversationTokens,
  formatContextTokens,
  formatExactTokens,
  modelSettingsView,
  thinkingControl
} from './modelControls.ts';

/** A resolved settings shape with both fields defaulted, for focused assertions. */
function resolved(overrides: Partial<ResolvedModelSettings> = {}): ResolvedModelSettings {
  return {
    providerId: 'ollama',
    modelId: 'qwen',
    contextWindow: 131072,
    thinking: 'medium',
    isOverridden: false,
    overridden: { contextWindow: false, thinking: false },
    ...overrides
  };
}

const REASONING: ModelCapabilities = {
  contextWindow: { min: 8192, max: 262144, default: 131072 },
  thinking: { supported: ['off', 'low', 'medium', 'high', 'extra high'], default: 'medium' },
  tools: true,
  modes: ['agent']
};

test('context values read as k with the exact count available', () => {
  assert.equal(formatContextTokens(131072), '128k');
  assert.equal(formatContextTokens(32768), '32k');
  assert.equal(formatExactTokens(131072), '131,072');
  assert.equal(formatExactTokens(32768), '32,768');
});

test('a max with no reported min still yields a bounded, stepped control', () => {
  const capabilities: ModelCapabilities = {
    ...REASONING,
    contextWindow: { min: 'unknown', max: 8192, default: 'unknown' }
  };
  const control = contextControl(capabilities, resolved({ contextWindow: 8192 }));
  assert.equal(control.available, true);
  assert.equal(control.ceiling, 8192);
  assert.equal(control.reportedMin, undefined);
  assert.ok(control.floor > 0);
  assert.ok(control.value !== undefined && control.value <= 8192);
});

test('an unknown maximum makes the context control unavailable rather than fabricating a bound', () => {
  const capabilities: ModelCapabilities = {
    ...REASONING,
    contextWindow: { min: 'unknown', max: 'unknown', default: 'unknown' }
  };
  const control = contextControl(capabilities, resolved({ contextWindow: 'unknown' }));
  assert.equal(control.available, false);
  assert.match(control.unavailableReason ?? '', /does not report a context window/i);
});

test('only supported thinking levels are offered, in the fixed vocabulary order', () => {
  const capabilities: ModelCapabilities = {
    ...REASONING,
    thinking: { supported: ['off', 'low', 'medium'], default: 'low' }
  };
  const control = thinkingControl(capabilities, resolved({ thinking: 'low' }));
  assert.deepEqual(control.offered, ['off', 'low', 'medium']);
  assert.equal(control.value, 'low');
  assert.equal(control.defaultValue, 'low');
});

test('a model that does not report off never offers it, and higher tiers stay distinct', () => {
  const capabilities: ModelCapabilities = {
    ...REASONING,
    thinking: { supported: ['low', 'medium', 'high', 'extra high', 'max', 'ultra'], default: 'medium' }
  };
  const control = thinkingControl(capabilities, resolved({ thinking: 'medium' }));
  assert.deepEqual(control.offered, ['low', 'medium', 'high', 'extra high', 'max', 'ultra']);
  assert.equal(control.offered.includes('off'), false);
  assert.equal(control.value, 'medium');
});

test('a non-reasoning model explains the unavailability instead of a dead selector', () => {
  const capabilities: ModelCapabilities = {
    ...REASONING,
    thinking: { supported: [], default: 'unknown' }
  };
  const control = thinkingControl(capabilities, resolved({ thinking: 'off' }));
  assert.equal(control.available, false);
  assert.deepEqual(control.offered, []);
  assert.match(control.unavailableReason ?? '', /not a reasoning model/i);
});

test('thinking support that was never reported is unavailable, not treated as unsupported', () => {
  const capabilities: ModelCapabilities = {
    ...REASONING,
    thinking: { supported: 'unknown', default: 'unknown' }
  };
  const control = thinkingControl(capabilities, resolved({ thinking: 'unknown' }));
  assert.equal(control.available, false);
  assert.match(control.unavailableReason ?? '', /does not report thinking support/i);
});

test('per-field override flags drive the panel mark and each control independently', () => {
  const snapshot = {
    providerId: 'ollama',
    modelId: 'qwen',
    capabilities: REASONING,
    settings: resolved({
      contextWindow: 32768,
      thinking: 'medium',
      isOverridden: true,
      overridden: { contextWindow: true, thinking: false }
    })
  };
  const view = modelSettingsView(snapshot);
  assert.equal(view.isOverridden, true);
  assert.equal(view.context.overridden, true);
  assert.equal(view.thinking.overridden, false);
  assert.equal(view.context.value, 32768);
  assert.equal(view.thinking.value, 'medium');
});

test('the conversation estimate warns only when the cap sits below the visible conversation', () => {
  const items = [{ text: 'x'.repeat(4000) }, { text: 'y'.repeat(4000) }];
  const tokens = estimateConversationTokens(items);
  assert.equal(tokens, 2000);
  assert.equal(dropsEarlierTurns(1024, tokens), true);
  assert.equal(dropsEarlierTurns(4096, tokens), false);
  assert.equal(dropsEarlierTurns(undefined, tokens), false);
  assert.equal(dropsEarlierTurns(1024, 0), false);
});
