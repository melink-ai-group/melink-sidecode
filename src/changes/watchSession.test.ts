import test from 'node:test';
import assert from 'node:assert/strict';
import { ChangeWatchSession, type ObserveChange } from './watchSession.ts';
import type { ChangeStatus } from '../backends/types';

/**
 * The host-free watcher behaviour. A fake timer drives the debounce, so the
 * coalescing and disposal rules are asserted deterministically.
 */

interface Harness {
  session: ChangeWatchSession;
  seen: Array<{ absPath: string; status: ChangeStatus }>;
  runTimers: () => void;
  roots: string[];
}

function harness(debounceMs = 150): Harness {
  const seen: Array<{ absPath: string; status: ChangeStatus }> = [];
  const roots = ['/ws'];
  const timers: Array<() => void> = [];
  const onObserve: ObserveChange = (absPath, status) => seen.push({ absPath, status });
  const session = new ChangeWatchSession({
    workspaceRoots: () => roots,
    onObserve,
    debounceMs,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => undefined
  });
  return {
    session,
    seen,
    roots,
    runTimers: () => {
      const pending = timers.splice(0);
      for (const fn of pending) {
        fn();
      }
    }
  };
}

test('a burst of writes is coalesced to one observation per path', () => {
  const h = harness();
  h.session.observe('/ws/a.ts', 'created');
  h.session.observe('/ws/a.ts', 'modified');
  h.session.observe('/ws/b.ts', 'modified');
  assert.equal(h.seen.length, 0, 'nothing is recorded before the debounce settles');

  h.runTimers();
  assert.deepEqual(h.seen, [
    { absPath: '/ws/a.ts', status: 'modified' },
    { absPath: '/ws/b.ts', status: 'modified' }
  ]);
});

test('a path outside every workspace root is ignored', () => {
  const h = harness();
  h.session.observe('/outside/x.ts', 'created');
  h.runTimers();
  assert.deepEqual(h.seen, []);
});

test('a path inside a second workspace root is observed', () => {
  const h = harness();
  h.roots.push('/other');
  h.session.observe('/other/y.ts', 'modified');
  h.runTimers();
  assert.deepEqual(h.seen, [{ absPath: '/other/y.ts', status: 'modified' }]);
});

test('stop flushes anything still debounced and then goes inert', () => {
  const h = harness();
  h.session.observe('/ws/a.ts', 'modified');
  // The turn ends before the debounce timer fires.
  h.session.stop();
  assert.deepEqual(h.seen, [{ absPath: '/ws/a.ts', status: 'modified' }], 'a pending change is not lost');
  assert.equal(h.session.active, false);

  // A late event after stop must not attach to the ended turn.
  h.session.observe('/ws/b.ts', 'created');
  h.runTimers();
  assert.deepEqual(h.seen, [{ absPath: '/ws/a.ts', status: 'modified' }]);
});

test('stop is idempotent and safe when nothing was observed', () => {
  const h = harness();
  h.session.stop();
  h.session.stop();
  assert.deepEqual(h.seen, []);
});

test('a session with no observations records nothing', () => {
  const h = harness();
  h.runTimers();
  assert.deepEqual(h.seen, []);
});
