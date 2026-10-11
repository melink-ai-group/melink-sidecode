import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENCODE_QUIET_CAP_MS,
  OPENCODE_QUIET_EXTEND_MS,
  OPENCODE_QUIET_MS,
  opencodeQuietAction,
  quietTurnMessage,
  watchOpencodeQuiet,
  type QuietClock
} from './quiet.ts';

test('the first look is 90s, and a slow call is kept until the cap', () => {
  assert.equal(OPENCODE_QUIET_MS, 90_000);
  assert.equal(OPENCODE_QUIET_EXTEND_MS, 90_000);
  assert.equal(OPENCODE_QUIET_CAP_MS, 600_000);
  assert.equal(
    opencodeQuietAction({ quietForMs: 90_000, openTools: 0, waitingOnUser: false, slowCall: false }),
    'stop'
  );
  assert.equal(
    opencodeQuietAction({ quietForMs: 89_999, openTools: 0, waitingOnUser: false, slowCall: false }),
    'wait'
  );
  assert.equal(
    opencodeQuietAction({ quietForMs: 90_000, openTools: 1, waitingOnUser: false, slowCall: false }),
    'wait'
  );
  assert.equal(
    opencodeQuietAction({ quietForMs: 90_000, openTools: 0, waitingOnUser: true, slowCall: false }),
    'wait'
  );
  assert.equal(
    opencodeQuietAction({ quietForMs: 90_000, openTools: 0, waitingOnUser: false, slowCall: true }),
    'wait'
  );
  assert.equal(
    opencodeQuietAction({ quietForMs: 599_999, openTools: 0, waitingOnUser: false, slowCall: true }),
    'wait'
  );
  assert.equal(
    opencodeQuietAction({ quietForMs: 600_000, openTools: 0, waitingOnUser: false, slowCall: true }),
    'stop'
  );
  assert.match(quietTurnMessage(), /went quiet before it finished/);
});

function fakeClock(): { clock: QuietClock; now: { value: number }; due: () => void } {
  const now = { value: 0 };
  const pending: Array<{ at: number; fire: () => void }> = [];
  const clock: QuietClock = {
    now: () => now.value,
    schedule: (ms, fire) => {
      pending.push({ at: now.value + ms, fire });
      return () => {
        const index = pending.findIndex((entry) => entry.fire === fire);
        if (index >= 0) {
          pending.splice(index, 1);
        }
      };
    }
  };
  const due = (): void => {
    const ready = pending.filter((entry) => entry.at <= now.value);
    for (const entry of ready) {
      const index = pending.indexOf(entry);
      if (index >= 0) {
        pending.splice(index, 1);
      }
      entry.fire();
    }
  };
  return { clock, now, due };
}

test('silence is measured from the last event, and a running command holds the clock', () => {
  const { clock, now, due } = fakeClock();
  let blocked = false;
  let quiet = 0;
  const watch = watchOpencodeQuiet({
    firstMs: 1000,
    extendMs: 1000,
    capMs: 3000,
    clock,
    blocked: () => blocked,
    onQuiet: () => {
      quiet += 1;
    }
  });

  now.value = 5000;
  due();
  assert.equal(quiet, 0);

  watch.activity();
  blocked = true;
  now.value = 6000;
  due();
  assert.equal(quiet, 0);

  blocked = false;
  watch.activity();
  now.value = 6999;
  due();
  assert.equal(quiet, 0);
  now.value = 7000;
  due();
  assert.equal(quiet, 1);

  watch.activity();
  watch.stop();
  now.value = 9000;
  due();
  assert.equal(quiet, 1);
});

test('a slow call is checked again at 90s and kept until the cap', () => {
  const { clock, now, due } = fakeClock();
  let slow = true;
  let quiet = 0;
  const watch = watchOpencodeQuiet({
    firstMs: 1000,
    extendMs: 1000,
    capMs: 3000,
    clock,
    blocked: () => false,
    slowCall: () => slow,
    onQuiet: () => {
      quiet += 1;
    }
  });

  watch.activity();
  now.value = 1000;
  due();
  assert.equal(quiet, 0);
  now.value = 2000;
  due();
  assert.equal(quiet, 0);
  now.value = 3000;
  due();
  assert.equal(quiet, 1);

  quiet = 0;
  slow = true;
  watch.activity();
  now.value = 4000;
  due();
  assert.equal(quiet, 0);
  slow = false;
  now.value = 5000;
  due();
  assert.equal(quiet, 1);
});
