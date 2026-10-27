import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKey } from './keyboard.ts';

test('normalizeKey keeps named keys and single characters', () => {
  assert.equal(normalizeKey('Enter'), 'Enter');
  assert.equal(normalizeKey('Escape'), 'Escape');
  assert.equal(normalizeKey('ArrowLeft'), 'ArrowLeft');
  assert.equal(normalizeKey('F5'), 'F5');
  assert.equal(normalizeKey('a'), 'a');
  assert.equal(normalizeKey('Control'), 'Control');
  assert.equal(normalizeKey('Shift'), 'Shift');
});

test('normalizeKey maps the browser spellings Playwright does not use', () => {
  assert.equal(normalizeKey(' '), 'Space');
  assert.equal(normalizeKey('Spacebar'), 'Space');
  assert.equal(normalizeKey('Esc'), 'Escape');
});

test('normalizeKey drops keys that produce text through composition instead', () => {
  for (const key of ['', 'Unidentified', 'Dead', 'Process', 'AltGraph']) {
    assert.equal(normalizeKey(key), undefined, key);
  }
});
