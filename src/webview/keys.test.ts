import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSubmitEnter } from './keys.ts';

test('Enter while composing is not a submit', () => {
  assert.equal(isSubmitEnter({ key: 'Enter', nativeEvent: { isComposing: true } }), false);
});

test('Enter with the legacy keyCode 229 is not a submit', () => {
  assert.equal(isSubmitEnter({ key: 'Enter', keyCode: 229 }), false);
  assert.equal(isSubmitEnter({ key: 'Enter', nativeEvent: { keyCode: 229 } }), false);
});

test('Enter with isComposing false is a submit', () => {
  assert.equal(isSubmitEnter({ key: 'Enter', nativeEvent: { isComposing: false } }), true);
});

test('Shift+Enter is a newline, never a submit', () => {
  assert.equal(isSubmitEnter({ key: 'Enter', shiftKey: true }), false);
});

test('non-Enter keys are not submits', () => {
  assert.equal(isSubmitEnter({ key: 'a' }), false);
  assert.equal(isSubmitEnter({ key: ' ' }), false);
});

test('Enter without a nativeEvent is a plain submit', () => {
  assert.equal(isSubmitEnter({ key: 'Enter' }), true);
});

test('event.isComposing true is not a submit', () => {
  assert.equal(isSubmitEnter({ key: 'Enter', isComposing: true }), false);
});
