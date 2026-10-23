import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightNavigation } from './preflight.ts';
import { SessionOrigins } from './policy.ts';

test('preflight rejects a missing url without asking or launching', () => {
  const granted = new SessionOrigins();
  assert.deepEqual(preflightNavigation({}, granted), { kind: 'missing' });
  assert.deepEqual(preflightNavigation({ url: '' }, granted), { kind: 'missing' });
  assert.deepEqual(preflightNavigation({ url: '   ' }, granted), { kind: 'missing' });
  assert.deepEqual(preflightNavigation({ url: 42 }, granted), { kind: 'missing' });
  assert.deepEqual(preflightNavigation(null, granted), { kind: 'missing' });
});

test('preflight rejects non-http(s) addresses', () => {
  const granted = new SessionOrigins();
  for (const url of ['file:///C:/secret.html', 'javascript:alert(1)', 'ftp://example.com', 'about:blank', 'not a url']) {
    assert.deepEqual(preflightNavigation({ url }, granted), { kind: 'invalid' }, url);
  }
});

test('preflight asks for every origin, localhost included, until it is granted', () => {
  const granted = new SessionOrigins();
  assert.deepEqual(preflightNavigation({ url: 'http://localhost:3000/app' }, granted), {
    kind: 'ask',
    url: 'http://localhost:3000/app',
    origin: 'http://localhost:3000'
  });
  assert.deepEqual(preflightNavigation({ url: 'https://example.com/docs' }, granted), {
    kind: 'ask',
    url: 'https://example.com/docs',
    origin: 'https://example.com'
  });
});

test('preflight allows only an exact granted origin and trims the url', () => {
  const granted = new SessionOrigins().add('http://localhost:3000');
  assert.deepEqual(preflightNavigation({ url: '  http://localhost:3000/next  ' }, granted), {
    kind: 'allow',
    url: 'http://localhost:3000/next',
    origin: 'http://localhost:3000'
  });
  assert.equal(preflightNavigation({ url: 'http://localhost:5173/' }, granted).kind, 'ask');
  assert.equal(preflightNavigation({ url: 'https://localhost:3000/' }, granted).kind, 'ask');
  assert.equal(preflightNavigation({ url: 'http://127.0.0.1:3000/' }, granted).kind, 'ask');
});
