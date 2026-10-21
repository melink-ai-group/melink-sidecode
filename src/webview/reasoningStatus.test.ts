import test from 'node:test';
import assert from 'node:assert/strict';
import { reasoningAnnouncement, reasoningStatusMessage, reasoningTransition } from './reasoningStatus.ts';

test('streaming or pending reasoning announces in progress, never the streamed text', () => {
  assert.equal(reasoningStatusMessage('streaming'), 'Reasoning in progress');
  assert.equal(reasoningStatusMessage('pending'), 'Reasoning in progress');
});

test('terminal reasoning announces finished or stopped', () => {
  assert.equal(reasoningStatusMessage('completed'), 'Reasoning finished');
  assert.equal(reasoningStatusMessage('failed'), 'Reasoning stopped');
  assert.equal(reasoningStatusMessage('canceled'), 'Reasoning stopped');
  assert.equal(reasoningStatusMessage('warning'), 'Reasoning stopped');
});

test('a live item announces its start and its terminal state once', () => {
  assert.equal(reasoningAnnouncement('pending', undefined), 'Reasoning in progress');
  assert.equal(reasoningAnnouncement('streaming', 'pending'), '');
  assert.equal(reasoningAnnouncement('completed', 'streaming'), 'Reasoning finished');
  assert.equal(reasoningAnnouncement('canceled', 'pending'), 'Reasoning stopped');
});

test('history that mounts already terminal is not announced as a new event', () => {
  assert.equal(reasoningAnnouncement('completed', 'completed'), '');
  assert.equal(reasoningAnnouncement('failed', undefined), '');
});

test('grouped reasoning announces start and finish from the transcript, ignoring tools', () => {
  const started = reasoningTransition(new Map(), [
    { id: 'reason-1', kind: 'reasoning', status: 'streaming' },
    { id: 'tool-1', kind: 'tool', status: 'streaming' }
  ]);
  assert.equal(started.announcement, 'Reasoning in progress');
  const finished = reasoningTransition(started.statuses, [
    { id: 'reason-1', kind: 'reasoning', status: 'completed' },
    { id: 'tool-1', kind: 'tool', status: 'completed' }
  ]);
  assert.equal(finished.announcement, 'Reasoning finished');
});

test('multiple reasoning items keep one status message and stay quiet for history', () => {
  const first = reasoningTransition(new Map(), [
    { id: 'history', kind: 'reasoning', status: 'completed' },
    { id: 'reason-2', kind: 'reasoning', status: 'pending' }
  ]);
  assert.equal(first.announcement, 'Reasoning in progress');
  assert.equal(first.statuses.get('history'), 'completed');
  assert.equal(first.statuses.get('reason-2'), 'pending');

  const streaming = new Map([
    ['reason-1', 'streaming' as const],
    ['reason-2', 'streaming' as const]
  ]);
  assert.equal(
    reasoningTransition(streaming, [
      { id: 'reason-1', kind: 'reasoning', status: 'canceled' },
      { id: 'reason-2', kind: 'reasoning', status: 'completed' }
    ]).announcement,
    'Reasoning finished'
  );
});

test('grouped reasoning announces a stop and keeps unknown/terminal history quiet', () => {
  const streaming = new Map([['reason-1', 'streaming' as const]]);
  assert.equal(
    reasoningTransition(streaming, [{ id: 'reason-1', kind: 'reasoning', status: 'canceled' }]).announcement,
    'Reasoning stopped'
  );
  assert.equal(
    reasoningTransition(new Map(), [
      { id: 'history', kind: 'reasoning', status: 'completed' },
      { id: 'history-failed', kind: 'reasoning', status: 'failed' }
    ]).announcement,
    ''
  );
});
