import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isFreeByIdFallback,
  isFreeCost,
  mergeZenCatalog,
  parseModelsDevOpencode,
  parseZenModelsResponse,
  shouldOmitZenModelId
} from './zenCatalog.ts';

test('free cost requires both input and output to be zero', () => {
  assert.equal(isFreeCost({ input: 0, output: 0 }), true);
  assert.equal(isFreeCost({ input: 0, output: 1 }), false);
  assert.equal(isFreeCost({ input: 1, output: 0 }), false);
  assert.equal(isFreeCost(undefined), false);
});

test('id fallback treats -free and known stealth ids as free', () => {
  assert.equal(isFreeByIdFallback('mimo-v2.5-free'), true);
  assert.equal(isFreeByIdFallback('big-pickle'), true);
  assert.equal(isFreeByIdFallback('gpt-5.5'), false);
  assert.equal(isFreeByIdFallback('test'), false);
});

test('jev and test ids are omitted from the coding picker', () => {
  assert.equal(shouldOmitZenModelId('test'), true);
  assert.equal(shouldOmitZenModelId('jev-1.13-free'), true);
  assert.equal(shouldOmitZenModelId('big-pickle'), false);
});

test('parseZenModelsResponse reads OpenAI-style data ids', () => {
  assert.deepEqual(
    parseZenModelsResponse({
      object: 'list',
      data: [{ id: 'big-pickle' }, { id: 'gpt-5.5' }, { id: 'test' }]
    }),
    ['big-pickle', 'gpt-5.5', 'test']
  );
});

test('parseModelsDevOpencode reads cost and name from the opencode provider', () => {
  const meta = parseModelsDevOpencode({
    opencode: {
      models: {
        'big-pickle': { name: 'Big Pickle', cost: { input: 0, output: 0 }, tool_call: true },
        'gpt-5.5': { name: 'GPT 5.5', cost: { input: 1.25, output: 10 }, reasoning: true }
      }
    }
  });
  assert.equal(meta['big-pickle']?.name, 'Big Pickle');
  assert.equal(isFreeCost(meta['big-pickle']?.cost), true);
  assert.equal(isFreeCost(meta['gpt-5.5']?.cost), false);
});

test('mergeZenCatalog marks free models and hides paid when includePaid is false', () => {
  const freeOnly = mergeZenCatalog(
    ['big-pickle', 'gpt-5.5', 'test', 'jev-1.13-free', 'mimo-v2.5-free'],
    {
      'big-pickle': { name: 'Big Pickle', cost: { input: 0, output: 0 } },
      'gpt-5.5': { name: 'GPT 5.5', cost: { input: 1, output: 2 } }
    },
    { includePaid: false }
  );
  assert.deepEqual(
    freeOnly.map((model) => model.id),
    ['big-pickle', 'mimo-v2.5-free']
  );
  assert.equal(freeOnly.every((model) => model.free === true), true);

  const withPaid = mergeZenCatalog(
    ['big-pickle', 'gpt-5.5'],
    {
      'big-pickle': { name: 'Big Pickle', cost: { input: 0, output: 0 } },
      'gpt-5.5': { name: 'GPT 5.5', cost: { input: 1, output: 2 } }
    },
    { includePaid: true }
  );
  assert.deepEqual(
    withPaid.map((model) => ({ id: model.id, free: model.free })),
    [
      { id: 'big-pickle', free: true },
      { id: 'gpt-5.5', free: undefined }
    ]
  );
});
