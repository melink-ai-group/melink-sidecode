import test from 'node:test';
import assert from 'node:assert/strict';
import { modeInstructions } from '../backends/modes.ts';
import { buildPrompt, runAll, runScenario } from './harness.ts';
import { renderReport } from './report.ts';
import { scenarios } from './scenarios.ts';

test('runAll is deterministic and keeps declaration order', () => {
  const first = runAll();
  const second = runAll();
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((result) => result.scenarioId),
    scenarios.map((entry) => entry.id)
  );
  assert.equal(first.every((result) => result.score.pass), true);
});

test('the prompt combines mode instructions, fixture context, and request', () => {
  const entry = scenarios[0];
  const prompt = buildPrompt(entry);
  assert.equal(prompt.includes(modeInstructions(entry.mode) ?? ''), true);
  assert.equal(prompt.includes(entry.context), true);
  assert.equal(prompt.includes(entry.request), true);
  assert.match(prompt, /# Fixture context/);
  assert.match(prompt, /# Request/);
});

test('runScenario records the prompt without calling a provider', () => {
  const entry = scenarios[1];
  const result = runScenario(entry);
  assert.equal(result.prompt, buildPrompt(entry));
  assert.equal(result.actualTools[0]?.startsWith('question'), true);
  assert.equal(result.score.total, 100);
});

test('report formatting carries run metadata and every scenario score', () => {
  const report = renderReport(runAll(), {
    date: '2026-10-20T00:00:00.000Z',
    baseCommit: '8622c6b',
    worktree: 'uncommitted changes present',
    command: 'npm run eval -- --report evals/baseline.md'
  });
  assert.match(report, /# Golden-scenario eval report/);
  assert.match(report, /Date: 2026-10-20T00:00:00\.000Z/);
  assert.match(report, /Base commit: `8622c6b`/);
  assert.match(report, /Worktree: uncommitted changes present/);
  assert.match(report, /Command: `npm run eval -- --report evals\/baseline\.md`/);
  assert.match(report, /offline fixture scoring/);
  assert.match(report, /prompt is built .* recorded/);
  assert.match(report, /\*\*4\/4 scenarios passed\.\*\*/);
  for (const entry of scenarios) {
    assert.equal(report.includes(`| ${entry.id} | 100 | 100 | 100 | PASS |`), true);
  }
  assert.match(report, /## Reproduction/);
  assert.match(report, /not a live model evaluation/);
});

test('report lists actionable details for a failing result', () => {
  const results = runAll();
  const failing = results[0];
  assert.ok(failing);
  const broken = {
    ...failing,
    score: { ...failing.score, pass: false, plan: 50, missing: ['plan: copy'], total: 75 },
    detail: '[fe-build-verify] broken plan'
  };
  const report = renderReport([broken], {
    date: '2026-10-20T00:00:00.000Z',
    baseCommit: '8622c6b',
    command: 'npm run eval'
  });
  assert.match(report, /\*\*0\/1 scenarios passed\.\*\*/);
  assert.match(report, /\| fe-build-verify \| 50 \| 100 \| 75 \| FAIL \|/);
  assert.match(report, /## Failure details/);
  assert.match(report, /\[fe-build-verify\] broken plan/);
});
