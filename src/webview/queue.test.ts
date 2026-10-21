import test from 'node:test';
import assert from 'node:assert/strict';
import {
  queuedEntryMatches,
  queuedTextPreview,
  sameAttachmentIds,
  sendIntent,
  type SendIntentInput
} from './queue.ts';

function input(overrides: Partial<SendIntentInput> = {}): SendIntentInput {
  return {
    busy: false,
    backendId: 'codex',
    backendStatus: 'available',
    text: 'What changed in the guard?',
    attachmentCount: 0,
    restoring: false,
    pendingApproval: false,
    askingQuestion: false,
    modeSwitch: false,
    ...overrides
  };
}

const STEERABLE = ['codex', 'ollama', 'ollama-local', 'opencode'] as const;

test('text-only on every steer-capable provider keeps steering', () => {
  for (const backendId of STEERABLE) {
    assert.equal(sendIntent(input({ busy: true, backendId })), 'steer', backendId);
  }
});

test('a provider that cannot steer queues a text-only message', () => {
  assert.equal(sendIntent(input({ busy: true, backendId: 'future-provider' })), 'queue');
  assert.equal(sendIntent(input({ busy: true, backendId: undefined })), 'queue');
});

test('attachments queue even on a steer-capable provider', () => {
  for (const backendId of STEERABLE) {
    assert.equal(sendIntent(input({ busy: true, backendId, attachmentCount: 1 })), 'queue', backendId);
  }
  assert.equal(
    sendIntent(input({ busy: true, backendId: 'codex', text: '', attachmentCount: 2 })),
    'queue'
  );
});

test('an idle composer always sends normally', () => {
  assert.equal(sendIntent(input()), 'send');
  assert.equal(sendIntent(input({ text: '', attachmentCount: 1 })), 'send');
  assert.equal(sendIntent(input({ backendId: 'future-provider' })), 'send');
});

test('an empty or blocked composer posts nothing', () => {
  assert.equal(sendIntent(input({ text: '   ' })), 'blocked');
  assert.equal(sendIntent(input({ busy: true, text: '', attachmentCount: 0 })), 'blocked');
  assert.equal(sendIntent(input({ backendStatus: 'unavailable' })), 'blocked');
  assert.equal(sendIntent(input({ backendStatus: 'unauthenticated', busy: true })), 'blocked');
  assert.equal(sendIntent(input({ restoring: true })), 'blocked');
  assert.equal(sendIntent(input({ pendingApproval: true, busy: true })), 'blocked');
  assert.equal(sendIntent(input({ askingQuestion: true, busy: true })), 'blocked');
  assert.equal(sendIntent(input({ modeSwitch: true, busy: true })), 'blocked');
});

test('the preview matches the host collapse and limit exactly', () => {
  assert.equal(queuedTextPreview('  run   the tests  '), 'run the tests');
  const long = 'a'.repeat(100);
  const preview = queuedTextPreview(long);
  assert.equal(preview.length, 80);
  assert.equal(preview.endsWith('\u2026'), true);
  assert.equal(queuedTextPreview('short'), 'short');
});

test('the host echo is recognized by preview and attachment count', () => {
  const entries = [
    { id: 'q1', textPreview: 'run the tests', attachmentCount: 0 },
    { id: 'q2', textPreview: 'review this', attachmentCount: 1 }
  ];
  assert.equal(queuedEntryMatches(entries, ' run the tests ', 0), true);
  assert.equal(queuedEntryMatches(entries, 'review this', 1), true);
  assert.equal(queuedEntryMatches(entries, 'review this', 0), false);
  assert.equal(queuedEntryMatches(entries, 'another message', 0), false);
});

test('attachment chip sets compare by id', () => {
  assert.equal(sameAttachmentIds([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'a' }]), true);
  assert.equal(sameAttachmentIds([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }]), false);
  assert.equal(sameAttachmentIds([{ id: 'a' }], [{ id: 'b' }]), false);
});
