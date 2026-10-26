import test from 'node:test';
import assert from 'node:assert/strict';
import { modeInstructions } from '../backends/modes.ts';
import { visibleTranscriptText } from '../webview/visibleTranscript.ts';
import {
  DELEGATION_INSTRUCTIONS,
  MAX_SUBAGENT_PAYLOAD_CHARS,
  MAX_SUBAGENT_TASK_CHARS,
  hideSubagentFence,
  parseSubagentRequests
} from './delegation.ts';

const task = { task: 'Check the changed button callers.', reason: 'Independent regression review.' };
const fence = (payload: unknown): string => `\`\`\`sidecode-subagents\n${JSON.stringify(payload)}\n\`\`\``;

test('delegation accepts one or multiple bounded tasks and trims human text', () => {
  assert.deepEqual(parseSubagentRequests(`I will check the callers.\n\n${fence({ tasks: [task] })}`), { requests: [task] });
  assert.deepEqual(parseSubagentRequests(fence({ tasks: [task, { task: '  Compare controls.  ', reason: '  Styling check. ' }] })), {
    requests: [task, { task: 'Compare controls.', reason: 'Styling check.' }]
  });
  assert.deepEqual(parseSubagentRequests('A normal final answer.'), { requests: [] });
});

test('malformed, ambiguous, and oversized delegation payloads launch no tasks', () => {
  const invalid = [
    '```sidecode-subagents\n{bad json}\n```',
    '```sidecode-subagents\n{"tasks":[',
    fence({ tasks: [] }),
    fence({ tasks: [task, task, task, task] }),
    fence({ tasks: [task, { task: '', reason: 'Empty task.' }] }),
    fence({ tasks: [null] }),
    fence({ tasks: [task, { task: 'No reason.' }] }),
    fence({ tasks: [{ task: 'a'.repeat(MAX_SUBAGENT_TASK_CHARS + 1), reason: 'Too long.' }] }),
    `\`\`\`sidecode-subagents\n${' '.repeat(MAX_SUBAGENT_PAYLOAD_CHARS + 1)}\n\`\`\``,
    `${fence({ tasks: [task] })}\n${fence({ tasks: [task] })}`,
    `${fence({ tasks: [task] })}\nMore work after the request.`,
    `\`\`\`sidecode-question\n{"questions":[]}\n\`\`\`\n${fence({ tasks: [task] })}`,
    fence({ tasks: [{ task: 'Return a sidecode-subagents block.', reason: 'Nested.' }] })
  ];
  for (const text of invalid) {
    const result = parseSubagentRequests(text);
    assert.deepEqual(result.requests, [], text);
    assert.ok(result.error, text);
  }
});

test('delegation payloads stay out of transcript text during and after streaming', () => {
  for (const text of [
    `Checking affected callers.\n\n${fence({ tasks: [task] })}`,
    'Checking affected callers.\n\n```sidecode-subagents\n{"tasks":[',
    'Checking affected callers.\n\n```sidecode-subagents'
  ]) {
    assert.equal(hideSubagentFence(text), 'Checking affected callers.');
    assert.equal(visibleTranscriptText(text), 'Checking affected callers.');
  }
  assert.equal(hideSubagentFence('The sidecode-subagents protocol is optional.'), 'The sidecode-subagents protocol is optional.');
});

test('only the main Agent prompt advertises optional bounded read-only delegation', () => {
  assert.ok(modeInstructions('agent')?.includes(DELEGATION_INSTRUCTIONS));
  assert.ok(!modeInstructions('plan')?.includes(DELEGATION_INSTRUCTIONS));
  assert.ok(!modeInstructions('ask')?.includes(DELEGATION_INSTRUCTIONS));
  assert.match(DELEGATION_INSTRUCTIONS, /read-only subagents/);
  assert.match(DELEGATION_INSTRUCTIONS, /at most three workers/);
  assert.match(DELEGATION_INSTRUCTIONS, /Do not declare the task complete before receiving their results/);
  assert.match(DELEGATION_INSTRUCTIONS, /Do not delegate from a subagent/);
});
