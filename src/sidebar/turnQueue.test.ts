import test from 'node:test';
import assert from 'node:assert/strict';
import type { Attachment } from '../backends/types.ts';
import {
  QUEUE_LEASE_MS,
  USER_TURN_QUEUE_CAP,
  clearSessionQueue,
  enqueueTurn,
  foreignQueueLeaseIsLive,
  invalidQueuedAttachment,
  listQueuedTurns,
  nextDispatchableTurn,
  parsePersistedTurnQueues,
  peekQueuedTurn,
  planQueueDrain,
  queueLeaseDisposition,
  queueLeaseOwner,
  queuedTurnThreadTarget,
  queuedTurnView,
  queuedTurnViews,
  removeQueuedTurn,
  requeueTurnFront,
  selectDispatchableTurn,
  serializeTurnQueues,
  sessionMatchesQueueTarget,
  shouldAnnounceUserMessage,
  shouldQueueWhileBusy,
  takeNextTurn,
  takeQueuedTurn,
  type QueuedTurn,
  type UserTurnQueues
} from './turnQueue.ts';

function turn(id: string, sessionId = 'tab_1', text = id): QueuedTurn {
  return { id, sessionId, text, attachments: [], createdAt: 1 };
}

function attachment(partial: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att_1',
    name: 'shot.png',
    mimeType: 'image/png',
    kind: 'image',
    path: 'C:/storage/attachments/shot.png',
    size: 10,
    ...partial
  };
}

function gate(partial: Partial<ReturnType<typeof baseGate>> = {}) {
  return { ...baseGate(), ...partial };
}

function baseGate() {
  return {
    id: 'tab_1',
    turnBusy: false,
    turnOpen: false,
    pendingQuestion: false,
    pendingApproval: false,
    disposed: false
  };
}

test('enqueue and take are FIFO with stable ordering', () => {
  const queues: UserTurnQueues = new Map();
  assert.equal(enqueueTurn(queues, turn('a')), 'queued');
  assert.equal(enqueueTurn(queues, turn('b')), 'queued');
  assert.equal(enqueueTurn(queues, turn('c')), 'queued');
  assert.deepEqual(listQueuedTurns(queues, 'tab_1').map((entry) => entry.id), ['a', 'b', 'c']);
  assert.equal(peekQueuedTurn(queues, 'tab_1')?.id, 'a');
  assert.equal(takeNextTurn(queues, 'tab_1')?.id, 'a');
  assert.equal(takeNextTurn(queues, 'tab_1')?.id, 'b');
  assert.equal(takeNextTurn(queues, 'tab_1')?.id, 'c');
  assert.equal(takeNextTurn(queues, 'tab_1'), undefined);
  assert.equal(queues.has('tab_1'), false);
});

test('queues are isolated per chat', () => {
  const queues: UserTurnQueues = new Map();
  enqueueTurn(queues, turn('a', 'tab_1'));
  enqueueTurn(queues, turn('b', 'tab_2'));
  enqueueTurn(queues, turn('c', 'tab_1'));
  assert.deepEqual(listQueuedTurns(queues, 'tab_1').map((entry) => entry.id), ['a', 'c']);
  assert.deepEqual(listQueuedTurns(queues, 'tab_2').map((entry) => entry.id), ['b']);
  assert.equal(takeNextTurn(queues, 'tab_2')?.id, 'b');
  assert.deepEqual(listQueuedTurns(queues, 'tab_1').map((entry) => entry.id), ['a', 'c']);
});

test('remove by id leaves order intact and dispatch removes before start', () => {
  const queues: UserTurnQueues = new Map();
  enqueueTurn(queues, turn('a'));
  enqueueTurn(queues, turn('b'));
  enqueueTurn(queues, turn('c'));
  assert.equal(removeQueuedTurn(queues, 'tab_1', 'b'), true);
  assert.deepEqual(listQueuedTurns(queues, 'tab_1').map((entry) => entry.id), ['a', 'c']);
  // Already dispatched entries are gone; cancel then reports false.
  assert.equal(takeNextTurn(queues, 'tab_1')?.id, 'a');
  assert.equal(removeQueuedTurn(queues, 'tab_1', 'a'), false);
  assert.deepEqual(listQueuedTurns(queues, 'tab_1').map((entry) => entry.id), ['c']);
});

test('clear drops only one chat and reports how many were discarded', () => {
  const queues: UserTurnQueues = new Map();
  enqueueTurn(queues, turn('a'));
  enqueueTurn(queues, turn('b'));
  enqueueTurn(queues, turn('c', 'tab_2'));
  assert.equal(clearSessionQueue(queues, 'tab_1'), 2);
  assert.equal(listQueuedTurns(queues, 'tab_1').length, 0);
  assert.equal(listQueuedTurns(queues, 'tab_2').length, 1);
  assert.equal(clearSessionQueue(queues, 'missing'), 0);
});

test('the queue is bounded and rejects duplicate ids anywhere', () => {
  const queues: UserTurnQueues = new Map();
  for (let index = 0; index < USER_TURN_QUEUE_CAP; index += 1) {
    assert.equal(enqueueTurn(queues, turn(`q${index}`)), 'queued');
  }
  assert.equal(listQueuedTurns(queues, 'tab_1').length, USER_TURN_QUEUE_CAP);
  assert.equal(enqueueTurn(queues, turn('overflow')), 'full');
  assert.equal(listQueuedTurns(queues, 'tab_1').length, USER_TURN_QUEUE_CAP);
  assert.equal(enqueueTurn(queues, turn('q0')), 'duplicate');
  assert.equal(enqueueTurn(queues, turn('q0', 'tab_2')), 'duplicate');
});

test('a queued view carries a short preview and basenames only', () => {
  const longText = `${'word '.repeat(40)}end`;
  const entry = {
    ...turn('a', 'tab_1', longText),
    attachments: [attachment(), attachment({ id: 'att_2', name: 'notes.txt', kind: 'text', mimeType: 'text/plain' })]
  };
  const view = queuedTurnView(entry, 20);
  assert.equal(view.attachmentCount, 2);
  assert.deepEqual(view.attachmentNames, ['shot.png', 'notes.txt']);
  assert.ok(view.textPreview.length <= 20);
  assert.equal(view.textPreview.endsWith('…'), true);
  assert.equal('attachments' in view, false);
  assert.equal(JSON.stringify(view).includes('C:/storage'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(entry)), entry);
});

test('queuedTurnViews maps one chat in order', () => {
  const queues: UserTurnQueues = new Map();
  enqueueTurn(queues, turn('a', 'tab_1', 'first'));
  enqueueTurn(queues, turn('b', 'tab_1', 'second'));
  assert.deepEqual(queuedTurnViews(queues, 'tab_1').map((view) => view.id), ['a', 'b']);
  assert.deepEqual(queuedTurnViews(queues, 'tab_2'), []);
});

test('a busy send queues for an explicit request or an attachment', () => {
  assert.equal(shouldQueueWhileBusy({ busy: true, queueRequested: true, attachmentCount: 0 }), true);
  assert.equal(shouldQueueWhileBusy({ busy: true, queueRequested: false, attachmentCount: 1 }), true);
  assert.equal(shouldQueueWhileBusy({ busy: true, queueRequested: false, attachmentCount: 0 }), false);
  assert.equal(shouldQueueWhileBusy({ busy: false, queueRequested: true, attachmentCount: 1 }), false);
});

test('dispatch picks the first idle chat after its turn finishes', () => {
  const queues: UserTurnQueues = new Map();
  enqueueTurn(queues, turn('a'));
  assert.equal(nextDispatchableTurn(queues, [gate({ turnBusy: true })]), undefined);
  assert.equal(nextDispatchableTurn(queues, [gate({ turnOpen: true })]), undefined);
  assert.equal(nextDispatchableTurn(queues, [gate({ pendingApproval: true })]), undefined);
  assert.equal(nextDispatchableTurn(queues, [gate({ pendingQuestion: true })]), undefined);
  assert.equal(nextDispatchableTurn(queues, [gate({ disposed: true })]), undefined);
  const next = nextDispatchableTurn(queues, [gate()]);
  assert.equal(next?.sessionId, 'tab_1');
  assert.equal(next?.entry.id, 'a');
  // The helper is a read; the host still owns the delete-before-start.
  assert.equal(listQueuedTurns(queues, 'tab_1').length, 1);
});

test('dispatch is per chat and does not cross queues', () => {
  const queues: UserTurnQueues = new Map();
  enqueueTurn(queues, turn('a', 'tab_1'));
  enqueueTurn(queues, turn('b', 'tab_2'));
  const next = nextDispatchableTurn(queues, [gate({ turnBusy: true }), gate({ id: 'tab_2' })]);
  assert.equal(next?.sessionId, 'tab_2');
  assert.equal(next?.entry.id, 'b');
});

test('queued attachments reject oversize and images that lost their bytes', () => {
  assert.equal(invalidQueuedAttachment([attachment()], 100), undefined);
  assert.match(invalidQueuedAttachment([attachment({ size: 101 })], 100) ?? '', /too large/);
  assert.match(invalidQueuedAttachment([attachment({ path: undefined })], 100) ?? '', /could not be saved/);
  assert.equal(invalidQueuedAttachment([attachment({ kind: 'text', path: undefined, mimeType: 'text/plain' })], 100), undefined);
});

test('host flow: queue while busy, cancel one, then dispatch the rest in order', () => {
  const queues: UserTurnQueues = new Map();
  const dispatched: string[] = [];
  const gates = [gate({ turnBusy: true })];
  const drain = (): void => {
    for (;;) {
      const next = nextDispatchableTurn(queues, gates);
      if (!next) {
        return;
      }
      const entry = takeNextTurn(queues, next.sessionId);
      if (!entry) {
        return;
      }
      gates[0].turnBusy = true;
      dispatched.push(entry.id);
    }
  };

  // While busy, an explicit queue request and an attachment both enqueue.
  assert.equal(shouldQueueWhileBusy({ busy: true, queueRequested: true, attachmentCount: 0 }), true);
  enqueueTurn(queues, turn('first'));
  assert.equal(invalidQueuedAttachment([attachment({ size: 200 })], 100) !== undefined, true);
  // Validation failure never reaches the queue; a later attachment turn does.
  enqueueTurn(queues, { ...turn('second'), attachments: [attachment()] });
  assert.equal(removeQueuedTurn(queues, 'tab_1', 'second'), true);
  enqueueTurn(queues, turn('third'));
  assert.deepEqual(listQueuedTurns(queues, 'tab_1').map((entry) => entry.id), ['first', 'third']);
  drain();
  assert.deepEqual(dispatched, []);

  // The turn finishes: exactly the oldest queued turn starts, not both.
  gates[0].turnBusy = false;
  drain();
  assert.deepEqual(dispatched, ['first']);
  assert.deepEqual(listQueuedTurns(queues, 'tab_1').map((entry) => entry.id), ['third']);

  // Its completion dispatches the next one, then the queue is empty.
  gates[0].turnBusy = false;
  drain();
  assert.deepEqual(dispatched, ['first', 'third']);
  assert.equal(peekQueuedTurn(queues, 'tab_1'), undefined);
});

test('drain plan puts user turns before automatic continuations and claims one action per chat', () => {
  const queues: UserTurnQueues = new Map();
  enqueueTurn(queues, turn('u1', 'tab_1'));
  enqueueTurn(queues, turn('u2', 'tab_2'));
  const gates = [gate({ id: 'tab_1' }), gate({ id: 'tab_2' })];

  const plan = planQueueDrain({
    queues,
    gates,
    continuations: ['tab_1', 'tab_2'],
    autopilot: ['tab_1', 'tab_2']
  });

  assert.deepEqual(
    plan.map((action) => [action.origin, action.sessionId]),
    [
      ['user', 'tab_1'],
      ['user', 'tab_2']
    ]
  );
});

test('a continuation or autopilot only dispatches for an idle chat with no user queue', () => {
  const queues: UserTurnQueues = new Map();
  const gates = [gate({ id: 'tab_1' }), gate({ id: 'tab_2', turnBusy: true })];

  const plan = planQueueDrain({
    queues,
    gates,
    continuations: ['tab_1', 'tab_2'],
    autopilot: ['tab_1', 'tab_2']
  });

  // One action per chat: continue wins over autopilot for tab_1; tab_2 is busy.
  assert.deepEqual(
    plan.map((action) => [action.origin, action.sessionId]),
    [['continue', 'tab_1']]
  );
});

test('a rapid second completion cannot dispatch the same queued turn twice', () => {
  const queues: UserTurnQueues = new Map();
  const gates = [gate()];
  enqueueTurn(queues, turn('first'));
  enqueueTurn(queues, turn('second'));

  const firstPlan = planQueueDrain({ queues, gates, continuations: [], autopilot: [] });
  const dispatched = firstPlan[0]?.origin === 'user' ? takeNextTurn(queues, 'tab_1')?.id : undefined;
  assert.equal(dispatched, 'first');
  // Dispatch sets the chat busy synchronously; a duplicate completion arriving
  // before the turn actually starts must see that gate and do nothing.
  gates[0].turnBusy = true;
  assert.deepEqual(planQueueDrain({ queues, gates, continuations: [], autopilot: [] }), []);
  assert.equal(listQueuedTurns(queues, 'tab_1')[0]?.id, 'second');

  gates[0].turnBusy = false;
  const next = planQueueDrain({ queues, gates, continuations: [], autopilot: [] });
  assert.equal(next[0]?.origin === 'user' ? next[0].entry.id : undefined, 'second');
});

test('a failed dispatch can be put back at the front of its chat', () => {
  const queues: UserTurnQueues = new Map();
  enqueueTurn(queues, turn('first'));
  enqueueTurn(queues, turn('second'));
  const removed = takeNextTurn(queues, 'tab_1');
  assert.equal(removed?.id, 'first');
  if (removed) {
    requeueTurnFront(queues, removed);
  }
  requeueTurnFront(queues, turn('first'));
  assert.deepEqual(listQueuedTurns(queues, 'tab_1').map((entry) => entry.id), ['first', 'second']);
});

test('a queue:true send that races the turn end still announces its user row', () => {
  assert.equal(
    shouldAnnounceUserMessage({ origin: 'user', busy: false, queueRequested: true, queuedDispatch: false }),
    true
  );
  assert.equal(
    shouldAnnounceUserMessage({ origin: 'user', busy: true, queueRequested: true, queuedDispatch: false }),
    false
  );
  assert.equal(
    shouldAnnounceUserMessage({ origin: 'user', busy: true, queueRequested: false, queuedDispatch: true }),
    true
  );
  assert.equal(
    shouldAnnounceUserMessage({ origin: 'user', busy: false, queueRequested: false, queuedDispatch: false }),
    false
  );
  assert.equal(
    shouldAnnounceUserMessage({ origin: 'autopilot', busy: false, queueRequested: true, queuedDispatch: false }),
    false
  );
});

test('the persisted queue round-trips JSON-safe entries and drops inline bytes', () => {
  const queues: UserTurnQueues = new Map();
  enqueueTurn(queues, {
    ...turn('a', 'tab_1', 'first'),
    backendId: 'codex',
    threadId: 'thread_1',
    attachments: [attachment({ dataUrl: 'data:image/png;base64,AAAA' })],
    mode: 'plan',
    permissionLevel: 'default',
    modelSettings: { thinking: 'high' },
    updatePlan: true
  });
  enqueueTurn(queues, turn('b', 'tab_1', 'second'));

  const payload = serializeTurnQueues(queues, 'window_1', 1234);
  const parsed = parsePersistedTurnQueues(JSON.parse(JSON.stringify(payload)));

  assert.ok(parsed);
  assert.equal(parsed.owner, 'window_1');
  assert.equal(parsed.heartbeat, 1234);
  assert.deepEqual(listQueuedTurns(parsed.queues, 'tab_1').map((entry) => entry.id), ['a', 'b']);
  const restored = listQueuedTurns(parsed.queues, 'tab_1')[0];
  assert.equal(restored?.threadId, 'thread_1');
  assert.equal(restored?.mode, 'plan');
  assert.equal(restored?.updatePlan, true);
  assert.equal(restored?.attachments[0]?.path, 'C:/storage/attachments/shot.png');
  assert.equal(restored?.attachments[0]?.dataUrl, undefined);
  assert.equal(JSON.stringify(payload).includes('data:image'), false);
});

test('malformed persisted entries and attachments are dropped without throwing', () => {
  assert.equal(parsePersistedTurnQueues(undefined), undefined);
  assert.equal(parsePersistedTurnQueues({ version: 2 }), undefined);

  const parsed = parsePersistedTurnQueues({
    version: 1,
    queues: [
      null,
      { sessionId: '', turns: [] },
      {
        sessionId: 'tab_1',
        turns: [
          null,
          { id: '', text: 'no id' },
          { id: 'bad-att', text: 'keep me', attachments: [{ nope: true }, { id: 'x', name: '', mimeType: 'image/png', kind: 'image' }] }
        ]
      }
    ]
  });

  assert.ok(parsed);
  const turns = listQueuedTurns(parsed.queues, 'tab_1');
  assert.deepEqual(turns.map((entry) => entry.id), ['bad-att']);
  assert.deepEqual(turns[0]?.attachments, []);
});

test('a foreign live lease blocks restore and a stale one does not', () => {
  const now = 1_700_000_000_000;
  assert.equal(foreignQueueLeaseIsLive('other', now - 1000, 'mine', now), true);
  assert.equal(foreignQueueLeaseIsLive('other', now - QUEUE_LEASE_MS - 1, 'mine', now), false);
  assert.equal(foreignQueueLeaseIsLive('mine', now, 'mine', now), false);
  assert.equal(foreignQueueLeaseIsLive(undefined, now, 'mine', now), false);
});


test('a disposed webview keeps the lease while turns can still flush', () => {
  const queues: UserTurnQueues = new Map();
  enqueueTurn(queues, turn('a'));
  enqueueTurn(queues, turn('b'));

  // onDidDispose is not a shutdown: the running turn can still send these.
  const disposition = queueLeaseDisposition({ queuedTurns: 2, shuttingDown: false });
  assert.equal(disposition, 'keep');

  // Keeping the lease means a second window sees a live owner and cannot claim.
  const payload = serializeTurnQueues(queues, queueLeaseOwner(2, 'window_a'), 1000);
  const parsed = parsePersistedTurnQueues(payload);
  assert.ok(parsed);
  assert.equal(foreignQueueLeaseIsLive(parsed.owner, parsed.heartbeat, 'window_b', 1_001), true);
  assert.deepEqual(listQueuedTurns(parsed.queues, 'tab_1').map((entry) => entry.id), ['a', 'b']);

  // An empty queue, or a real shutdown after flushing stops, hands it back.
  assert.equal(queueLeaseDisposition({ queuedTurns: 0, shuttingDown: false }), 'release');
  assert.equal(queueLeaseDisposition({ queuedTurns: 2, shuttingDown: true }), 'release');
});

test('an emptied queue clears its owner and heartbeat immediately', () => {
  const empty = serializeTurnQueues(new Map(), queueLeaseOwner(0, 'window_a'));
  assert.equal(empty.owner, undefined);
  assert.equal('heartbeat' in empty, false);
  assert.equal(foreignQueueLeaseIsLive(empty.owner, empty.heartbeat as number, 'window_b'), false);

  const queues: UserTurnQueues = new Map();
  enqueueTurn(queues, turn('a'));
  const owner = queueLeaseOwner(1, 'window_a');
  assert.equal(owner, 'window_a');
  assert.equal(serializeTurnQueues(queues, owner).owner, 'window_a');
});

test('a blocked entry is skipped so later queued messages still dispatch in order', () => {
  const queues: UserTurnQueues = new Map();
  enqueueTurn(queues, { ...turn('broken'), attachments: [attachment()] });
  enqueueTurn(queues, turn('second'));
  enqueueTurn(queues, turn('third'));
  const blocked = new Set(['broken']);

  assert.equal(selectDispatchableTurn(listQueuedTurns(queues, 'tab_1'), blocked)?.id, 'second');
  assert.equal(peekQueuedTurn(queues, 'tab_1')?.id, 'broken');
  assert.equal(nextDispatchableTurn(queues, [gate()], blocked)?.entry.id, 'second');

  const plan = planQueueDrain({ queues, gates: [gate()], continuations: [], autopilot: [], blocked });
  assert.equal(plan[0]?.origin === 'user' ? plan[0].entry.id : undefined, 'second');
  assert.equal(takeQueuedTurn(queues, 'tab_1', 'second')?.id, 'second');
  assert.deepEqual(listQueuedTurns(queues, 'tab_1').map((entry) => entry.id), ['broken', 'third']);

  const next = planQueueDrain({ queues, gates: [gate()], continuations: [], autopilot: [], blocked });
  assert.equal(next[0]?.origin === 'user' ? next[0].entry.id : undefined, 'third');
  assert.equal(takeQueuedTurn(queues, 'tab_1', 'nope'), undefined);
});

test('a failed requeue never slices away a racing enqueue', () => {
  const queues: UserTurnQueues = new Map();
  for (let index = 0; index < USER_TURN_QUEUE_CAP; index += 1) {
    enqueueTurn(queues, turn(`q${index}`));
  }
  const failed = takeNextTurn(queues, 'tab_1');
  assert.equal(failed?.id, 'q0');
  assert.equal(enqueueTurn(queues, turn('racing')), 'queued');
  requeueTurnFront(queues, failed!);
  const ids = listQueuedTurns(queues, 'tab_1').map((entry) => entry.id);
  assert.deepEqual(ids, ['q0', ...Array.from({ length: USER_TURN_QUEUE_CAP - 1 }, (_, index) => `q${index + 1}`), 'racing']);
  assert.equal(ids.includes('racing'), true);
});

test('restored entries keep and validate their own backend/thread target', () => {
  const known = new Set(['codex', 'ollama-local']);
  const targeted = { ...turn('a'), backendId: 'codex', threadId: 'thread_1' };
  assert.deepEqual(queuedTurnThreadTarget(targeted, (id) => known.has(id)), { backendId: 'codex', threadId: 'thread_1' });
  assert.equal(queuedTurnThreadTarget({ ...targeted, backendId: undefined }, (id) => known.has(id)), 'invalid');
  assert.equal(queuedTurnThreadTarget({ ...targeted, threadId: undefined }, (id) => known.has(id)), 'invalid');
  assert.equal(queuedTurnThreadTarget({ ...targeted, backendId: 'unknown' }, (id) => known.has(id)), 'invalid');
  assert.equal(queuedTurnThreadTarget(turn('b'), (id) => known.has(id)), undefined);

  const target = { backendId: 'codex', threadId: 'thread_1' };
  assert.equal(sessionMatchesQueueTarget({ activeThread: target }, target), true);
  assert.equal(sessionMatchesQueueTarget({ activeThread: { backendId: 'codex', threadId: 'thread_2' } }, target), false);
  assert.equal(sessionMatchesQueueTarget({}, target), false);

  // A mixed queue persists each entry's target, so a dispatch can reopen that
  // entry's thread instead of sending everything to the first one.
  const queues: UserTurnQueues = new Map();
  enqueueTurn(queues, targeted);
  enqueueTurn(queues, { ...turn('b'), backendId: 'ollama-local', threadId: 'thread_2' });
  const parsed = parsePersistedTurnQueues(serializeTurnQueues(queues, 'w'));
  assert.deepEqual(
    listQueuedTurns(parsed!.queues, 'tab_1').map((entry) => [entry.id, entry.backendId, entry.threadId]),
    [
      ['a', 'codex', 'thread_1'],
      ['b', 'ollama-local', 'thread_2']
    ]
  );
});
