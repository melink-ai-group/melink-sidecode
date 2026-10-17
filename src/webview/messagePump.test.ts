import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessagePump, isUrgentHostMessage } from './messagePump.ts';

function manualPump(apply: (message: string) => void, shouldDefer?: () => boolean, onHold?: (held: boolean) => void) {
  const tasks = new Map<number, () => void>();
  let next = 1;
  const pump = createMessagePump<string>({
    apply,
    shouldDefer,
    onHold,
    schedule: (run) => {
      const id = next;
      next += 1;
      tasks.set(id, run);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (id) => {
      tasks.delete(id as unknown as number);
    }
  });
  return {
    pump,
    flush() {
      const runs = [...tasks.values()];
      tasks.clear();
      for (const run of runs) {
        run();
      }
    },
    pending: () => tasks.size
  };
}

test('streamed messages apply together on the next flush', () => {
  const applied: string[] = [];
  const { pump, flush } = manualPump((message) => applied.push(message));
  pump.push('a');
  pump.push('b');
  assert.deepEqual(applied, []);
  flush();
  assert.deepEqual(applied, ['a', 'b']);
  pump.dispose();
});

test('an urgent message flushes what was waiting and applies itself immediately', () => {
  const applied: string[] = [];
  const { pump } = manualPump((message) => applied.push(message));
  pump.push('a');
  pump.push('notice', true);
  assert.deepEqual(applied, ['a', 'notice']);
  pump.dispose();
});

test('scrolling holds streamed updates, then one flush applies them', () => {
  const applied: string[] = [];
  const held: boolean[] = [];
  let scrolling = true;
  const { pump, flush, pending } = manualPump(
    (message) => applied.push(message),
    () => scrolling,
    (value) => held.push(value)
  );
  pump.push('delta');
  flush();
  assert.deepEqual(applied, []);
  assert.deepEqual(held, [true]);
  assert.equal(pending(), 1);
  scrolling = false;
  flush();
  assert.deepEqual(applied, ['delta']);
  assert.deepEqual(held, [true, false]);
  pump.dispose();
});

test('dispose drops messages that have not been applied', () => {
  const applied: string[] = [];
  const { pump, flush } = manualPump((message) => applied.push(message));
  pump.push('a');
  pump.dispose();
  flush();
  assert.deepEqual(applied, []);
});

test('draft and dictation messages are urgent; transcript events are not', () => {
  assert.equal(isUrgentHostMessage('composerDraft'), true);
  assert.equal(isUrgentHostMessage('dictationStatus'), true);
  assert.equal(isUrgentHostMessage('notice'), true);
  assert.equal(isUrgentHostMessage('agentEvent'), false);
  assert.equal(isUrgentHostMessage('changes/decisionResult'), false);
});
