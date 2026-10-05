import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPACTED_CONTEXT_TITLE,
  compactedSummary,
  compactedTokenEstimate,
  compactedTranscript,
  compactionPreface,
  compactionSource,
  fitCompactionSource,
  instructionsWithHandover
} from './compaction.ts';

test('the summary source keeps user and assistant turns and drops other cards', () => {
  const source = compactionSource([
    { kind: 'message', role: 'user', text: 'Fix the ring' },
    { kind: 'tool', role: 'assistant', text: 'ran a command' },
    { kind: 'message', role: 'assistant', text: 'Done' }
  ]);
  assert.match(source, /User: Fix the ring/);
  assert.match(source, /Assistant: Done/);
  assert.equal(/ran a command/.test(source), false);
});

test('a source longer than the window keeps the newest tail', () => {
  const source = fitCompactionSource('abcdefghij', 1);
  assert.equal(source.length, 4);
  assert.equal(source, 'ghij');
  assert.equal(fitCompactionSource('ab', 10), 'ab');
});

test('the replacement transcript is a notice plus the summary the next turn sends', () => {
  const items = compactedTranscript('  Keep the plan. ');
  assert.equal(items[0]?.kind, 'notice');
  assert.equal(items[0]?.title, 'Context compacted');
  assert.equal(items[1]?.role, 'user');
  assert.equal(items[2]?.role, 'assistant');
  assert.equal(items[2]?.title, COMPACTED_CONTEXT_TITLE);
  assert.equal(items[2]?.text, 'Keep the plan.');
  assert.equal(compactedSummary(items), 'Keep the plan.');
  assert.match(compactionPreface('Keep the plan.'), /Keep the plan\./);
  assert.ok(compactedTokenEstimate(items) > 0);
});

test('a handover keeps the summary ahead of the project snapshot', () => {
  const instructions = instructionsWithHandover('Project: sidebar', 'Keep the plan.');
  assert.match(instructions ?? '', /Keep the plan\./);
  assert.match(instructions ?? '', /Project: sidebar/);
  assert.ok((instructions ?? '').indexOf('Keep the plan.') < (instructions ?? '').indexOf('Project: sidebar'));
  assert.equal(instructionsWithHandover(undefined, undefined), null);
});
