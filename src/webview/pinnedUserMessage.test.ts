import test from 'node:test';
import assert from 'node:assert/strict';
import { pinnedUserMessage, pinnedUserPreview, userMessagePinText } from './pinnedUserMessage.ts';

test('nothing is pinned before a user message reaches the top', () => {
  assert.equal(
    pinnedUserMessage([
      { id: 'a', top: 20, bottom: 80 },
      { id: 'b', top: 400, bottom: 460 }
    ]),
    undefined
  );
});

test('a user message still on screen stays full instead of pinning', () => {
  assert.equal(pinnedUserMessage([{ id: 'a', top: -40, bottom: 30 }]), undefined);
});

test('the latest user message that has scrolled past the top is the one pinned', () => {
  assert.equal(
    pinnedUserMessage([
      { id: 'a', top: -800, bottom: -700 },
      { id: 'b', top: -120, bottom: -20 },
      { id: 'c', top: 240, bottom: 300 }
    ]),
    'b'
  );
});

test('a message sitting just under the top is shown in full', () => {
  assert.equal(
    pinnedUserMessage([
      { id: 'a', top: -400, bottom: -40 },
      { id: 'b', top: 8, bottom: 80 }
    ]),
    undefined
  );
});

test('scrolling back onto a message releases it and pins the previous one', () => {
  assert.equal(
    pinnedUserMessage([
      { id: 'a', top: -500, bottom: -40 },
      { id: 'b', top: 12, bottom: 90 }
    ]),
    'a'
  );
});

test('a message entering from the top is shown in full, not as a second pin', () => {
  assert.equal(
    pinnedUserMessage([
      { id: 'a', top: -600, bottom: -80 },
      { id: 'b', top: -10, bottom: 70 }
    ]),
    undefined
  );
});

test('the preview keeps a short message and cuts a long one on a word', () => {
  assert.equal(pinnedUserPreview('Fix the pin'), 'Fix the pin');
  const words = Array.from({ length: 80 }, (_, index) => `word${index}`);
  const preview = pinnedUserPreview(words.join(' '), 40);
  assert.ok(preview.length <= 40);
  assert.equal(preview.endsWith(' '), false);
  assert.match(preview, /^word0\b/);
});

test('a message with only attachments pins their names', () => {
  assert.equal(userMessagePinText('', ['shot.png', 'notes.md']), 'shot.png, notes.md');
  assert.equal(userMessagePinText('   ', []), 'Your message');
  assert.equal(userMessagePinText('Hello **there**', ['shot.png']), 'Hello there');
});
