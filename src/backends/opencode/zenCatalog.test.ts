import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODELS_DEV_URL,
  ZEN_MODELS_URL,
  fetchZenCatalog,
  isFreeByIdFallback,
  isFreeCost,
  mergeZenCatalog,
  parseModelsDevOpencode,
  parseZenModelsResponse,
  shouldOmitZenModelId
} from './zenCatalog.ts';
import { ProviderTimeoutError } from '../probeTimeout.ts';

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

test('a never-resolving catalog fetch rejects with a provider timeout, not an empty catalog', async () => {
  const never: typeof fetch = () => new Promise<Response>(() => {});
  const started = Date.now();
  const guard = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(fetchZenCatalog({ includePaid: true }, never, 20), (error: unknown) => {
      assert.ok(error instanceof ProviderTimeoutError);
      assert.match(error.message, /OpenCode Zen probe timed out after 0\.02s/);
      return true;
    });
  } finally {
    clearTimeout(guard);
  }
  assert.ok(Date.now() - started < 1000);
});

test('a Zen response body that never settles rejects with a provider timeout', async () => {
  const stub: typeof fetch = async () =>
    ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => new Promise(() => {})
    }) as unknown as Response;
  const started = Date.now();
  const guard = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(fetchZenCatalog({ includePaid: true }, stub, 20), (error: unknown) => {
      assert.ok(error instanceof ProviderTimeoutError);
      assert.match(error.message, /OpenCode Zen probe timed out after 0\.02s/);
      return true;
    });
  } finally {
    clearTimeout(guard);
  }
  assert.ok(Date.now() - started < 1000);
});

test('non-timeout catalog failures still degrade to an empty catalog', async () => {
  const rejected = await fetchZenCatalog({ includePaid: true }, async () => new Response('', { status: 401 }), 20);
  assert.deepEqual(rejected, []);

  const offline = await fetchZenCatalog(
    { includePaid: true },
    async () => {
      throw new TypeError('fetch failed');
    },
    20
  );
  assert.deepEqual(offline, []);
});

test('both Zen catalog fetches receive an abort signal and merge the live ids', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const stub: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? undefined });
    if (url === ZEN_MODELS_URL) {
      return new Response(JSON.stringify({ data: [{ id: 'big-pickle' }, { id: 'gpt-5.5' }] }), { status: 200 });
    }
    if (url === MODELS_DEV_URL) {
      return new Response(
        JSON.stringify({ opencode: { models: { 'big-pickle': { name: 'Big Pickle', cost: { input: 0, output: 0 } } } } }),
        { status: 200 }
      );
    }
    return new Response('', { status: 404 });
  };
  const models = await fetchZenCatalog({ includePaid: false }, stub, 1000);
  assert.deepEqual(
    models.map((model) => model.id),
    ['big-pickle']
  );
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.init?.signal instanceof AbortSignal);
  }
});
