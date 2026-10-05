import assert from 'node:assert/strict';
import test from 'node:test';
import type { Attachment } from '../backends/types';
import { acceptComposerRestore, hostAttachments, switchComposerDraft } from './composerDraft.ts';

const image: Attachment = {
  id: 'a1',
  name: 'shot.png',
  path: '/w/shot.png',
  mimeType: 'image/png',
  kind: 'image',
  dataUrl: 'data:image/png;base64,aaaa'
};

test('switching tabs remembers the composer and restores the destination', () => {
  const first = switchComposerDraft({}, undefined, 'tab_a', { text: '', attachments: [] }, undefined);
  assert.equal(first.waitForHost, true);
  assert.equal(first.next.text, '');

  const second = switchComposerDraft(
    first.remembered,
    'tab_a',
    'tab_b',
    { text: 'keep me', attachments: [image] },
    undefined
  );
  assert.equal(second.remembered.tab_a?.text, 'keep me');
  assert.equal(second.remembered.tab_a?.attachments[0]?.id, 'a1');
  assert.equal(second.waitForHost, true);

  const back = switchComposerDraft(second.remembered, 'tab_b', 'tab_a', { text: '', attachments: [] }, undefined);
  assert.equal(back.next.text, 'keep me');
  assert.equal(back.next.attachments[0]?.name, 'shot.png');
  assert.equal(back.waitForHost, false);
});

test('a new chat copies the composer onto the destination and leaves the source', () => {
  const switched = switchComposerDraft(
    { tab_a: { text: 'old', attachments: [] } },
    'tab_a',
    'tab_b',
    { text: 'bring this', attachments: [image] },
    { text: 'bring this', attachments: [image] }
  );
  assert.equal(switched.carried, true);
  assert.equal(switched.next.text, 'bring this');
  assert.equal(switched.next.attachments[0]?.id, 'a1');
  assert.equal(switched.remembered.tab_a?.text, 'bring this');
  assert.notEqual(switched.next.attachments[0], image);
});

test('a host restore fills only a tab that has not been edited', () => {
  assert.equal(acceptComposerRestore({}, 'tab_a', false), true);
  assert.equal(acceptComposerRestore({}, 'tab_a', true), false);
  assert.equal(acceptComposerRestore({ tab_a: { text: 'typed', attachments: [] } }, 'tab_a', false), false);
});

test('inline image bytes are posted once', () => {
  const sent = new Set<string>();
  const first = hostAttachments([image], sent);
  assert.equal(first[0]?.dataUrl, image.dataUrl);
  const second = hostAttachments([image], sent);
  assert.equal(second[0]?.dataUrl, undefined);
  assert.equal(second[0]?.path, '/w/shot.png');
});
