import test from 'node:test';
import assert from 'node:assert/strict';
import { plainRowText } from './plainRowText.ts';

test('bold markers drop out of a title line', () => {
  assert.equal(plainRowText('**Adding tests**'), 'Adding tests');
  assert.equal(
    plainRowText('**Adding context isolation test****Adding board-run guard**'),
    'Adding context isolation test Adding board-run guard'
  );
});

test('inline code and links become their visible text', () => {
  assert.equal(plainRowText('See `cards.py` and [the plan](https://example.com/plan).'), 'See cards.py and the plan.');
});

test('a heading marker is not part of the row', () => {
  assert.equal(plainRowText('## Preparing the store'), 'Preparing the store');
});

test('a glob stays intact when it is not a bold span', () => {
  assert.equal(plainRowText('Finding files **/*.ts'), 'Finding files **/*.ts');
});
