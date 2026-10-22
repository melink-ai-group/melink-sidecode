import test from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptItem } from './types.ts';
import { WORKSPACE_TAIL_ITEMS, workspaceTranscriptIndex, workspaceTranscriptTail } from './transcriptTail.ts';

test('the workspace tail keeps the latest rows and drops bulky tool text', () => {
  const items = Array.from({ length: WORKSPACE_TAIL_ITEMS + 4 }, (_, index) => item(`m${index}`));
  items.push({
    id: 'tool',
    kind: 'tool',
    text: 'x'.repeat(20_000),
    command: 'y'.repeat(5_000),
    files: [{ path: 'src/a.ts', lines: [{ kind: 'context', text: 'secret' }] }],
    attachments: [{ id: 'a', name: 'shot.png', mimeType: 'image/png', kind: 'image', dataUrl: 'data:image/png;base64,aaaa' }]
  });
  const tail = workspaceTranscriptTail(items);
  assert.equal(tail.length, WORKSPACE_TAIL_ITEMS);
  assert.equal(tail[0]?.id, 'm5');
  const tool = tail[tail.length - 1];
  assert.equal(tool?.text?.length, 1_000);
  assert.equal(tool?.command?.length, 1_000);
  assert.equal(tool?.files?.[0]?.path, 'src/a.ts');
  assert.equal(tool?.files?.[0]?.lines, undefined);
  assert.equal(tool?.attachments?.[0]?.dataUrl, undefined);
  assert.equal(tool?.attachments?.[0]?.name, 'shot.png');
  assert.equal(items[items.length - 1]?.text?.length, 20_000);
});

test('a thread stays intact in workspace state until its file write succeeds', () => {
  const full = [item('keep', 'the whole chat')];
  const disk = [item('disk', 'full file')];
  const next = workspaceTranscriptIndex(
    { 'codex:full': full, 'codex:disk': disk },
    new Set(['codex:disk']),
    { 'codex:full': full }
  );
  assert.equal(next['codex:full']?.[0]?.text, 'the whole chat');
  assert.equal(next['codex:disk']?.[0]?.id, 'disk');
  assert.notEqual(next['codex:full'], full);
});

function item(id: string, text = id): TranscriptItem {
  return { id, kind: 'message', role: 'user', text, status: 'completed' };
}
