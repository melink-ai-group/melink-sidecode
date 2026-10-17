import test from 'node:test';
import assert from 'node:assert/strict';
import { buildZenOpencodeConfig, ZEN_API_KEY_ENV, ZEN_PROVIDER_ID } from './zenConfig.ts';

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

test('Zen Ask mode defines the read-only agent', () => {
  const built = buildZenOpencodeConfig({
    modelIds: ['big-pickle'],
    modelId: 'big-pickle',
    mode: 'ask',
    permissionLevel: 'default'
  });
  assert.equal(built.agent, 'melink-ask');
  assert.ok(built.config.agent);
});
