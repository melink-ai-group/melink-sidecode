import test from 'node:test';
import assert from 'node:assert/strict';
import { DeadlineError } from '../settings/deadline.ts';
import { openSidebarSafely, safeOpenNotice } from './startup.ts';

test('a startup error still paints the chat and clears the restoring screen first', async () => {
  const order: string[] = [];
  let release = (): void => undefined;
  const later = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = openSidebarSafely(
    {
      hydrate: async () => {
        throw new Error('disk failed');
      },
      paint: async () => {
        order.push('paint');
      },
      afterPaint: async () => {
        order.push('after');
        await later;
      }
    },
    () => order.push('report'),
    () => order.push('unblock')
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, ['report', 'paint', 'unblock', 'after']);
  release();
  await pending;
});

test('a hydrate that never finishes still paints and unblocks', async () => {
  const order: string[] = [];
  await openSidebarSafely(
    {
      hydrate: () => new Promise(() => undefined),
      paint: async () => {
        order.push('paint');
      }
    },
    (error) => {
      order.push(error instanceof DeadlineError ? 'timeout' : 'report');
    },
    () => order.push('unblock'),
    { hydrateTimeoutMs: 30 }
  );
  assert.deepEqual(order, ['timeout', 'paint', 'unblock']);
});

test('a painted chat stays usable when the provider does not answer', () => {
  assert.match(safeOpenNotice(new DeadlineError('Reconnecting to the provider'), true), /saved messages are on screen/);
  assert.match(safeOpenNotice(new Error('connection reset'), true), /saved messages are on screen/);
  assert.equal(safeOpenNotice(new Error('Codex CLI not found.'), false), 'Codex CLI not found.');
});
