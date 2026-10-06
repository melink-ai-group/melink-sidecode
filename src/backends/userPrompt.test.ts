import test from 'node:test';
import assert from 'node:assert/strict';
import { takeAttachmentSection } from './userPrompt.ts';

test('a restored provider turn keeps the user words and the named files', () => {
  const raw = [
    'Work in Agent mode. Act on the workspace.',
    '',
    'Attached files:',
    'Image: image.png',
    'File: notes.md (C:\\work\\notes.md)',
    '',
    'I have innovate running and disabled "Tests".'
  ].join('\n');
  const recovered = takeAttachmentSection(raw);
  assert.equal(recovered.text, 'Work in Agent mode. Act on the workspace.\n\nI have innovate running and disabled "Tests".');
  assert.equal(recovered.attachments[0]?.name, 'image.png');
  assert.equal(recovered.attachments[0]?.kind, 'image');
  assert.equal(recovered.attachments[0]?.path, undefined);
  assert.equal(recovered.attachments[1]?.name, 'notes.md');
  assert.equal(recovered.attachments[1]?.path, 'C:\\work\\notes.md');
});

test('a user message that never listed files is unchanged', () => {
  const recovered = takeAttachmentSection('Please check the types of innovate allowed.');
  assert.equal(recovered.text, 'Please check the types of innovate allowed.');
  assert.deepEqual(recovered.attachments, []);
});
