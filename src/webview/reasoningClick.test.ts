import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldToggleReasoningBody } from './reasoningClick.ts';

function targetMatching(tag: string) {
  return {
    closest: (selector: string) =>
      selector
        .split(',')
        .map((part) => part.trim())
        .includes(tag)
        ? { tag }
        : null
  };
}

test('a non-empty selection keeps the reasoning body open', () => {
  assert.equal(shouldToggleReasoningBody({ selectionText: 'reasoning text', target: targetMatching('div') }), false);
  assert.equal(shouldToggleReasoningBody({ selectionText: ' ', target: null }), false);
});

test('clicks on links, buttons, and code do not toggle the body', () => {
  for (const tag of ['a', 'button', 'code']) {
    assert.equal(shouldToggleReasoningBody({ selectionText: '', target: targetMatching(tag) }), false, tag);
  }
});

test('a plain body target toggles the body', () => {
  assert.equal(shouldToggleReasoningBody({ selectionText: '', target: targetMatching('div') }), true);
  assert.equal(shouldToggleReasoningBody({ selectionText: '', target: {} }), true);
});

test('an empty or missing selection on the body still toggles', () => {
  assert.equal(shouldToggleReasoningBody({ selectionText: '', target: targetMatching('p') }), true);
  assert.equal(shouldToggleReasoningBody({ selectionText: undefined, target: targetMatching('p') }), true);
  assert.equal(shouldToggleReasoningBody({ target: null }), true);
});
