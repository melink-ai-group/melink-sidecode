import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authFailureMessage,
  classifyCodexAuthFailure,
  describeCodexAuth
} from './auth.ts';

test('a ChatGPT login reports the mode and reads as signed in', () => {
  const verdict = describeCodexAuth({ authMethod: 'chatgpt', authToken: null, requiresOpenaiAuth: true });
  assert.equal(verdict.authenticated, true);
  assert.equal(verdict.mode, 'chatgpt');
  assert.equal(verdict.apiKeyMode, false);
  assert.match(verdict.detail, /ChatGPT/);
});

test('an API-key login is reported distinctly from the ChatGPT login', () => {
  const verdict = describeCodexAuth({ authMethod: 'apikey', authToken: null, requiresOpenaiAuth: true });
  assert.equal(verdict.authenticated, true);
  assert.equal(verdict.apiKeyMode, true);
  assert.match(verdict.detail, /API key/);
  // No credential value is ever part of the sentence.
  assert.equal(/sk-/.test(verdict.detail), false);
});

test('no reported method but no required auth is usable', () => {
  const verdict = describeCodexAuth({ authMethod: null, authToken: null, requiresOpenaiAuth: false });
  assert.equal(verdict.authenticated, true);
  assert.equal(verdict.mode, null);
  assert.match(verdict.detail, /does not require/);
});

test('no credential at all is not authenticated', () => {
  const verdict = describeCodexAuth({ authMethod: null, authToken: null, requiresOpenaiAuth: true });
  assert.equal(verdict.authenticated, false);
  assert.match(verdict.detail, /Not signed in/);
});

test('an absent response is not authenticated and names no mode', () => {
  const verdict = describeCodexAuth(undefined);
  assert.equal(verdict.authenticated, false);
  assert.equal(verdict.mode, null);
});

test('an Incorrect API key body maps to the API-key-vs-ChatGPT mismatch', () => {
  const failure = classifyCodexAuthFailure(
    '401 Unauthorized: Incorrect API key provided: sk-svcacct-ABC. You can find your API key at ...'
  );
  assert.equal(failure, 'api-key-mismatch');
  const message = authFailureMessage('api-key-mismatch');
  assert.match(message, /API key/);
  assert.match(message, /ChatGPT/);
  // The raw key must never leak into the surfaced sentence.
  assert.equal(/sk-/.test(message), false);
});

test('the other bodies map to their own distinct failures', () => {
  assert.equal(
    classifyCodexAuthFailure('401 Missing bearer or basic authentication in header'),
    'missing-credential'
  );
  assert.equal(classifyCodexAuthFailure('access token could not be refreshed'), 'refresh-failed');
});

test('an unrelated or absent body is not classified as an auth failure', () => {
  assert.equal(classifyCodexAuthFailure("Missing environment variable: 'FOO'"), undefined);
  assert.equal(classifyCodexAuthFailure('internal server error'), undefined);
  assert.equal(classifyCodexAuthFailure(undefined), undefined);
});
