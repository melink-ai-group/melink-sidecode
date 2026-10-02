import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOM_OPTION_LABEL,
  SKIPPED_ANSWER,
  extractSidecodeQuestions,
  formatQuestionAnswers,
  planDecisionLines,
  planUpdateFromAnswers,
  hideQuestionFence,
  questionAskFromBus,
  questionRequestFromToolParams,
  rankedOptions
} from './questions.ts';

const BLOCK = [
  'Here is what I need to know.',
  '',
  '```sidecode-question',
  JSON.stringify({
    questions: [
      { prompt: 'Which layout?', options: ['Two columns', 'Single column', 'Something else', 'A fourth'] },
      { prompt: 'Ship it now?', options: ['Yes'] }
    ]
  }),
  '```'
].join('\n');

test('a question fence is stripped and only the first two suggestions are kept', () => {
  const extracted = extractSidecodeQuestions(BLOCK);
  assert.equal(extracted.text, 'Here is what I need to know.');
  assert.equal(extracted.questions?.length, 2);
  assert.deepEqual(extracted.questions?.[0]?.options, ['Two columns', 'Single column']);
  assert.equal(extracted.questions?.[1]?.options.length, 1);
  assert.equal(extracted.questions?.[0]?.prompt, 'Which layout?');
});

test('invalid question JSON stays in the reply', () => {
  const text = 'Hello\n```sidecode-question\nnot json\n```';
  assert.equal(extractSidecodeQuestions(text).text, text);
  assert.equal(extractSidecodeQuestions(text).questions, undefined);
});

test('a streaming fence is hidden without dropping the prose', () => {
  const text = 'Checking the layout.\n```sidecode-question\n{"questions":';
  assert.equal(hideQuestionFence(text), 'Checking the layout.');
});

test('answers are one numbered line per question', () => {
  const text = formatQuestionAnswers(
    [
      { id: 'q1', prompt: 'Which layout?', options: ['Two columns', 'Single column'] },
      { id: 'q2', prompt: 'Ship it now?', options: ['Yes'] }
    ],
    [
      { questionId: 'q1', text: 'Two columns' },
      { questionId: 'q2', text: '' }
    ]
  );
  assert.equal(text, `Answers:\n1. Which layout?: Two columns\n2. Ship it now?: ${SKIPPED_ANSWER}`);
  assert.deepEqual(planDecisionLines(
    [
      { id: 'q1', prompt: 'Which layout?', options: ['Two columns'] },
      { id: 'q2', prompt: 'Ship it now?', options: ['Yes'] }
    ],
    [
      { questionId: 'q1', text: 'Two columns' },
      { questionId: 'q2', text: '' }
    ]
  ), ['1. Which layout?: Two columns', `2. Ship it now?: ${SKIPPED_ANSWER}`]);
  assert.match(planUpdateFromAnswers(
    [{ id: 'q1', prompt: 'Which layout?', options: ['Two columns'] }],
    [{ questionId: 'q1', text: 'Two columns' }]
  ), /Update the plan document/);
  assert.match(planUpdateFromAnswers(
    [{ id: 'q1', prompt: 'Which layout?', options: ['Two columns'] }],
    [{ questionId: 'q1', text: 'Two columns' }]
  ), /## Steps/);
});

test('ranked options drop a custom entry and anything past two', () => {
  assert.deepEqual(rankedOptions(['Best', 'Next', CUSTOM_OPTION_LABEL, 'Later']), ['Best', 'Next']);
  assert.deepEqual(rankedOptions([{ label: 'Best' }, { label: 'best' }]), ['Best']);
});

test('a Codex user-input request becomes the same question list', () => {
  const request = questionRequestFromToolParams('codex', 'input_1', {
    threadId: 'thread_1',
    questions: [{ id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'Yellow' }, { label: 'Blue' }] }]
  });
  assert.equal(request?.threadId, 'thread_1');
  assert.equal(request?.questions[0]?.header, 'Color');
  assert.deepEqual(request?.questions[0]?.options, ['Yellow', 'Blue']);
});

test('an OpenCode question.asked event is read from the bus payload', () => {
  const request = questionAskFromBus({
    type: 'question.asked',
    properties: {
      id: 'q_1',
      sessionID: 'ses_1',
      questions: [{ question: 'Which framework?', header: 'Framework', options: [{ label: 'React' }] }]
    }
  });
  assert.equal(request?.id, 'q_1');
  assert.equal(request?.questions[0]?.prompt, 'Which framework?');
  assert.deepEqual(request?.questions[0]?.options, ['React']);
});

test('a question event without questions is ignored', () => {
  assert.equal(questionAskFromBus({ type: 'question.asked', properties: { id: 'q_1' } }), undefined);
  assert.equal(questionRequestFromToolParams('codex', 'input_1', { threadId: 'thread_1', questions: [] }), undefined);
});
