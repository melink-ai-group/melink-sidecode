import test from 'node:test';
import assert from 'node:assert/strict';
import { authMismatchBackends, backendStatusView, incompatibleBackends } from './backendStatus.ts';
import type { BackendAvailability } from '../backends/types';

function availability(partial: Partial<BackendAvailability> & Pick<BackendAvailability, 'status'>): BackendAvailability {
  return { id: 'codex', label: 'OpenAI Codex CLI', badge: 'Codex', ...partial };
}

test('available, unauthenticated and unavailable map to distinct tones', () => {
  assert.equal(backendStatusView(availability({ status: 'available' })).tone, 'available');
  assert.equal(backendStatusView(availability({ status: 'unauthenticated' })).tone, 'unauthenticated');
  assert.equal(backendStatusView(availability({ status: 'unavailable' })).tone, 'unavailable');
});

test('a missing binary is not actionable and never reads as broken', () => {
  const view = backendStatusView(availability({ status: 'unavailable', detail: 'Codex CLI not found at "codex".' }));
  assert.equal(view.actionable, false);
  assert.equal(view.tone, 'unavailable');
  assert.equal(view.version, undefined);
});

test('an incompatible server carries the version and is actionable', () => {
  const view = backendStatusView(
    availability({ status: 'incompatible', detail: 'Codex app-server version 9.9.9 is outside the range.', version: '9.9.9' })
  );
  assert.equal(view.tone, 'incompatible');
  assert.equal(view.version, '9.9.9');
  assert.equal(view.actionable, true);
  assert.match(view.detail, /9\.9\.9/);
});

test('only incompatible providers are listed for the notice', () => {
  const list = [
    availability({ status: 'available' }),
    availability({ status: 'unavailable' }),
    availability({ id: 'codex', status: 'incompatible', version: '9.9.9' })
  ];
  const found = incompatibleBackends(list);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.status, 'incompatible');
});

test('a missing binary produces no incompatible notice', () => {
  assert.deepEqual(incompatibleBackends([availability({ status: 'unavailable' })]), []);
});

test('an API-key-vs-ChatGPT mismatch has its own tone, names the mode, and is actionable', () => {
  const view = backendStatusView(
    availability({
      status: 'auth-mismatch',
      detail: 'Signed in with an API key, not the ChatGPT login.',
      authMode: 'apikey'
    })
  );
  assert.equal(view.tone, 'auth-mismatch');
  assert.equal(view.actionable, true);
  assert.equal(view.authMode, 'apikey');
  assert.match(view.detail, /API key/);
});

test('only auth-mismatch providers are listed for that notice', () => {
  const list = [
    availability({ status: 'available' }),
    availability({ status: 'unauthenticated' }),
    availability({ id: 'codex', status: 'auth-mismatch', authMode: 'apikey' })
  ];
  const found = authMismatchBackends(list);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.status, 'auth-mismatch');
  // A plain signed-out provider is not an auth mismatch.
  assert.deepEqual(authMismatchBackends([availability({ status: 'unauthenticated' })]), []);
});
