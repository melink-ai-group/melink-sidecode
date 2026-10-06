import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePatch, summarizeChange, translateItem, translateTurnItems, userInputText } from './items.ts';
import type { ThreadItem } from '../../../schemas/v2/ThreadItem';

test('userMessage maps to a user message item with concatenated text', () => {
  const item: ThreadItem = {
    type: 'userMessage',
    id: 'u1',
    clientId: null,
    content: [
      { type: 'text', text: 'hello', text_elements: [] },
      { type: 'text', text: 'world', text_elements: [] }
    ]
  };
  const translated = translateItem(item);
  assert.equal(translated.id, 'u1');
  assert.equal(translated.item.kind, 'message');
  assert.equal(translated.item.role, 'user');
  assert.equal(translated.item.text, 'hello\nworld');
  assert.equal(translated.terminal, true);
});

test('agentMessage maps to a streaming assistant message', () => {
  const item: ThreadItem = {
    type: 'agentMessage',
    id: 'a1',
    text: 'pong',
    phase: 'final_answer',
    memoryCitation: null,
    delivery: null,
    questions: null
  };
  const translated = translateItem(item);
  assert.equal(translated.item.kind, 'message');
  assert.equal(translated.item.role, 'assistant');
  assert.equal(translated.item.text, 'pong');
  // Assistant messages stream deltas; they are never terminal at the item level.
  assert.equal(translated.terminal, false);
});

test('reasoning joins summary and content', () => {
  const item: ThreadItem = {
    type: 'reasoning',
    id: 'r1',
    summary: ['first'],
    content: ['second']
  };
  const translated = translateItem(item);
  assert.equal(translated.item.kind, 'reasoning');
  assert.equal(translated.item.text, 'first\n\nsecond');
});

test('commandExecution maps to a tool item and is terminal once finished', () => {
  const running: ThreadItem = {
    type: 'commandExecution',
    id: 'c1',
    pluginId: null,
    scriptPath: null,
    command: 'ls',
    cwd: '/tmp',
    processId: null,
    source: 'agent',
    status: 'inProgress',
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null
  };
  assert.equal(translateItem(running).terminal, false);

  const done: ThreadItem = { ...running, status: 'completed', aggregatedOutput: 'ok', exitCode: 0 };
  const translated = translateItem(done);
  assert.equal(translated.item.kind, 'tool');
  assert.equal(translated.item.command, 'ls');
  assert.equal(translated.item.title, 'Running ls');
  assert.equal(translated.item.status, 'completed');
  assert.equal(translated.terminal, true);

  const failed: ThreadItem = { ...running, status: 'failed', exitCode: 1 };
  assert.equal(translateItem(failed).item.status, 'failed');
});

test('fileChange maps its changes to renderable file entries with diff counts', () => {
  const item: ThreadItem = {
    type: 'fileChange',
    id: 'f1',
    status: 'completed',
    changes: [
      {
        path: 'a.ts',
        kind: { type: 'update', move_path: null },
        diff: '--- a.ts\n+++ a.ts\n@@\n-old\n+new\n kept\n'
      }
    ]
  };
  const translated = translateItem(item);
  assert.equal(translated.item.kind, 'file-change');
  assert.equal(translated.item.status, 'completed');
  assert.equal(translated.item.files?.[0]?.path, 'a.ts');
  assert.equal(translated.item.files?.[0]?.additions, 1);
  assert.equal(translated.item.files?.[0]?.deletions, 1);
  assert.deepEqual(translated.item.files?.[0]?.lines, [
    { kind: 'del', text: 'old' },
    { kind: 'add', text: 'new' },
    { kind: 'context', text: 'kept' }
  ]);
});

test('translateTurnItems keeps the user message so a restored turn does not start at reasoning', () => {
  const items: ThreadItem[] = [
    {
      type: 'userMessage',
      id: 'u1',
      clientId: null,
      content: [{ type: 'text', text: 'hi', text_elements: [] }]
    },
    { type: 'reasoning', id: 'r1', summary: ['looking'], content: [] },
    { type: 'agentMessage', id: 'a1', text: 'hello', phase: null, memoryCitation: null, delivery: null, questions: null }
  ];
  const transcript = translateTurnItems(items);
  assert.deepEqual(
    transcript.map((item) => item.id),
    ['u1', 'r1', 'a1']
  );
  assert.equal(transcript[0]?.role, 'user');
  assert.equal(transcript[0]?.text, 'hi');
  assert.equal(transcript[1]?.kind, 'reasoning');
  assert.equal(transcript.every((item) => item.status === 'completed'), true);
});

test('dynamicToolCall labels the tool and keeps the real argument, not the status', () => {
  const item: ThreadItem = {
    type: 'dynamicToolCall',
    id: 'd1',
    namespace: null,
    tool: 'glob',
    arguments: { pattern: '**/*.ts' },
    status: 'completed',
    contentItems: null,
    success: true,
    durationMs: null
  };
  const translated = translateItem(item);
  assert.equal(translated.item.kind, 'tool');
  assert.equal(translated.item.command, '**/*.ts');
  assert.equal(translated.item.title, 'Finding files **/*.ts');
  assert.notEqual(translated.item.detail, 'completed');
  assert.notEqual(translated.item.command, 'completed');
});

test('parsePatch drops hunk headers and keeps only classifiable lines', () => {
  const lines = parsePatch('--- a\n+++ b\n@@ -1 +1 @@\n context\n+add\n-del\n');
  assert.deepEqual(lines, [
    { kind: 'context', text: 'context' },
    { kind: 'add', text: 'add' },
    { kind: 'del', text: 'del' }
  ]);
});

test('summarizeChange counts additions and deletions', () => {
  const change = summarizeChange('x.ts', '+one\n-two\n+three\n');
  assert.equal(change.additions, 2);
  assert.equal(change.deletions, 1);
});

test('userInputText ignores non-text input parts', () => {
  assert.equal(
    userInputText([
      { type: 'text', text: 'hi', text_elements: [] },
      { type: 'image', url: 'http://example.test/i.png' }
    ]),
    'hi'
  );
});
