import test from 'node:test';
import assert from 'node:assert/strict';
import { composeKey } from './keyboard.ts';

test('composeKey keeps plain keys as they are', () => {
  assert.equal(composeKey({ key: 'Enter' }), 'Enter');
  assert.equal(composeKey({ key: 'a' }), 'a');
  assert.equal(composeKey({ key: '' }), '');
});

test('composeKey preserves ctrl, alt, meta, and shift in Playwright order', () => {
  assert.equal(composeKey({ key: 'ArrowLeft', altKey: true }), 'Alt+ArrowLeft');
  assert.equal(composeKey({ key: 'a', ctrlKey: true }), 'Control+a');
  assert.equal(composeKey({ key: 'ArrowLeft', ctrlKey: true, shiftKey: true }), 'Control+Shift+ArrowLeft');
  assert.equal(
    composeKey({ key: 'p', ctrlKey: true, altKey: true, metaKey: true, shiftKey: true }),
    'Control+Alt+Meta+Shift+p'
  );
});

test('composeKey does not duplicate a modifier-only keydown', () => {
  for (const key of ['Control', 'Alt', 'Meta', 'Shift']) {
    assert.equal(composeKey({ key, ctrlKey: true, altKey: true, metaKey: true, shiftKey: true }), key);
  }
});

test('the serialized composeKey is self-contained for the webview script', () => {
  const run = new Function('event', `return (${composeKey.toString()})(event);`) as (event: {
    key: string;
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
  }) => string;
  assert.equal(run({ key: 'ArrowRight', ctrlKey: true, shiftKey: true }), 'Control+Shift+ArrowRight');
  assert.equal(run({ key: 'Escape' }), 'Escape');
});
