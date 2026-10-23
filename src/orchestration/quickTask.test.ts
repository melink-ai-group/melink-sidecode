import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUICK_TASK_MAX_CHARS,
  QUICK_TASK_MAX_WORDS,
  detectQuickTask,
  type QuickTaskInput
} from './quickTask.ts';

function input(overrides: Partial<QuickTaskInput> = {}): QuickTaskInput {
  return {
    text: 'What does registry.probe do?',
    mode: 'agent',
    origin: 'user',
    hasAttachments: false,
    hasActivePlan: false,
    ...overrides
  };
}

test('the design table classifies exactly as documented', () => {
  const cases: Array<[string, boolean]> = [
    ['What does registry.probe do?', true],
    ['explain the retry logic', true],
    ['List the models', true],
    ['Fix the failing provider test', false],
    ['Add Ollama Local as a provider', false],
    ['Update the README and then run tests', false],
    ['Summarize this file\nand list risks', false],
    ['How do I run the tests?', false],
    ['Thanks!', false]
  ];
  for (const [text, quick] of cases) {
    assert.equal(detectQuickTask(input({ text })).quick, quick, text);
  }
});

test('each documented veto reason is reported', () => {
  assert.equal(detectQuickTask(input({ mode: 'ask' })).reason, 'mode-not-agent');
  assert.equal(detectQuickTask(input({ mode: 'plan' })).reason, 'mode-not-agent');
  assert.equal(detectQuickTask(input({ origin: 'plan' })).reason, 'origin-not-user');
  assert.equal(detectQuickTask(input({ hasAttachments: true })).reason, 'attachments');
  assert.equal(detectQuickTask(input({ hasActivePlan: true })).reason, 'active-plan');
  assert.equal(detectQuickTask(input({ text: `What ${'a'.repeat(115)}?` })).reason, 'too-long');
  assert.equal(detectQuickTask(input({ text: 'What does this do?' })).reason, 'quick');
  assert.equal(detectQuickTask(input({ text: 'Thanks!' })).reason, 'not-question');
  assert.equal(detectQuickTask(input({ text: 'Fix the bug' })).reason, 'action-verb');
});

test('the boundary is inclusive at 120 characters and 20 words', () => {
  const atLimit = `What ${'a'.repeat(QUICK_TASK_MAX_CHARS - 6)}?`;
  assert.equal(atLimit.length, QUICK_TASK_MAX_CHARS);
  assert.equal(detectQuickTask(input({ text: atLimit })).quick, true);

  const overLimit = `What ${'a'.repeat(QUICK_TASK_MAX_CHARS - 5)}?`;
  assert.equal(overLimit.length, QUICK_TASK_MAX_CHARS + 1);
  assert.equal(detectQuickTask(input({ text: overLimit })).quick, false);

  const wordsAtLimit = `What ${Array.from({ length: QUICK_TASK_MAX_WORDS - 1 }, () => 'word').join(' ')}?`;
  assert.equal(wordsAtLimit.split(/\s+/).length, QUICK_TASK_MAX_WORDS);
  assert.equal(detectQuickTask(input({ text: wordsAtLimit })).quick, true);

  const wordsOverLimit = `What ${Array.from({ length: QUICK_TASK_MAX_WORDS }, () => 'word').join(' ')}?`;
  assert.equal(wordsOverLimit.split(/\s+/).length, QUICK_TASK_MAX_WORDS + 1);
  assert.equal(detectQuickTask(input({ text: wordsOverLimit })).reason, 'too-many-words');
});

test('multiline, list, and multi-step shapes are vetoed', () => {
  assert.equal(detectQuickTask(input({ text: 'What is this\nand what is that?' })).reason, 'multiline');
  assert.equal(detectQuickTask(input({ text: 'What is this\r\nand that?' })).reason, 'multiline');
  for (const text of ['- what is this?', '* what is this?', '1. what is this?', '2) what is this?']) {
    assert.equal(detectQuickTask(input({ text })).reason, 'list', text);
  }
  for (const text of [
    'What is this and then what is that?',
    'What is this then also that?',
    'What is this after that?',
    'first, what is this?',
    'second, what is that?',
    'step 2 what is this?',
    'What is this, finally?'
  ]) {
    assert.equal(detectQuickTask(input({ text })).reason, 'multi-step', text);
  }
});

test('every code-change or action verb vetoes a question', () => {
  const verbs = [
    'add', 'create', 'implement', 'build', 'write', 'edit', 'change', 'modify',
    'update', 'refactor', 'fix', 'remove', 'delete', 'rename', 'move', 'replace',
    'install', 'upgrade', 'uninstall', 'generate', 'scaffold', 'migrate', 'patch',
    'revert', 'merge', 'commit', 'push', 'run', 'execute', 'apply', 'configure',
    'wire', 'integrate', 'test'
  ];
  for (const verb of verbs) {
    assert.equal(
      detectQuickTask(input({ text: `What is ${verb}?` })).reason,
      'action-verb',
      verb
    );
    assert.equal(
      detectQuickTask(input({ text: `What is ${verb.toUpperCase()}?` })).reason,
      'action-verb',
      verb
    );
  }
});

test('question and explanation openings are accepted without a question mark', () => {
  for (const opening of [
    'what', 'why', 'how', 'who', 'when', 'where', 'which', 'is', 'are', 'does',
    'do', 'can', 'could', 'should', 'would', 'explain', 'describe', 'summarise',
    'summarize', 'show', 'list', 'tell'
  ]) {
    assert.equal(
      detectQuickTask(input({ text: `${opening} the current state` })).quick,
      true,
      opening
    );
  }
});

test('a question mark is accepted even without an allowlisted opening', () => {
  assert.equal(detectQuickTask(input({ text: 'Registry.probe?' })).quick, true);
});

test('quick detection trims surrounding whitespace and is case-insensitive', () => {
  assert.equal(detectQuickTask(input({ text: '  WHAT does it do?  ' })).quick, true);
  assert.equal(detectQuickTask(input({ text: '  explain  the retry logic  ' })).quick, true);
});

test('quick does not mutate the input text', () => {
  const text = 'What does it do?';
  detectQuickTask(input({ text }));
  assert.equal(text, 'What does it do?');
});

