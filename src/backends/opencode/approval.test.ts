import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpencodeEvent } from './events.ts';
import {
  approvalFromOpencode,
  busPayloadToOpencodeLine,
  consumeSse,
  opencodeListenUrl,
  opencodeReplyFor,
  permissionAskFromBus
} from './approval.ts';

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
  assert.deepEqual(request.execPolicyAmendment, ['git']);
  assert.equal(request.id, 'per_1');
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
});
