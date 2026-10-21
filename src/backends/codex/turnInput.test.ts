import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexTurnInput, planEscapeInstructions } from './turnInput.ts';
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

test('a later turn carries the repo map next to the delta', () => {
  const [text] = buildCodexTurnInput({
    mode: 'agent',
    text: 'fix login',
    bakedMode: 'agent',
    context: {
      delta: '<project-context-update>tree changed</project-context-update>',
      repoMap: 'Repo map: src/auth.ts: login, logout'
    }
  });
  assert.equal(text.type, 'text');
  if (text.type !== 'text') {
    return;
  }
  assert.match(text.text, /project-context-update/);
  assert.match(text.text, /Repo map: src\/auth\.ts: login, logout/);
  assert.ok(
    text.text.indexOf('project-context-update') < text.text.indexOf('Repo map:'),
    'the repo map follows the delta'
  );
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

test('leaving a resumed Plan thread says the old restriction is finished', () => {
  const [text] = buildCodexTurnInput({
    mode: 'agent',
    text: 'implement the plan',
    revokePlan: true
  });
  assert.equal(text.type, 'text');
  if (text.type !== 'text') {
    return;
  }
  assert.match(text.text, /required Plan mode is revoked/);
  assert.match(text.text, /Agent mode/);
});

test('the fork instruction ends the Plan restriction and keeps the snapshot', () => {
  const text = planEscapeInstructions('<project-context>repo</project-context>');
  assert.match(text, /prohibited implementation/);
  assert.match(text, /earlier refusal/);
  assert.match(text, /Those rules are finished/);
  assert.match(text, /project-context/);
  assert.equal(text.includes('Do not implement'), false);
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

test('an acting turn carries the frontend checklist for its detected stack', () => {
  for (const mode of ['agent', 'plan'] as const) {
    const [text] = buildCodexTurnInput({
      mode,
      text: 'build the page',
      frontendStack: 'react'
    });
    assert.equal(text.type, 'text');
    if (text.type === 'text') {
      assert.match(text.text, /Frontend checklist/);
      assert.match(text.text, /state and effects/i);
      assert.match(text.text, /build the page/);
    }
  }
});

test('Ask and a non-frontend turn keep the base instructions only', () => {
  const [ask] = buildCodexTurnInput({
    mode: 'ask',
    text: 'what does this do',
    frontendStack: 'next'
  });
  const [none] = buildCodexTurnInput({
    mode: 'agent',
    text: 'refactor the parser',
    frontendStack: 'none'
  });
  for (const text of [ask, none]) {
    assert.equal(text.type, 'text');
    if (text.type === 'text') {
      assert.equal(text.text.includes('Frontend checklist'), false);
    }
  }
});
