import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ASK_MODE_QUESTION_MESSAGE,
  CUSTOM_OPTION_LABEL,
  INVALID_QUESTION_MESSAGE,
  SKIPPED_ANSWER,
  askModeQuestionNotice,
  containsQuestionPayload,
  extractSidecodeQuestions,
  formatQuestionAnswers,
  invalidQuestionNotice,
  planDecisionLines,
  planUpdateFromAnswers,
  questionRetryInstruction,
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

test('an invalid closed question fence is removed and reported', () => {
  const text = 'Hello\n```sidecode-question\nnot json\n```\nDone.';
  const extracted = extractSidecodeQuestions(text);
  assert.equal(extracted.text, 'Hello\n\nDone.');
  assert.equal(extracted.questions, undefined);
  assert.equal(extracted.invalid, true);
  assert.doesNotMatch(extracted.text, /sidecode-question/);
});

test('a json fence whose question body fails to parse is invalid, a normal code sample is not', () => {
  const broken = 'Before.\n```json\n{"questions":[{"prompt":"Which?"}\n```\nAfter.';
  const extracted = extractSidecodeQuestions(broken);
  assert.equal(extracted.invalid, true);
  assert.equal(extracted.questions, undefined);
  assert.equal(extracted.text, 'Before.\n\nAfter.');
  assert.equal(extractSidecodeQuestions('Example:\n```ts\nconst questions = ["a"];\n```\nDone.').invalid, undefined);
});

test('an unclosed question fence with an unreadable body is removed to the end', () => {
  const text = 'Before.\n```sidecode-question\nnot json at all';
  const extracted = extractSidecodeQuestions(text);
  assert.equal(extracted.text, 'Before.');
  assert.equal(extracted.invalid, true);
  assert.equal(extracted.questions, undefined);
});

test('every valid payload is queued in source order with unique ids', () => {
  const first = JSON.stringify({ questions: [{ prompt: 'First?', options: ['A'] }] });
  const second = JSON.stringify({ questions: [{ prompt: 'Second?', options: ['B'] }, { prompt: 'Third?', options: ['C'] }] });
  const text = `One.\n\`\`\`sidecode-question\n${first}\n\`\`\`\nTwo.\n\`\`\`sidecode-question\n${second}\n\`\`\`\nThree.`;
  const extracted = extractSidecodeQuestions(text);
  assert.deepEqual(extracted.questions?.map((question) => question.prompt), ['First?', 'Second?', 'Third?']);
  assert.deepEqual(extracted.questions?.map((question) => question.id), ['q1', 'q2', 'q3']);
  assert.equal(extracted.text, 'One.\n\nTwo.\n\nThree.');
});

test('an overlapping bare payload inside a fence is not queued twice', () => {
  const payload = JSON.stringify({ questions: [{ prompt: 'Which?', options: ['A'] }] });
  const text = `Before.\n\`\`\`\n${payload}\n\`\`\`\nAfter.`;
  const extracted = extractSidecodeQuestions(text);
  assert.equal(extracted.questions?.length, 1);
  assert.equal(extracted.text, 'Before.\n\nAfter.');
});

test('a bare empty or malformed question object at a line start is removed and reported', () => {
  for (const payload of ['{"questions":[]}', '{"questions": [}', '{"questions": [{"prompt":"Which?"']) {
    const text = `Before.\n${payload}\nAfter.`;
    const extracted = extractSidecodeQuestions(text);
    assert.equal(extracted.invalid, true, payload);
    assert.equal(extracted.questions, undefined, payload);
    assert.doesNotMatch(extracted.text, /"questions"/, payload);
  }
  assert.equal(extractSidecodeQuestions('Before.\n{"questions":[]}\nAfter.').text, 'Before.\n\nAfter.');
  assert.equal(extractSidecodeQuestions('Before.\n{"questions": [}\nAfter.').text, 'Before.\n\nAfter.');
  assert.equal(extractSidecodeQuestions('Before.\n{"questions": [{"prompt":"Which?"').text, 'Before.');
  assert.equal(extractSidecodeQuestions('  {"questions":[]}\nAfter.').invalid, true);
});

test('inline prose and code samples that mention the payload stay untouched', () => {
  const inline = 'Before. {"questions":[]} After.';
  const inlineExtracted = extractSidecodeQuestions(inline);
  assert.equal(inlineExtracted.text, inline);
  assert.equal(inlineExtracted.invalid, undefined);

  const sample = [
    'Example:',
    '```ts',
    'const payload = {"questions":[{"prompt":"Which?"}]};',
    '{"questions":[]}',
    '```',
    'Done.'
  ].join('\n');
  const sampleExtracted = extractSidecodeQuestions(sample);
  assert.equal(sampleExtracted.text, sample);
  assert.equal(sampleExtracted.invalid, undefined);
  assert.equal(sampleExtracted.questions, undefined);
});

test('a code sample with an unbalanced line-start payload keeps its fence and prose', () => {
  const tsSample = ['Here is a broken sample:', '```ts', '{"questions": [', '```', 'That is wrong.'].join('\n');
  for (const fence of ['```ts', '```']) {
    const text = ['Here is a broken sample:', fence, '{"questions": [', '```', 'That is wrong.'].join('\n');
    const extracted = extractSidecodeQuestions(text);
    assert.equal(extracted.text, text, fence);
    assert.equal(extracted.invalid, undefined, fence);
    assert.equal(extracted.questions, undefined, fence);
    assert.equal(hideQuestionFence(text), text, fence);
    assert.equal(containsQuestionPayload(text), false, fence);
  }
  assert.equal(extractSidecodeQuestions(tsSample).text, tsSample);
});

test('a question fence with an unbalanced body is still removed', () => {
  const text = ['Before.', '```sidecode-question', '{"questions": [', '```', 'After.'].join('\n');
  const extracted = extractSidecodeQuestions(text);
  assert.equal(extracted.invalid, true);
  assert.equal(extracted.text, 'Before.\n\nAfter.');
});

test('a combined invalid and valid reply is stripped and the valid questions are queued', () => {
  const text = [
    'Before.',
    '{"questions":[]}',
    '```sidecode-question',
    JSON.stringify({ questions: [{ prompt: 'Which?', options: ['A'] }] }),
    '```',
    'After.'
  ].join('\n');
  const extracted = extractSidecodeQuestions(text);
  assert.equal(extracted.invalid, true);
  assert.equal(extracted.questions?.length, 1);
  assert.equal(extracted.questions?.[0]?.prompt, 'Which?');
  assert.equal(extracted.questions?.[0]?.id, 'q1');
  assert.equal(extracted.text, 'Before.\n\nAfter.');
});

test('containsQuestionPayload sees valid and malformed payloads but not prose or a code sample', () => {
  assert.equal(containsQuestionPayload('```sidecode-question\n{"questions":[]}\n```'), true);
  assert.equal(containsQuestionPayload('{"questions":[{"prompt":"Which?"}'), true);
  assert.equal(containsQuestionPayload('```json\n{"questions": oops}\n```'), true);
  assert.equal(containsQuestionPayload('```ts\nconst questions = ["a"];\n```'), false);
  assert.equal(containsQuestionPayload('Before. {"questions":[]} After.'), false);
  assert.equal(containsQuestionPayload('No payload here.'), false);
});

test('the malformed question notice is a warning that re-asks the question', () => {
  const notice = invalidQuestionNotice();
  assert.equal(notice.level, 'warning');
  assert.equal(notice.action, 'retryQuestion');
  assert.equal(notice.message, INVALID_QUESTION_MESSAGE);
  assert.match(questionRetryInstruction(), /re-ask the unanswered question/i);
  assert.match(questionRetryInstruction(), /valid JSON sidecode-question block/i);
  assert.doesNotMatch(questionRetryInstruction(), /do not ask/i);
});

test('a mixed reply with a valid card does not offer the question retry', () => {
  const notice = invalidQuestionNotice(false);
  assert.equal(notice.level, 'warning');
  assert.equal(notice.action, undefined);
  assert.equal(notice.message, INVALID_QUESTION_MESSAGE);
});

test('the ask-mode question notice is informational and names the other modes', () => {
  const notice = askModeQuestionNotice();
  assert.equal(notice.level, 'info');
  assert.equal(notice.message, ASK_MODE_QUESTION_MESSAGE);
  assert.match(notice.message, /Ask mode does not ask questions/);
  assert.match(notice.message, /Agent or Plan/);
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
  assert.match(SKIPPED_ANSWER, /do not assume an answer/i);
  assert.match(text, /re-ask this question/i);
  assert.match(text, /least-destructive option/i);
  assert.match(text, /state the assumption/i);
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

async function source(relative: string): Promise<string> {
  return readFile(join(process.cwd(), 'src', ...relative.split('/')), 'utf8');
}

test('the question retry action routes a fresh host turn, not a continuation', async () => {
  const [view, app, protocol] = await Promise.all([
    source('sidebarView.ts'),
    source('webview/App.tsx'),
    source('protocol.ts')
  ]);
  assert.match(protocol, /type: 'retryQuestion'/);
  assert.match(app, /type: 'retryQuestion'/);
  const retry = app.slice(app.indexOf('const retryQuestion'), app.indexOf('const runNoticeAction'));
  assert.doesNotMatch(retry, /continueAfterStopInstruction/);
  assert.match(view, /case 'retryQuestion':[\s\S]*?this\.sendTurn\([\s\S]*?questionRetryInstruction\(\)/);
});

test('a background question notice is held until that conversation is painted', async () => {
  const view = await source('sidebarView.ts');
  // A non-visible owner keeps the notice instead of letting the filtered post
  // drop it.
  assert.match(view, /owner !== this\.visible[\s\S]*?owner\.questionNotice = notice/);
  // The next conversation carries it, so the replay cannot replace it.
  assert.match(view, /message\.type === 'conversation'[\s\S]*?notice: this\.session\.questionNotice/);
  // Painting the tab clears it, so it is shown once.
  assert.match(view, /session\.questionNotice = undefined/);
});
