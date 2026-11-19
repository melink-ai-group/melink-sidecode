import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpencodePublisher, isTextPartComplete, parseOpencodeEvent, type OpencodeEvent } from './events.ts';
import {
  approvalFromOpencode,
  busPayloadToOpencodeLine,
  consumeSse,
  opencodeListenUrl,
  opencodeReplyFor,
  permissionAskFromBus
} from './approval.ts';
import { ruleFor } from '../approvals.ts';

test('every sidebar decision maps onto an opencode reply', () => {
  assert.equal(opencodeReplyFor('allow-once'), 'once');
  assert.equal(opencodeReplyFor('allow-session'), 'always');
  assert.equal(opencodeReplyFor('allow-always'), 'always');
  assert.equal(opencodeReplyFor('reject'), 'reject');
});

test('a bash permission becomes a command approval the user can answer', () => {
  const ask = permissionAskFromBus({
    type: 'permission.asked',
    properties: {
      id: 'per_1',
      sessionID: 'ses_1',
      permission: 'bash',
      patterns: ['git status*'],
      metadata: { command: 'git status' }
    }
  });
  assert.ok(ask);
  const request = approvalFromOpencode(ask, 'C:\\work');
  assert.equal(request.kind, 'command');
  assert.equal(request.command, 'git status');
  // opencode offers no native exec-policy amendment, and none is invented:
  // a synthetic first-token prefix would be broader than the command shown.
  assert.equal(request.execPolicyAmendment, undefined);
  assert.equal(request.id, 'per_1');
});

test('the rule built from an opencode command ask covers only that command family', () => {
  const ask = permissionAskFromBus({
    type: 'permission.asked',
    properties: {
      id: 'per_1',
      sessionID: 'ses_1',
      permission: 'bash',
      patterns: ['git status*'],
      metadata: { command: 'git status' }
    }
  });
  assert.ok(ask);
  const rule = ruleFor(approvalFromOpencode(ask, 'C:\\work'), 'opencode', 1000);

  assert.deepEqual(rule.commandFamily, ['git', 'status']);
  assert.equal(rule.gitWrite, false);
  assert.equal(rule.commandExact, false);
  assert.equal(rule.execPolicyAmendment, undefined);
});

test('an edit permission becomes a file-change approval', () => {
  const ask = permissionAskFromBus({
    type: 'permission.asked',
    properties: {
      id: 'per_2',
      sessionID: 'ses_1',
      permission: 'edit',
      patterns: ['.gitignore'],
      metadata: { filepath: '.gitignore' }
    }
  });
  assert.ok(ask);
  const request = approvalFromOpencode(ask, 'C:\\work');
  assert.equal(request.kind, 'file-change');
  assert.deepEqual(request.paths, ['.gitignore']);
});

test('a bus tool part becomes the same event the run parser already understands', () => {
  const line = busPayloadToOpencodeLine({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt_1',
        sessionID: 'ses_1',
        type: 'tool',
        callID: 'call_1',
        tool: 'bash',
        state: { status: 'completed', input: { command: 'ls' }, title: 'ls' }
      }
    }
  });
  assert.ok(line);
  const event = parseOpencodeEvent(line);
  assert.equal(event.kind, 'tool');
  if (event.kind === 'tool') {
    assert.equal(event.command, 'ls');
    assert.equal(event.sessionId, 'ses_1');
  }
});

test('a streaming text part is held until it finishes', () => {
  const partial = busPayloadToOpencodeLine({
    type: 'message.part.updated',
    properties: { part: { type: 'text', text: 'Hi', time: { start: 1 }, sessionID: 'ses_1', id: 'prt' } }
  });
  assert.equal(partial, undefined);
  const done = busPayloadToOpencodeLine({
    type: 'message.part.updated',
    properties: { part: { type: 'text', text: 'Hi', time: { start: 1, end: 2 }, sessionID: 'ses_1', id: 'prt' } }
  });
  assert.ok(done);
  assert.equal(parseOpencodeEvent(done).kind, 'text');
});

test('the prompt the user typed is never painted as assistant output', () => {
  const roles = new Map<string, string>();
  const userMessage = {
    type: 'message.updated',
    properties: { sessionID: 'ses_1', info: { id: 'msg_user', role: 'user', sessionID: 'ses_1' } }
  };
  assert.equal(busPayloadToOpencodeLine(userMessage, new Map(), roles), undefined);
  const promptPart = {
    type: 'message.part.updated',
    properties: {
      sessionID: 'ses_1',
      part: {
        id: 'prt_user',
        messageID: 'msg_user',
        sessionID: 'ses_1',
        type: 'text',
        text: 'reply with the single word: pong',
        time: { start: 1, end: 2 }
      }
    }
  };
  assert.equal(busPayloadToOpencodeLine(promptPart, new Map(), roles), undefined);

  // The assistant message and its text are a different message, so they still
  // reach the transcript.
  busPayloadToOpencodeLine(
    { type: 'message.updated', properties: { sessionID: 'ses_1', info: { id: 'msg_reply', role: 'assistant', sessionID: 'ses_1' } } },
    new Map(),
    roles
  );
  const reply = busPayloadToOpencodeLine(
    {
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_1',
        part: {
          id: 'prt_reply',
          messageID: 'msg_reply',
          sessionID: 'ses_1',
          type: 'text',
          text: 'pong',
          time: { start: 3, end: 4 }
        }
      }
    },
    new Map(),
    roles
  );
  assert.ok(reply);
  const event = parseOpencodeEvent(reply);
  assert.equal(event.kind, 'text');
  if (event.kind === 'text') {
    assert.equal(event.text, 'pong');
  }
});

test('a delta that belongs to a user message is dropped before it is forwarded', () => {
  const roles = new Map<string, string>([['msg_user', 'user']]);
  const delta = {
    type: 'message.part.delta',
    properties: {
      sessionID: 'ses_1',
      messageID: 'msg_user',
      partID: 'prt_user',
      field: 'text',
      delta: 'pong'
    }
  };
  assert.equal(busPayloadToOpencodeLine(delta, new Map(), roles), undefined);
});

test('live reasoning survives snapshots, deltas, completion and prompt-body replay without duplication', () => {
  const parts = new Map<string, Record<string, unknown>>();
  const received: OpencodeEvent[] = [];
  const publish = createOpencodePublisher((event) => received.push(event));
  const part = { id: 'thought', sessionID: 'ses_1', type: 'reasoning', text: '', time: { start: 1 } };
  const update = (value: Record<string, unknown>): void => {
    const line = busPayloadToOpencodeLine({ type: 'message.part.updated', properties: { part: value } }, parts);
    assert.ok(line);
    publish(parseOpencodeEvent(line));
  };
  update(part);
  const delta = { type: 'message.part.delta', properties: { sessionID: 'ses_1', partID: 'thought', field: 'text', delta: 'Inspect files' } };
  assert.equal(busPayloadToOpencodeLine({ ...delta, properties: { ...delta.properties, sessionID: 'other' } }, parts), undefined);
  const line = busPayloadToOpencodeLine(delta, parts);
  assert.ok(line);
  publish(parseOpencodeEvent(line));
  update({ ...part, text: 'Inspect files' });
  update({ ...part, text: 'Inspect files', time: { start: 1, end: 2 } });
  update({ ...part, text: 'Inspect files', time: { start: 1, end: 2 } });
  assert.equal(busPayloadToOpencodeLine(delta, parts), undefined);
  assert.deepEqual(received, [
    { kind: 'reasoning', sessionId: 'ses_1', partId: 'thought', text: '', streaming: true },
    { kind: 'reasoning', sessionId: 'ses_1', partId: 'thought', text: 'Inspect files', streaming: true },
    { kind: 'reasoning', sessionId: 'ses_1', partId: 'thought', text: '' }
  ]);
});

test('completed-only reasoning and a growing final snapshot retain their text', () => {
  const received: OpencodeEvent[] = [];
  const publish = createOpencodePublisher((event) => received.push(event));
  publish({ kind: 'reasoning', partId: 'a', text: 'Look', streaming: true });
  publish({ kind: 'reasoning', partId: 'a', text: 'Look at tests' });
  publish({ kind: 'reasoning', partId: 'b', text: 'Whole thought' });
  assert.deepEqual(received.map((event) => event.kind === 'reasoning' ? [event.text, event.streaming] : []), [
    ['Look', true], [' at tests', undefined], ['Whole thought', undefined]
  ]);
});

test('streaming text stays open until the ended frame, which closes it once', () => {
  const received: OpencodeEvent[] = [];
  const publish = createOpencodePublisher((event) => received.push(event));
  const full = 'Done.\n```sidecode-question\n{"questions":[{"prompt":"Which?"}]}\n```';
  publish({ kind: 'text', partId: 'reply', text: full.slice(0, 24), streaming: true });
  publish({ kind: 'text', partId: 'reply', text: full, streaming: true });
  publish({ kind: 'text', partId: 'reply', text: full, streaming: false });
  publish({ kind: 'text', partId: 'reply', text: full, streaming: false });
  assert.equal(received.map((event) => event.kind === 'text' ? event.text : '').join(''), full);
  assert.deepEqual(received.map((event) => event.kind === 'text' ? [event.streaming, isTextPartComplete(event)] : []), [
    [true, false],
    [true, false],
    [false, true]
  ]);
  // OpenCode 1 sends one whole text part with no streaming flag.
  publish({ kind: 'text', partId: 'v1', text: 'Whole reply.' });
  const v1 = received[received.length - 1];
  assert.equal(v1?.kind === 'text' && isTextPartComplete(v1), true);
});

test('a closed SSE stream keeps a trailing frame that has no blank line', () => {
  const closed = consumeSse('data: {"type":"message.part.updated","properties":{"part":{"type":"text"}}}\n', true);
  assert.equal(closed.messages.length, 1);
  assert.equal(closed.rest, '');
  const partial = consumeSse('data: {"type":"mess', true);
  assert.deepEqual(partial.messages, []);
  assert.equal(partial.rest.includes('mess'), true);
});

test('SSE frames are split without dropping a partial tail', () => {
  const first = consumeSse('data: {"type":"server.connected"}\n\ndata: {"ty');
  assert.deepEqual(first.messages, ['{"type":"server.connected"}']);
  assert.equal(first.rest, 'data: {"ty');
  const second = consumeSse(`${first.rest}pe":"permission.asked"}\n\n`);
  assert.equal(second.messages.length, 1);
  assert.equal(permissionAskFromBus(JSON.parse(second.messages[0]) as Record<string, unknown>), undefined);
});

test('the serve listen line yields the base URL', () => {
  assert.equal(
    opencodeListenUrl('Warning: OPENCODE_SERVER_PASSWORD is not set.\nopencode server listening on http://127.0.0.1:4096\n'),
    'http://127.0.0.1:4096'
  );
  assert.equal(
    opencodeListenUrl(
      'loaded provider https://ollama.com/v1\nopencode server listening on http://127.0.0.1:54321\n'
    ),
    'http://127.0.0.1:54321'
  );
});
