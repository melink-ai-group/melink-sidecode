import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVER_OVERLOADED_CODE,
  drainLines,
  encodeNotification,
  encodeRequest,
  isServerOverloaded,
  JsonRpcError,
  parseMessage
} from './jsonrpc.ts';

test('encodeRequest omits the jsonrpc field the app-server does not expect', () => {
  const line = encodeRequest(1, 'initialize', { clientInfo: { name: 'x' } });
  assert.equal(line, '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"x"}}}\n');
  assert.ok(!line.includes('jsonrpc'));
});

test('encodeRequest drops params when absent', () => {
  assert.equal(encodeRequest(2, 'initialized'), '{"id":2,"method":"initialized"}\n');
});

test('encodeNotification carries only method and params', () => {
  assert.equal(encodeNotification('initialized'), '{"method":"initialized"}\n');
});

test('parseMessage classifies a success response', () => {
  const message = parseMessage('{"id":1,"result":{"userAgent":"x"}}');
  assert.equal(message.kind, 'response');
  assert.deepEqual(message, { kind: 'response', id: 1, result: { userAgent: 'x' } });
});

test('parseMessage classifies an error response with its code', () => {
  const message = parseMessage(
    `{"id":1,"error":{"code":${SERVER_OVERLOADED_CODE},"message":"Server overloaded; retry later."}}`
  );
  assert.equal(message.kind, 'response');
  if (message.kind === 'response' && 'error' in message) {
    assert.equal(message.error.code, SERVER_OVERLOADED_CODE);
  } else {
    assert.fail('expected an error response');
  }
});

test('parseMessage classifies a notification', () => {
  const message = parseMessage('{"method":"turn/started","params":{"threadId":"t"}}');
  assert.equal(message.kind, 'notification');
});

test('parseMessage classifies a server-initiated request by id plus method', () => {
  const message = parseMessage('{"id":7,"method":"item/commandExecution/requestApproval","params":{}}');
  assert.equal(message.kind, 'request');
  if (message.kind === 'request') {
    assert.equal(message.id, 7);
    assert.equal(message.method, 'item/commandExecution/requestApproval');
  }
});

test('parseMessage tolerates malformed and non-object lines', () => {
  assert.equal(parseMessage('not json').kind, 'unknown');
  assert.equal(parseMessage('[1,2,3]').kind, 'unknown');
  assert.equal(parseMessage('').kind, 'unknown');
});

test('isServerOverloaded matches only the documented overload code', () => {
  assert.equal(isServerOverloaded(new JsonRpcError({ code: SERVER_OVERLOADED_CODE, message: 'x' })), true);
  assert.equal(isServerOverloaded(new JsonRpcError({ code: -32600, message: 'x' })), false);
  assert.equal(isServerOverloaded(new Error('nope')), false);
});

test('drainLines returns complete lines and keeps a partial tail buffered', () => {
  const first = drainLines('{"id":1}\n{"id":2}\n{"id":3');
  assert.deepEqual(first.lines, ['{"id":1}', '{"id":2}']);
  assert.equal(first.remainder, '{"id":3');

  const second = drainLines(`${first.remainder}"}\n`);
  assert.deepEqual(second.lines, ['{"id":3"}']);
  assert.equal(second.remainder, '');
});

test('drainLines ignores blank lines', () => {
  const { lines } = drainLines('\n{"id":1}\n\n');
  assert.deepEqual(lines, ['{"id":1}']);
});
