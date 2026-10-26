import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { AgentEvent, SendTurnRequest, StartThreadOptions, ThreadHandle } from '../backends/types.ts';
import { runReadOnlySubagent, type ReadOnlySubagentOptions } from './subagentRunner.ts';

const child: ThreadHandle = { backendId: 'fake', threadId: 'child', model: 'selected-model' };

function fixture() {
  const listeners = new Set<(event: AgentEvent) => void>();
  const starts: StartThreadOptions[] = [];
  const sends: SendTurnRequest[] = [];
  const cancellations: (string | undefined)[] = [];
  const approvals: string[] = [];
  const emit = (event: AgentEvent) => { for (const listener of listeners) { listener(event); } };
  const backend: ReadOnlySubagentOptions['backend'] = {
    permissionLevels: ['read-only', 'default'],
    startThread: async (options) => { starts.push(options ?? {}); return child; },
    sendTurn: async (_handle, request) => { sends.push(request); },
    onEvent: (listener) => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    cancel: (threadId) => { cancellations.push(threadId); },
    decideApproval: (_threadId, requestId, decision) => { approvals.push(`${requestId}:${decision}`); }
  };
  const answer = (text: string, id = 'answer') => {
    emit({ type: 'item/started', ...child, item: { id, kind: 'message', role: 'assistant' } });
    emit({ type: 'item/delta', ...child, itemId: id, delta: text });
  };
  const finish = () => emit({ type: 'turn/completed', ...child, turnId: 'turn' });
  const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };
  return { backend, listeners, starts, sends, cancellations, approvals, emit, answer, finish, flush };
}

test('worker pins read-only permissions, uses a private thread and returns only its final assessment', async () => {
  const f = fixture();
  const started: string[] = [];
  const pending = runReadOnlySubagent({ backend: f.backend, prompt: 'Review the diff.', model: 'selected-model', onStarted: (handle) => { started.push(handle.threadId); } });
  await f.flush();
  assert.equal(f.starts[0]?.internalSubagent, true);
  assert.equal(f.starts[0]?.permissionLevel, 'read-only');
  assert.equal(f.sends[0]?.permissionLevel, 'read-only');
  assert.equal(f.sends[0]?.model, 'selected-model');
  assert.match(f.sends[0]?.text ?? '', /Do not edit files/);
  f.emit({ type: 'item/started', backendId: 'fake', threadId: 'parent', item: { id: 'foreign', kind: 'message', role: 'assistant', text: 'unrelated' } });
  f.answer('Progress commentary', 'progress');
  f.answer('[{"message":"finding"}]');
  f.finish();
  assert.equal(await pending, '[{"message":"finding"}]');
  assert.deepEqual(started, ['child']);
  assert.equal(f.listeners.size, 0);
  assert.deepEqual(f.cancellations, []);
});

test('send acknowledgement cannot finish a worker before its terminal event', async () => {
  const f = fixture();
  let settled = false;
  const pending = runReadOnlySubagent({ backend: f.backend, prompt: 'Assess.' }).then((value) => { settled = true; return value; });
  await f.flush();
  assert.equal(settled, false);
  f.answer('Done');
  f.finish();
  assert.equal(await pending, 'Done');
});

test('worker refuses every approval escalation', async () => {
  const f = fixture();
  const pending = runReadOnlySubagent({ backend: f.backend, prompt: 'Assess.' });
  await f.flush();
  f.emit({ type: 'approval/requested', ...child, approval: { id: 'write', kind: 'file-change', method: 'edit' } });
  assert.deepEqual(f.approvals, ['write:reject']);
  f.answer('Could not make the requested edit.');
  f.finish();
  await pending;
});

test('worker deadline cancels only the child and removes its event listener', async () => {
  const f = fixture();
  await assert.rejects(runReadOnlySubagent({ backend: f.backend, prompt: 'Assess.', timeoutMs: 10 }), /timed out/);
  assert.deepEqual(f.cancellations, ['child']);
  assert.equal(f.listeners.size, 0);
});

test('cancellation during startup cleans up a late child without sending a turn', async () => {
  const f = fixture();
  let completeStart!: (handle: ThreadHandle) => void;
  f.backend.startThread = () => new Promise((resolve) => { completeStart = resolve; });
  const controller = new AbortController();
  const pending = runReadOnlySubagent({ backend: f.backend, prompt: 'Assess.', signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  completeStart(child);
  await f.flush();
  assert.deepEqual(f.cancellations, ['child']);
  assert.deepEqual(f.sends, []);
});

test('providers without read-only enforcement fail without launching a worker', async () => {
  const f = fixture();
  await assert.rejects(runReadOnlySubagent({ backend: { ...f.backend, permissionLevels: ['default'] }, prompt: 'Assess.' }), /cannot enforce read-only/);
  assert.deepEqual(f.starts, []);
});

test('empty output and provider send failures do not masquerade as completed assessments', async () => {
  const f = fixture();
  const pending = runReadOnlySubagent({ backend: f.backend, prompt: 'Assess.' });
  await f.flush();
  f.finish();
  await assert.rejects(pending, /no assessment/);
  assert.deepEqual(f.cancellations, ['child']);
  f.backend.sendTurn = async () => { throw new Error('send failed'); };
  await assert.rejects(runReadOnlySubagent({ backend: f.backend, prompt: 'Assess.' }), /send failed/);
  assert.equal(f.listeners.size, 0);
});

test('worker events are isolated before chat persistence and each provider marks its child before announcing it', async () => {
  const source = (file: string) => readFile(`${process.cwd()}/src/backends/${file}`, 'utf8');
  const registry = await source('registry.ts');
  const filter = registry.indexOf('this.store.isInternalThread(event.backendId, event.threadId)');
  assert.ok(filter > 0 && filter < registry.indexOf('this.store.applyEvent(event)'));
  for (const file of ['ollama.ts', 'opencodeBackend.ts', 'codex.ts']) {
    const text = await source(file);
    const start = text.slice(text.indexOf('async startThread('), text.indexOf('async resumeThread('));
    const marked = start.indexOf('markInternalThread(this.id, threadId)');
    const announced = file === 'codex.ts' ? start.indexOf('this.announceThread(') : start.indexOf('this.events.fire(');
    assert.ok(marked > 0 && announced > marked, `${file} must classify the worker before announcing it`);
  }
  assert.match(await source('codex.ts'), /options\?\.internalSubagent \? \{ ephemeral: true \}/);
});

test('oversized initial messages fail immediately and repeated snapshots preserve the assessment', async () => {
  const f = fixture();
  const oversized = runReadOnlySubagent({ backend: f.backend, prompt: 'Assess.' });
  await f.flush();
  f.emit({ type: 'item/started', ...child, item: { id: 'huge', kind: 'message', role: 'assistant', text: 'x'.repeat(64_001) } });
  await assert.rejects(oversized, /output limit/);
  assert.equal(f.listeners.size, 0);
  const assessment = runReadOnlySubagent({ backend: f.backend, prompt: 'Assess.' });
  await f.flush();
  f.answer('[]');
  f.emit({ type: 'item/started', ...child, item: { id: 'answer', kind: 'message', role: 'assistant' } });
  f.finish();
  assert.equal(await assessment, '[]');
});
