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

test('a question fence is stripped and custom or duplicate options are dropped', () => {
  const extracted = extractSidecodeQuestions(BLOCK);
  assert.equal(extracted.text, 'Here is what I need to know.');
  assert.equal(extracted.questions?.length, 2);
  assert.deepEqual(extracted.questions?.[0]?.options, ['Two columns', 'Single column', 'A fourth']);
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

test('a bare questions object becomes the card and leaves the surrounding reply', () => {
  const text = [
    'I have enough context to plan.',
    '',
    JSON.stringify({
      questions: [
        { prompt: 'How should the page be split?', options: ['Tabs', 'Sections', 'Cards'] },
        { prompt: 'How wide?', options: ['Full', 'One tab'] }
      ]
    }),
    '',
    'I need these answers before writing the plan.'
  ].join('\n');
  const extracted = extractSidecodeQuestions(text);
  assert.equal(extracted.questions?.length, 2);
  assert.equal(extracted.questions?.[0]?.prompt, 'How should the page be split?');
  assert.deepEqual(extracted.questions?.[0]?.options, ['Tabs', 'Sections', 'Cards']);
  assert.equal(extracted.text, 'I have enough context to plan.\n\nI need these answers before writing the plan.');
  assert.equal(hideQuestionFence(text), extracted.text);
});

test('a json fence, a trailing comma, and label options still open the card', () => {
  const fenced = 'Before.\n```json\n{"questions":[{"prompt":"Which?","options":["A","B",]}]}\n```\nAfter.';
  const extracted = extractSidecodeQuestions(fenced);
  assert.equal(extracted.questions?.[0]?.prompt, 'Which?');
  assert.deepEqual(extracted.questions?.[0]?.options, ['A', 'B']);
  assert.equal(extracted.text, 'Before.\n\nAfter.');
  const labeled = '{"questions":[{"question":"Which color?","choices":[{"label":"Yellow"},{"label":"Blue"}]}]}';
  assert.equal(extractSidecodeQuestions(labeled).questions?.[0]?.prompt, 'Which color?');
  assert.deepEqual(extractSidecodeQuestions(labeled).questions?.[0]?.options, ['Yellow', 'Blue']);
});

test('an unclosed question fence keeps the sentence after the payload', () => {
  const text = 'Before.\n```sidecode-question\n{"questions":[{"prompt":"Which?","options":["A"]}]}\n\nNeed these answers.';
  const extracted = extractSidecodeQuestions(text);
  assert.equal(extracted.questions?.[0]?.prompt, 'Which?');
  assert.match(extracted.text, /Before/);
  assert.match(extracted.text, /Need these answers/);
  assert.doesNotMatch(extracted.text, /sidecode-question/);
  assert.doesNotMatch(extracted.text, /"questions"/);
});

test('a code sample that is not the question payload stays in the reply', () => {
  const text = 'Example:\n```ts\nconst questions = ["a"];\n```\nDone.';
  assert.equal(extractSidecodeQuestions(text).text, text);
  assert.equal(extractSidecodeQuestions(text).questions, undefined);
  assert.equal(extractSidecodeQuestions('```json\n{"name":"app"}\n```').questions, undefined);
});

test('an unfinished questions object is hidden while it streams', () => {
  const text = 'Checking the layout.\n{"questions":[{"prompt":"Which?"';
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

test('ranked options drop a custom entry, duplicates, and anything past six', () => {
  assert.deepEqual(rankedOptions(['Best', 'Next', CUSTOM_OPTION_LABEL, 'Later']), ['Best', 'Next', 'Later']);
  assert.deepEqual(rankedOptions([{ label: 'Best' }, { label: 'best' }]), ['Best']);
  assert.deepEqual(rankedOptions(['1', '2', '3', '4', '5', '6', '7']), ['1', '2', '3', '4', '5', '6']);
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
