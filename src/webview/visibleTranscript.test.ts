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

test('a user message without instructions is unchanged', () => {
  assert.equal(visibleTranscriptText('widen the autopilot modal'), 'widen the autopilot modal');
});
