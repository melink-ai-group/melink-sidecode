import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikePath, opencodePathError, parseOpencodeVersion } from './status.ts';

test('the version parser reads a semantic version from a --version line', () => {
  assert.equal(parseOpencodeVersion('1.1.65'), '1.1.65');
  assert.equal(parseOpencodeVersion('opencode 1.1.65'), '1.1.65');
  assert.equal(parseOpencodeVersion('v0.4.2\n'), '0.4.2');
  assert.equal(parseOpencodeVersion('opencode-cli 2.0.0-beta.3'), '2.0.0-beta.3');
});

test('the version parser returns undefined when no version is present', () => {
  assert.equal(parseOpencodeVersion(''), undefined);
  assert.equal(parseOpencodeVersion('usage: opencode run'), undefined);
});

test('a bare command name is left to PATH, never refused as a bad path', () => {
  assert.equal(looksLikePath('opencode'), false);
  assert.equal(opencodePathError('opencode', () => false), undefined);
});

test('a present path-shaped value is accepted', () => {
  assert.equal(opencodePathError('/usr/local/bin/opencode', () => true), undefined);
});

test('a missing path-shaped value is refused and says the stored path stays', () => {
  const message = opencodePathError('/opt/tools/opencod', () => false);
  assert.ok(message);
  assert.match(message as string, /not saved/);
});

test('an empty path is refused', () => {
  assert.match(opencodePathError('   ', () => true) ?? '', /not saved/);
});
