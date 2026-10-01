import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canCompactContext,
  codexContextUsed,
  contextUsagePercent,
  ollamaContextUsed,
  resolveContextMax,
  tokensFromText
} from './contextUsage.ts';

test('the percent uses the resolved max and caps at 100', () => {
  assert.equal(contextUsagePercent(2500, 10000), 25);
  assert.equal(contextUsagePercent(2600, 10000), 26);
  assert.equal(contextUsagePercent(50000, 10000), 100);
  assert.equal(contextUsagePercent(10, 0), undefined);
  assert.equal(contextUsagePercent(10, undefined), undefined);
});

test('compaction is offered only above 25 percent while the agent is idle', () => {
  assert.equal(canCompactContext(25, false), false);
  assert.equal(canCompactContext(26, false), true);
  assert.equal(canCompactContext(80, true), false);
  assert.equal(canCompactContext(undefined, false), false);
});

test('the resolved context setting wins over the model ceiling and a live window', () => {
  assert.equal(
    resolveContextMax({
      settingsWindow: 32768,
      capabilityMax: 131072,
      capabilityDefault: 131072,
      reportedWindow: 200000
    }),
    32768
  );
  assert.equal(
    resolveContextMax({ settingsWindow: 'unknown', capabilityMax: 8192, reportedWindow: 4000 }),
    8192
  );
  assert.equal(resolveContextMax({ settingsWindow: 'unknown', capabilityMax: 'unknown', reportedWindow: 4000 }), 4000);
  assert.equal(resolveContextMax({ settingsWindow: 'unknown', capabilityMax: 'unknown' }), undefined);
});

test('Codex fill is the latest call, not the thread lifetime total', () => {
  assert.equal(codexContextUsed({ last: { totalTokens: 4200 } }), 4200);
  assert.equal(codexContextUsed(undefined), undefined);
});

test('Ollama fill is the prompt plus tokens generated so far', () => {
  assert.equal(ollamaContextUsed(1000, 40), 1040);
  assert.equal(ollamaContextUsed(undefined, 12), 12);
  assert.equal(ollamaContextUsed(undefined, undefined), undefined);
  assert.equal(ollamaContextUsed(0, 0), undefined);
});

test('unreported text is estimated at about four characters per token', () => {
  assert.equal(tokensFromText(''), 0);
  assert.equal(tokensFromText('abcd'), 1);
  assert.equal(tokensFromText('abcde'), 2);
});
