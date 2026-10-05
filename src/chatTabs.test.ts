import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TAB_TITLE, parseChatTabState, reorderById, resolveChatTarget, tabTitle, TAB_TITLE_LIMIT } from './chatTabs.ts';

test('an empty message keeps the SideCode tab title', () => {
  assert.equal(tabTitle(undefined), DEFAULT_TAB_TITLE);
  assert.equal(tabTitle(''), DEFAULT_TAB_TITLE);
  assert.equal(tabTitle('   \n  '), DEFAULT_TAB_TITLE);
});

test('a tab title uses the first line and cuts a long one', () => {
  assert.equal(tabTitle('  Fix the login\nmore detail  '), 'Fix the login');
  const line = 'a'.repeat(TAB_TITLE_LIMIT + 12);
  assert.equal(tabTitle(`${line}\nsecond`), `${'a'.repeat(TAB_TITLE_LIMIT)}...`);
});

test('a new chat reveals a blank tab and a history pick reveals the open thread', () => {
  const tabs = [
    { blank: false, backendId: 'ollama', threadId: 'thread_a' },
    { blank: true }
  ];
  assert.deepEqual(resolveChatTarget(tabs, { kind: 'new' }), { action: 'reveal', index: 1 });
  assert.deepEqual(resolveChatTarget(tabs, { kind: 'thread', backendId: 'ollama', threadId: 'thread_a' }), {
    action: 'reveal',
    index: 0
  });
  assert.deepEqual(resolveChatTarget(tabs, { kind: 'thread', backendId: 'codex', threadId: 'thread_b' }), {
    action: 'create'
  });
  assert.deepEqual(resolveChatTarget([{ blank: false, backendId: 'ollama', threadId: 'thread_a' }], { kind: 'new' }), {
    action: 'create'
  });
});

test('dragging a tab moves it and leaves a no-op drop alone', () => {
  const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(reorderById(tabs, 'a', 2)?.map((tab) => tab.id), ['b', 'c', 'a']);
  assert.deepEqual(reorderById(tabs, 'c', 0)?.map((tab) => tab.id), ['c', 'a', 'b']);
  assert.equal(reorderById(tabs, 'b', 1), undefined);
  assert.equal(reorderById(tabs, 'missing', 0), undefined);
});

test('restored tab state resumes a thread and treats anything else as blank', () => {
  assert.deepEqual(parseChatTabState(undefined), { blank: true });
  assert.deepEqual(parseChatTabState({ backendId: 'ollama', threadId: 'thread_a', title: 'Fix the login' }), {
    blank: false,
    backendId: 'ollama',
    threadId: 'thread_a',
    title: 'Fix the login'
  });
});

test('restored tab state keeps the unsent composer and drops file bytes', () => {
  assert.deepEqual(
    parseChatTabState({
      blank: true,
      draftText: 'finish this',
      draftAttachments: [
        { id: 'a1', name: 'shot.png', path: '/w/shot.png', mimeType: 'image/png', kind: 'image', dataUrl: 'data:image/png;base64,aaaa' },
        { id: 'bad', name: 'nope.txt', mimeType: 'text/plain', kind: 'other' }
      ]
    }),
    {
      blank: true,
      draftText: 'finish this',
      draftAttachments: [{ id: 'a1', name: 'shot.png', path: '/w/shot.png', mimeType: 'image/png', kind: 'image' }]
    }
  );
});
