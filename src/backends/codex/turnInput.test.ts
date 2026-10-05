import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexTurnInput } from './turnInput.ts';
import type { Attachment } from '../types.ts';

const image: Attachment = {
  id: 'a1',
  name: 'shot.png',
  path: 'C:\\work\\shot.png',
  mimeType: 'image/png',
  kind: 'image'
};

test('a later turn carries the workspace delta and the viewed file, and keeps the user text', () => {
  const [text] = buildCodexTurnInput({
    mode: 'agent',
    text: 'fix the header',
    bakedMode: 'agent',
    context: {
      snapshot: '<project-context>old</project-context>',
      delta: '<project-context-update>tree changed</project-context-update>',
      attachedFile: '<attached-file>src/app.ts</attached-file>'
    }
  });
  assert.equal(text.type, 'text');
  if (text.type !== 'text') {
    return;
  }
  assert.match(text.text, /Agent mode/);
  assert.match(text.text, /project-context-update/);
  assert.match(text.text, /src\/app\.ts/);
  assert.match(text.text, /fix the header/);
  assert.equal(text.text.includes('old'), false);
});

test('a re-primed turn sends the new snapshot as a replacement', () => {
  const [text] = buildCodexTurnInput({
    mode: 'agent',
    text: 'continue',
    bakedMode: 'agent',
    includeSnapshot: true,
    context: { snapshot: '<project-context>filtered</project-context>' }
  });
  assert.equal(text.type, 'text');
  if (text.type !== 'text') {
    return;
  }
  assert.match(text.text, /replaces the project context/);
  assert.match(text.text, /filtered/);
});

test('a mode switch tells the model to disregard the earlier mode', () => {
  const [text] = buildCodexTurnInput({
    mode: 'agent',
    text: 'implement it',
    bakedMode: 'plan'
  });
  assert.equal(text.type, 'text');
  if (text.type !== 'text') {
    return;
  }
  assert.match(text.text, /developer instruction that required Plan mode is revoked/);
  assert.match(text.text, /prohibited implementation/);
  assert.match(text.text, /active developer instruction for this turn is Agent mode/);
  assert.match(text.text, /Agent mode/);
});

test('a picked image is a localImage part and a clipboard image is an image url', () => {
  const input = buildCodexTurnInput({
    mode: 'agent',
    text: 'what is this',
    attachments: [
      image,
      {
        id: 'a2',
        name: 'clip.png',
        mimeType: 'image/png',
        kind: 'image',
        dataUrl: 'data:image/png;base64,aaaa'
      },
      { id: 'a3', name: 'notes.md', path: 'C:\\work\\notes.md', mimeType: 'text/markdown', kind: 'text' }
    ]
  });
  const text = input[0];
  assert.equal(text.type, 'text');
  if (text.type === 'text') {
    assert.match(text.text, /Image: shot\.png \(C:\\work\\shot\.png\)/);
    assert.match(text.text, /File: notes\.md \(C:\\work\\notes\.md\)/);
    assert.match(text.text, /what is this/);
  }
  assert.deepEqual(input[1], { type: 'localImage', path: 'C:\\work\\shot.png' });
  assert.deepEqual(input[2], { type: 'image', url: 'data:image/png;base64,aaaa' });
  assert.equal(input.length, 3);
});
