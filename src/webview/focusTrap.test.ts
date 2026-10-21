import test from 'node:test';
import assert from 'node:assert/strict';
import { FOCUSABLE_SELECTOR, confirmRestoreTarget, focusableControls, nextFocusIndex, trapTab } from './focusTrap.ts';

test('forward tab wraps from the last control to the first', () => {
  assert.equal(nextFocusIndex(3, 2, false), 0);
});

test('backward tab wraps from the first control to the last', () => {
  assert.equal(nextFocusIndex(3, 0, true), 2);
});

test('forward and backward move one step inside the controls', () => {
  assert.equal(nextFocusIndex(3, 1, false), 2);
  assert.equal(nextFocusIndex(3, 1, true), 0);
});

test('focus outside the controls enters at the first or last', () => {
  assert.equal(nextFocusIndex(3, -1, false), 0);
  assert.equal(nextFocusIndex(3, -1, true), 2);
  assert.equal(nextFocusIndex(3, 9, false), 0);
  assert.equal(nextFocusIndex(3, 9, true), 2);
});

test('zero focusable controls have no target', () => {
  assert.equal(nextFocusIndex(0, -1, false), -1);
  assert.equal(nextFocusIndex(0, 0, true), -1);
});

test('one focusable control stays on itself in both directions', () => {
  assert.equal(nextFocusIndex(1, 0, false), 0);
  assert.equal(nextFocusIndex(1, 0, true), 0);
});

test('the selector names enabled interactive controls and skips tabindex -1', () => {
  const parts = FOCUSABLE_SELECTOR.split(', ');
  assert.ok(parts.includes('a[href]'));
  assert.ok(parts.includes('button:not([disabled])'));
  assert.ok(parts.includes('input:not([disabled]):not([type="hidden"])'));
  assert.ok(parts.includes('select:not([disabled])'));
  assert.ok(parts.includes('textarea:not([disabled])'));
  assert.ok(parts.includes('[tabindex]:not([tabindex="-1"])'));
  assert.doesNotMatch(FOCUSABLE_SELECTOR, /\*/);
});

test('a missing root has no controls and a non-Tab key is not trapped', () => {
  assert.deepEqual(focusableControls(null), []);
  const event = { key: 'Enter', shiftKey: false } as KeyboardEvent;
  assert.equal(trapTab(event, null), false);
});

test('a still-usable trigger gets focus back, and a disabled one hands off to the header', () => {
  assert.equal(confirmRestoreTarget(true), 'trigger');
  assert.equal(confirmRestoreTarget(false), 'header');
});
