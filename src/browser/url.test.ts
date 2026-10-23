import test from 'node:test';
import assert from 'node:assert/strict';
import { urlInputError } from './url.ts';

test('address bar accepts absolute http(s) urls', () => {
  for (const url of ['http://localhost:3000', 'https://example.com/docs', '  http://127.0.0.1:5173/app  ']) {
    assert.equal(urlInputError(url), '', url);
  }
});

test('address bar reports a missing or non-http(s) url inline', () => {
  assert.equal(urlInputError(''), 'Enter an http or https address.');
  assert.equal(urlInputError('   '), 'Enter an http or https address.');
  for (const url of ['not a url', 'file:///C:/secret.html', 'javascript:alert(1)', 'ftp://example.com']) {
    assert.equal(urlInputError(url), 'Only http and https addresses can be opened.', url);
  }
});
