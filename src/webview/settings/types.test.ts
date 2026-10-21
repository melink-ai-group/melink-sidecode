import test from 'node:test';
import assert from 'node:assert/strict';
import { providerTabForSection } from './types.ts';

test('a Codex failure opens the Codex provider page', () => {
  assert.equal(providerTabForSection('codex'), 'provider-codex');
});

test('an Ollama Local failure opens the Ollama Local provider page, not Cloud', () => {
  assert.equal(providerTabForSection('ollama-local'), 'provider-local');
});

test('no section keeps the default Cloud page', () => {
  assert.equal(providerTabForSection(undefined), 'provider-ollama');
});
