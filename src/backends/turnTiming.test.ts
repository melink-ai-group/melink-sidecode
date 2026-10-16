import test from 'node:test';
import assert from 'node:assert/strict';
import { formatWorked, messageSentAt, stampTurnWorked, type TimedTurnItem } from './turnTiming.ts';

const sentAt = 1_700_000_000_000;

function user(id: string, extra: Partial<TimedTurnItem> = {}): TimedTurnItem {
  return { id, kind: 'message', role: 'user', sentAt, ...extra };
}

test('formatWorked uses minutes and seconds under an hour, and hours and minutes above', () => {
  assert.equal(formatWorked(110_000), 'Worked for 1m 50s');
  assert.equal(formatWorked(120_000), 'Worked for 2m');
  assert.equal(formatWorked(12_000), 'Worked for 12s');
  assert.equal(formatWorked(0), 'Worked for 1s');
  assert.equal(formatWorked((2 * 3600 + 43 * 60) * 1000), 'Worked for 2h 43m');
  assert.equal(formatWorked(2 * 3600 * 1000), 'Worked for 2h');
  assert.equal(formatWorked((2 * 3600 + 43 * 60) * 1000 + 40_000), 'Worked for 2h 43m');
});

test('a finished turn is measured from the user message that opened it', () => {
  const items = [
    user('user_old', { workedMs: 1000, sentAt: sentAt - 50_000 }),
    { id: 'a0', kind: 'message', role: 'assistant' },
    user('user_open'),
    { id: 'a1', kind: 'message', role: 'assistant' },
    user('user_steer', { sentAt: undefined }),
    { id: 'a2', kind: 'message', role: 'assistant' }
  ];
  const stamped = stampTurnWorked(items, sentAt + 110_000);
  assert.equal(stamped[2]?.workedMs, 110_000);
  assert.equal(stamped[4]?.workedMs, undefined);
  assert.equal(stampTurnWorked(stamped, sentAt + 200_000)[2]?.workedMs, 110_000);
});

test('each sent message keeps its own duration', () => {
  const items = [
    user('user_1', { sentAt }),
    { id: 'a1', kind: 'message', role: 'assistant' },
    user('user_2', { sentAt: sentAt + 12_000 }),
    { id: 'a2', kind: 'message', role: 'assistant' }
  ];
  const stamped = stampTurnWorked(items, sentAt + 20_000);
  assert.equal(stamped[0]?.workedMs, 12_000);
  assert.equal(stamped[2]?.workedMs, 8_000);
  const again = stampTurnWorked(stamped, sentAt + 50_000);
  assert.equal(again[0]?.workedMs, 12_000);
  assert.equal(again[2]?.workedMs, 8_000);
});

test('a start time has to be a real timestamp on the message', () => {
  assert.equal(messageSentAt({ sentAt }), sentAt);
  assert.equal(messageSentAt({ sentAt: 1 }), undefined);
  assert.equal(messageSentAt({}), undefined);
});
