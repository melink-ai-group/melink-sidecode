import test from 'node:test';
import assert from 'node:assert/strict';
import { createV2EventTranslator, v2RuntimeConfig, v2TodoSnapshot } from './v2.ts';
import { mergeReportedStepStatuses, renderPlanMarkdown } from '../plan.ts';
import { settleInProgressSteps } from '../types.ts';
import { opencodeListenUrl } from './approval.ts';
import type { OpencodeEvent } from './events.ts';

test('the final successful v2 todo snapshot completes and persists the fifth approved build step', () => {
  const steps = ['Add decision module', 'Add switch', 'Wire decision model', 'Expose setting', 'Update docs and tests, then run checks and build']
    .map((text, index) => ({ text, status: index === 4 ? 'inProgress' as const : 'completed' as const }));
  const todos = steps.map((step) => ({ content: step.text, status: 'completed' }));
  const event = v2TodoSnapshot({ data: [{ id: 'current', type: 'assistant', content: [{ type: 'tool', id: 'todo-final', name: 'todowrite',
    state: { status: 'completed', input: {}, metadata: { todos } } }] }] }, 's', new Set(['current']));
  assert.equal(event?.kind, 'tool');
  if (event?.kind !== 'tool' || !event.todos) assert.fail('The persisted todo result was dropped');
  const merged = mergeReportedStepStatuses(steps, event.todos);
  const settled = settleInProgressSteps(merged.steps);
  assert.equal(settled.filter((step) => step.status === 'completed').length, 5);
  assert.match(renderPlanMarkdown({ title: 'Build', steps: settled }), /- \[x\] Update docs and tests, then run checks and build/);
});

test('v2 todo reconciliation ignores old sessions and unsuccessful updates', () => {
  const messages = { data: [
    { id: 'old', type: 'assistant', content: [{ type: 'tool', name: 'todowrite', id: 'old-tool', state: {
      status: 'completed', input: { todos: [{ content: 'Run build', status: 'completed' }] }
    } }] },
    { id: 'current', type: 'assistant', content: [{ type: 'tool', name: 'todowrite', id: 'failed-tool', state: {
      status: 'error', input: { todos: [{ content: 'Run build', status: 'completed' }] }
    } }] }
  ] };
  assert.equal(v2TodoSnapshot(messages, 's', new Set(['current'])), undefined);
});

test('v2 metadata recovers todo completion even when the called frame was missed', () => {
  const events: OpencodeEvent[] = [];
  const translate = createV2EventTranslator('s', (event) => events.push(event));
  translate({ type: 'session.tool.input.started', data: { sessionID: 's', id: 'todo', name: 'todowrite' } });
  translate({ type: 'session.tool.success', data: { sessionID: 's', id: 'todo', metadata: {
    todos: [{ content: 'Run build', status: 'completed' }]
  } } });
  assert.equal(events[0]?.kind, 'tool');
  assert.deepEqual(events[0]?.kind === 'tool' && events[0].todos, [{ text: 'Run build', status: 'completed' }]);
});

test('v2 config keeps MCP tools directly available while blocking the Code Mode fetch bypass', () => {
  const config = { permission: { bash: 'ask' }, agent: { test: { permission: { bash: 'ask' }, tools: { task: false } } },
    mcp: { browser: { type: 'local', command: ['node', 'browser.js'], enabled: true, timeout: 30000 } } };
  const converted = v2RuntimeConfig(config);
  assert.deepEqual(converted.permission, { bash: 'ask', execute: 'deny', todowrite: 'allow' });
  assert.deepEqual(converted.mcp, { servers: { browser: { type: 'local', command: ['node', 'browser.js'],
    disabled: false, codemode: false, timeout: { catalog: 30000, execution: 30000 } } } });
  assert.equal(config.agent.test.tools.task, false);
  assert.equal('execute' in config.permission, false, 'the v1 config must not be mutated');
});

test('v2 native text and reasoning deltas do not duplicate their final snapshots or other sessions', () => {
  const events: OpencodeEvent[] = [];
  const translate = createV2EventTranslator('s', (event) => events.push(event));
  for (const kind of ['text', 'reasoning']) {
    for (const delta of ['hello', ' world']) translate({ type: `session.${kind}.delta`, data: {
      sessionID: 's', assistantMessageID: 'm', ordinal: 0, delta
    } });
    translate({ type: `session.${kind}.ended`, data: { sessionID: 's', assistantMessageID: 'm', ordinal: 0, text: 'hello world' } });
  }
  translate({ type: 'session.text.delta', data: { sessionID: 'other', delta: 'hidden' } });
  assert.equal(events.filter((event) => event.kind === 'text').map((event) => event.text).join(''), 'hello world');
  assert.equal(events.filter((event) => event.kind === 'reasoning').map((event) => event.text).join(''), 'hello world');
  assert.ok(events.every((event) => 'sessionId' in event && event.sessionId === 'v2:s'));
});

test('v2 tool events retain command and file metadata through completion', () => {
  const events: OpencodeEvent[] = [];
  const translate = createV2EventTranslator('s', (event) => events.push(event));
  const data = { sessionID: 's', assistantMessageID: 'm', id: 'call' };
  translate({ type: 'session.tool.input.started', data: { ...data, name: 'bash' } });
  translate({ type: 'session.tool.called', data: { ...data, input: { command: 'echo hello' } } });
  translate({ type: 'session.tool.success', data: { ...data, content: [{ type: 'text', text: 'hello' }] } });
  assert.equal(events.length, 2);
  const finished = events[1];
  assert.equal(finished.kind, 'tool');
  if (finished.kind === 'tool') {
    assert.equal(finished.tool, 'bash');
    assert.equal(finished.command, 'echo hello');
    assert.equal(finished.status, 'completed');
    assert.equal(finished.output, 'hello');
  }
});

test('both major versions have recognized listen lines', () => {
  for (const prefix of ['', 'opencode ']) assert.equal(opencodeListenUrl(`${prefix}server listening on http://127.0.0.1:1234\n`), 'http://127.0.0.1:1234');
});
