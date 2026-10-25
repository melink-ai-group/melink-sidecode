import test from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptItem } from './types.ts';
import {
  mergeOlderItems,
  newerThanLoaded,
  transcriptWithNewer,
  prependOlderHistory,
  revealStoredHistory,
  visibleHistory,
  withStoredHistory,
  withStoredUserIds
} from './historyWindow.ts';
import { mergeTranscriptTool } from './transcriptTool.ts';

test('an OpenCode tool keeps its completed paths and output when captured history is repainted', () => {
  const pending: TranscriptItem = { id: 'tool1', kind: 'file-change', files: [], text: '' };
  const complete = mergeTranscriptTool(pending, { id: 'tool1', kind: 'file-change', files: [{ path: 'src/a.ts' }], text: 'Edited successfully' });
  const repeated = mergeTranscriptTool(complete, { id: 'tool1', kind: 'file-change', files: [], text: '' });
  assert.deepEqual(repeated.files, [{ path: 'src/a.ts' }]);
  assert.equal(repeated.text, 'Edited successfully');
  const notice: TranscriptItem = { id: 'check1', kind: 'notice', detail: 'status', noticeLevel: 'info', text: 'Checked files.' };
  const replay = transcriptWithNewer([item('old'), pending], [complete, notice]);
  assert.deepEqual(replay, [item('old'), complete, notice]);
  assert.deepEqual(transcriptWithNewer(replay, [complete, notice]), replay);
});

function item(id: string, role?: 'user' | 'assistant', text = id): TranscriptItem {
  return { id, kind: 'message', role, text, status: 'completed' };
}

test('a resumed chat keeps every stored turn the provider did not replay', () => {
  const stored = [
    item('user-old', 'user', 'old prompt'),
    item('reply-old', 'assistant', 'old reply'),
    item('user-new', 'user', 'new prompt'),
    item('reason-new'),
    item('reply-new', 'assistant', 'new reply')
  ];
  const server = [item('user-new', 'user', 'new prompt'), item('reason-new'), item('reply-new', 'assistant', 'new reply')];
  assert.deepEqual(
    withStoredHistory(server, stored).map((entry) => entry.id),
    ['user-old', 'reply-old', 'user-new', 'reason-new', 'reply-new']
  );
});

test('a full provider replay is not duplicated by the stored copy', () => {
  const stored = [item('u1', 'user', 'first'), item('a1', 'assistant', 'done')];
  const server = [item('server-u1', 'user', 'first'), item('a1', 'assistant', 'done')];
  const merged = withStoredHistory(server, stored);
  assert.deepEqual(
    merged.map((entry) => entry.id),
    ['u1', 'a1']
  );
});

test('a provider window that starts inside a turn keeps the stored prompt above it', () => {
  const stored = [item('u1', 'user', 'do the work'), item('reason'), item('tool')];
  stored[1].kind = 'reasoning';
  const server = [item('reason'), item('tool')];
  assert.deepEqual(
    withStoredHistory(server, stored).map((entry) => entry.id),
    ['u1', 'reason', 'tool']
  );
});

test('scrolling up reveals the next stored page without dropping the suffix', () => {
  const items = Array.from({ length: 10 }, (_, index) => item(`m${index}`));
  const revealed = revealStoredHistory(items, 8, 3);
  assert.equal(revealed.hidden, 5);
  assert.deepEqual(
    revealed.added.map((entry) => entry.id),
    ['m5', 'm6', 'm7']
  );
  assert.deepEqual(
    visibleHistory(items, revealed.hidden).map((entry) => entry.id),
    ['m5', 'm6', 'm7', 'm8', 'm9']
  );
});

test('a server user row keeps the stored message id so a checkpoint still addresses it', () => {
  const server = [item('server-user', 'user', 'fix the scroll'), item('reason', undefined, 'thinking')];
  server[1].kind = 'reasoning';
  const stored = [item('user_1', 'user', 'older prompt'), item('user_2', 'user', 'fix the scroll')];
  const merged = withStoredUserIds(server, stored);
  assert.equal(merged[0]?.id, 'user_2');
  assert.equal(merged[1]?.id, 'reason');
  assert.equal(
    merged.some((entry) => entry.id === 'user_1'),
    false
  );
});

test('a provider attachment list matches the stored prompt and keeps its files', () => {
  const server = [
    item(
      'server-user',
      'user',
      'Attached files:\nImage: image.png\n\nI have innovate running and disabled "Tests".'
    )
  ];
  const stored = [
    {
      ...item('user_2', 'user', 'I have innovate running and disabled "Tests".'),
      attachments: [{ id: 'a1', name: 'image.png', path: 'C:\\work\\image.png', mimeType: 'image/png', kind: 'image' as const }]
    }
  ];
  const merged = withStoredUserIds(server, stored);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.id, 'user_2');
  assert.equal(merged[0]?.text, 'I have innovate running and disabled "Tests".');
  assert.equal(merged[0]?.attachments?.[0]?.path, 'C:\\work\\image.png');
});

test('a stored turn duration stays on the matching server user row', () => {
  const server = [item('server-user', 'user', 'fix the scroll')];
  const stored = [{ ...item('user_2', 'user', 'fix the scroll'), sentAt: 1_700_000_000_000, workedMs: 110_000 }];
  const merged = withStoredUserIds(server, stored);
  assert.equal(merged[0]?.id, 'user_2');
  assert.equal(merged[0]?.sentAt, 1_700_000_000_000);
  assert.equal(merged[0]?.workedMs, 110_000);
});

test('a user message sent after the server snapshot stays at the end', () => {
  const server = [item('server-user', 'user', 'first')];
  const stored = [item('user_1', 'user', 'first'), item('user_2', 'user', 'second')];
  const merged = withStoredUserIds(server, stored);
  assert.deepEqual(
    merged.map((entry) => entry.id),
    ['user_1', 'user_2']
  );
});

test('a repeated message sent after a snapshot keeps its own id across reloads', () => {
  const stored = [item('user_1', 'user', 'continue'), item('user_2', 'user', 'continue')];
  const replay = withStoredHistory([item('server-user', 'user', 'continue')], stored);
  assert.deepEqual(replay.map((entry) => entry.id), ['user_1', 'user_2']);
  assert.deepEqual(withStoredHistory(replay, replay), replay);
});

test('a coalesced provider prompt restores the recorded message boundaries and metadata', () => {
  const stored = [
    { ...item('user_1', 'user', 'first request'), sentAt: 123, workedMs: 456 },
    { ...item('user_2', 'user', 'a follow-up'), orchestration: true },
    item('user_3', 'user', 'another follow-up')
  ];
  const server = [item('server-user', 'user', 'first request\na follow-up\nanother follow-up'), item('reply', 'assistant', 'done')];
  const replay = withStoredHistory(server, stored);
  assert.deepEqual(replay, [...stored, server[1]]);
  assert.deepEqual(withStoredHistory(server, replay), replay);
});

test('legacy injected notices do not prevent restored user ids from matching', () => {
  const stored = [item('user_1', 'user', 'check it')];
  const server = [item('server-user', 'user', 'Repo map: disabled (melink.context.repoMap is off).\n\ncheck it')];
  assert.deepEqual(withStoredHistory(server, stored), stored);
});

test('older pages prepend unseen rows and reveal one page', () => {
  const items = [item('keep', 'assistant', 'visible')];
  const older = [item('user-old', 'user', 'earlier'), item('reason'), item('keep', 'assistant', 'visible')];
  older[1].kind = 'reasoning';
  const page = prependOlderHistory(items, 0, older, 10);
  assert.deepEqual(
    page.items.map((entry) => entry.id),
    ['user-old', 'reason', 'keep']
  );
  assert.equal(page.hidden, 0);
  assert.deepEqual(
    page.added.map((entry) => entry.id),
    ['user-old', 'reason']
  );
});

test('a repeated user prompt from the server is not painted twice', () => {
  const existing = [item('user_1', 'user', 'same text')];
  const merged = mergeOlderItems(existing, [item('server-user', 'user', 'same text'), item('older', 'assistant', 'before')]);
  assert.deepEqual(
    merged.map((entry) => entry.id),
    ['older', 'user_1']
  );
});

test('turns recorded after the snapshot stay after it', () => {
  const loaded = [item('a', 'assistant', 'done')];
  const stored = [item('old', 'user', 'before'), item('a', 'assistant', 'done'), item('new', 'user', 'after')];
  assert.deepEqual(
    newerThanLoaded(loaded, stored).map((entry) => entry.id),
    ['new']
  );
});
