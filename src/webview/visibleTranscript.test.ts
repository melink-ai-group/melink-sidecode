import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleTranscriptText } from './visibleTranscript.ts';

const MODE =
  'Work in Agent mode. The available modes are Agent (act on the workspace), Plan (investigate and write a plan document, revising it only when the user asks), and Ask (answer questions without acting).';

test('mode instructions and a project-context block are hidden, and the reply remains', () => {
  const text = [
    MODE,
    '',
    '<project-context>',
    'Project context from the editor. Purpose (from AGENTS.md): load DESIGN.md.',
    '</project-context>',
    '',
    'The modal uses two columns on a wide screen.'
  ].join('\n');
  assert.equal(visibleTranscriptText(text), 'The modal uses two columns on a wide screen.');
});

test('a message that is only the injected prompt renders as nothing', () => {
  const text = `${MODE}\n\n<project-context>Project name: acme-app.</project-context>`;
  assert.equal(visibleTranscriptText(text), '');
});

test('an unclosed context block at the start of an echoed prompt is hidden', () => {
  const text = `${MODE}\n\n<project-context>\nProject context from the editor.`;
  assert.equal(visibleTranscriptText(text), '');
});

test('a real answer that mentions the tag later is kept', () => {
  const text = 'The snapshot marker is <project-context> and it stays open in this sentence.';
  assert.equal(visibleTranscriptText(text), text);
});

test('an attached-files section is hidden and the user words remain', () => {
  const text = ['Attached files:', 'Image: image.png', '', 'I have innovate running and disabled "Tests".'].join('\n');
  assert.equal(visibleTranscriptText(text), 'I have innovate running and disabled "Tests".');
});

test('a user message without instructions is unchanged', () => {
  assert.equal(visibleTranscriptText('widen the autopilot modal'), 'widen the autopilot modal');
});

test('an echoed viewed-file notice is hidden and the reply remains', () => {
  const text = [
    'Current file: not attached. The user did not include the file they are viewing. Do not treat any other file as "this file".',
    '',
    'For the Ideas creation, project ideas should only show on the projects page.'
  ].join('\n');
  assert.equal(
    visibleTranscriptText(text),
    'For the Ideas creation, project ideas should only show on the projects page.'
  );
});

test('a tagged attached-file block is hidden even when the model echoes it', () => {
  const text = [
    '<attached-file>',
    'Current file: not attached. The user did not include the file they are viewing. Do not treat any other file as "this file".',
    '</attached-file>',
    '',
    'Here is the plan.'
  ].join('\n');
  assert.equal(visibleTranscriptText(text), 'Here is the plan.');
});

test('every mode hides a question fence, including ask', () => {
  const text = 'Before the plan.\n```sidecode-question\n{"questions":[{"prompt":"Which?","options":["A","B"]}]}\n```';
  assert.equal(visibleTranscriptText(text), 'Before the plan.');
  assert.doesNotMatch(visibleTranscriptText(text), /sidecode-question/);
});

test('every mode hides a bare or malformed question payload and keeps the sentence after it', () => {
  const text = [
    'I have enough context to plan.',
    '',
    '{"questions":[{"prompt":"Which layout?","options":["Two columns","Single column"]}]}',
    '',
    'I need these answers before writing the plan.'
  ].join('\n');
  assert.equal(
    visibleTranscriptText(text),
    'I have enough context to plan.\n\nI need these answers before writing the plan.'
  );
  assert.doesNotMatch(visibleTranscriptText(text), /"questions"/);
  const malformed = 'Before.\n```sidecode-question\nnot json\n```\nAfter.';
  assert.equal(visibleTranscriptText(malformed), 'Before.\n\nAfter.');
  assert.equal(visibleTranscriptText('Before.\n{"questions":[]}\nAfter.'), 'Before.\n\nAfter.');
  assert.equal(visibleTranscriptText('Before.\n{"questions": [}\nAfter.'), 'Before.\n\nAfter.');
  assert.equal(visibleTranscriptText('Before.\n{"questions": [{"prompt":"Which?"'), 'Before.');
  assert.equal(
    visibleTranscriptText('Before. {"questions":[]} After.'),
    'Before. {"questions":[]} After.'
  );
});

test('a real answer that says "this file" is kept', () => {
  const text = 'Open this file in the editor and check the layout.';
  assert.equal(visibleTranscriptText(text), text);
});
