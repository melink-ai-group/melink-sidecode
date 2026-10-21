import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextMessages } from './contextMessages.ts';

test('the snapshot is a system message before the first user turn', () => {
  const messages = buildContextMessages([], 'what is this project about?', {
    snapshot: '<project-context>snapshot</project-context>',
    priming: true
  });
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, '<project-context>snapshot</project-context>');
  assert.equal(messages[messages.length - 1].role, 'user');
  assert.equal(messages[messages.length - 1].content, 'what is this project about?');
});

test('system context is ordered snapshot, history, delta, user turn', () => {
  const history = [
    { role: 'user' as const, content: 'first' },
    { role: 'assistant' as const, content: 'reply' }
  ];
  const messages = buildContextMessages(history, 'second', {
    snapshot: 'SNAPSHOT',
    delta: 'DELTA'
  });
  assert.deepEqual(
    messages.map((message) => `${message.role}:${message.content}`),
    ['system:SNAPSHOT', 'user:first', 'assistant:reply', 'system:DELTA', 'user:second']
  );
});

test('the delta is sent as system-role input only', () => {
  const messages = buildContextMessages([], 'hi', { delta: 'DELTA' });
  const delta = messages.find((message) => message.content === 'DELTA');
  assert.ok(delta);
  assert.equal(delta!.role, 'system');
});

test('the repo map is per-turn system input alongside the delta', () => {
  const messages = buildContextMessages([{ role: 'user', content: 'first' }], 'second', {
    snapshot: 'SNAPSHOT',
    delta: 'DELTA',
    repoMap: 'Repo map: src/auth.ts: login'
  });
  assert.deepEqual(
    messages.map((message) => `${message.role}:${message.content}`),
    [
      'system:SNAPSHOT',
      'user:first',
      'system:DELTA',
      'system:Repo map: src/auth.ts: login',
      'user:second'
    ]
  );
});

test('a notice primes when no snapshot was built', () => {
  const messages = buildContextMessages([], 'hi', { notice: 'no context', priming: true });
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, 'no context');
});

test('a snapshot wins over a notice, so a stale notice cannot mask it', () => {
  const messages = buildContextMessages([], 'hi', { snapshot: 'SNAPSHOT', notice: 'stale' });
  assert.equal(messages[0].content, 'SNAPSHOT');
  assert.equal(messages.some((message) => message.content === 'stale'), false);
});

test('the persisted history array is never mutated', () => {
  const history = [
    { role: 'user' as const, content: 'first' },
    { role: 'assistant' as const, content: 'reply' }
  ];
  const before = JSON.stringify(history);
  buildContextMessages(history, 'second', { snapshot: 'SNAPSHOT', delta: 'DELTA' });
  // The synthetic context exists only in the returned list: a caller that
  // persists `history` can never persist the snapshot or the delta.
  assert.equal(JSON.stringify(history), before);
  assert.equal(history.some((message) => message.content === 'SNAPSHOT' || message.content === 'DELTA'), false);
});

test('the attached file is a system message immediately before the user turn', () => {
  const messages = buildContextMessages([], 'how can we reduce the size of this file?', {
    snapshot: 'SNAPSHOT',
    attachedFile: 'Path: frontend/src/styles/global.css'
  });
  assert.deepEqual(
    messages.map((message) => message.content),
    ['SNAPSHOT', 'Path: frontend/src/styles/global.css', 'how can we reduce the size of this file?']
  );
  assert.equal(messages[1].role, 'system');
});

test('with no context the message list is exactly the history plus the turn', () => {
  const messages = buildContextMessages([{ role: 'user', content: 'a' }], 'b');
  assert.deepEqual(messages, [
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' }
  ]);
});
