import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeOpencodeCliOutput } from './upgradeText.ts';

const ESC = '\u001b';

test('an already-installed upgrade becomes one sentence', () => {
  const raw = [
    `${ESC}[90mT${ESC}[39m Upgrade ${ESC}[90m${ESC}[39m ${ESC}[34m-${ESC}[39m Using method: npm`,
    `${ESC}[33m!${ESC}[39m opencode upgrade skipped: 1.18.34 is already installed ${ESC}[90m—${ESC}[39m Done${ESC}[0m`,
    `${'█'.repeat(40)}`
  ].join('\r');
  assert.equal(summarizeOpencodeCliOutput(raw, 0), 'Already up to date (1.18.34).');
});

test('a successful version bump names the new version', () => {
  const raw = `${ESC}[32mUpdated to 1.19.0${ESC}[0m\nDone`;
  assert.equal(summarizeOpencodeCliOutput(raw, 0), 'Updated to 1.19.0.');
});

test('a short message that is already plain is left as it is', () => {
  assert.equal(summarizeOpencodeCliOutput('opencode installed.', 0), 'opencode installed.');
  assert.equal(
    summarizeOpencodeCliOutput('The opencode CLI was not found.', 1),
    'The opencode CLI was not found.'
  );
});

test('an empty failure does not dump a blank log', () => {
  assert.equal(summarizeOpencodeCliOutput('   \n', 1), 'The opencode update failed (exit 1).');
  assert.equal(summarizeOpencodeCliOutput('', 0), 'opencode is up to date.');
});

test('a sentence that is already summarized stays the same', () => {
  assert.equal(summarizeOpencodeCliOutput('Already up to date (1.18.34).', 0), 'Already up to date (1.18.34).');
  assert.equal(summarizeOpencodeCliOutput('Updated to 1.19.0.', 0), 'Updated to 1.19.0.');
});
