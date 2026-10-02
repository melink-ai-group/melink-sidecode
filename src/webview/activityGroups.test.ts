import test from 'node:test';
import assert from 'node:assert/strict';
import { activitySummary, groupTranscript } from './activityGroups.ts';
import type { TranscriptItemView } from './state.ts';

function row(partial: Partial<TranscriptItemView> & Pick<TranscriptItemView, 'id'>): TranscriptItemView {
  return {
    kind: 'tool',
    text: '',
    status: 'completed',
    ...partial
  };
}

test('a mixed lookup burst is one line with file and search counts', () => {
  const entries = groupTranscript([
    row({ id: 'r1', title: 'Reading App.tsx' }),
    row({ id: 'r2', title: 'Reading state.ts' }),
    row({ id: 'r3', title: 'Listing src' }),
    row({ id: 'g1', title: 'Searching for token' }),
    row({ id: 'g2', tool: 'glob', title: 'Finding files **/*.ts' }),
    row({ id: 'w1', kind: 'notice', title: 'Web search', text: 'activity groups' })
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'group');
  if (entries[0].kind !== 'group') {
    return;
  }
  assert.equal(entries[0].id, 'r1');
  assert.equal(entries[0].family, 'lookup');
  assert.equal(entries[0].items.length, 6);
  assert.equal(activitySummary(entries[0].items).label, 'Explored 3 files, 3 searches');
  assert.equal(activitySummary(entries[0].items).status, 'completed');
});

test('a message or reasoning card splits a lookup burst', () => {
  const entries = groupTranscript([
    row({ id: 'r1', tool: 'read', title: 'Reading a.ts' }),
    row({ id: 'r2', tool: 'grep', title: 'Searching for token' }),
    row({ id: 'm1', kind: 'message', role: 'assistant', title: 'Agent', text: 'Found it.' }),
    row({ id: 'think', kind: 'reasoning', title: 'Reasoning', text: 'Next I will read the test.' }),
    row({ id: 'r3', tool: 'read', title: 'Reading b.ts' }),
    row({ id: 'r4', tool: 'read', title: 'Reading c.ts' })
  ]);
  assert.deepEqual(
    entries.map((entry) => (entry.kind === 'group' ? `group:${entry.id}` : entry.item.id)),
    ['group:r1', 'm1', 'think', 'group:r3']
  );
});

test('a single tool stays unwrapped', () => {
  const entries = groupTranscript([row({ id: 'r1', title: 'Reading App.tsx' })]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'item');
});

test('edits and commands form their own bursts and a family change starts a new line', () => {
  const entries = groupTranscript([
    row({ id: 'e1', title: 'Editing a.ts' }),
    row({
      id: 'e2',
      kind: 'file-change',
      title: 'Edited',
      files: [
        { path: 'b.ts' },
        { path: 'c.ts' }
      ]
    }),
    row({ id: 'c1', title: 'Running npm test' }),
    row({ id: 'c2', tool: 'bash', title: 'Running npm run build' })
  ]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, 'group');
  assert.equal(entries[1].kind, 'group');
  if (entries[0].kind !== 'group' || entries[1].kind !== 'group') {
    return;
  }
  assert.equal(entries[0].family, 'change');
  assert.equal(activitySummary(entries[0].items).label, 'Edited 3 files');
  assert.equal(entries[1].family, 'command');
  assert.equal(activitySummary(entries[1].items).label, 'Ran 2 commands');
});

test('deletes alone and mixed with edits use their own wording', () => {
  const deleted = groupTranscript([
    row({ id: 'd1', title: 'Deleting old.ts' }),
    row({ id: 'd2', tool: 'remove', title: 'Deleting tmp.ts' })
  ]);
  assert.equal(deleted[0].kind, 'group');
  if (deleted[0].kind === 'group') {
    assert.equal(activitySummary(deleted[0].items).label, 'Deleted 2 files');
  }

  const mixed = groupTranscript([
    row({ id: 'e1', title: 'Writing notes.md' }),
    row({ id: 'd1', title: 'Deleting old.ts' })
  ]);
  assert.equal(mixed[0].kind, 'group');
  if (mixed[0].kind === 'group') {
    assert.equal(activitySummary(mixed[0].items).label, 'Changed 2 files');
  }
});

test('a pending approval stays outside the burst', () => {
  const entries = groupTranscript([
    row({ id: 'c1', title: 'Running npm test' }),
    row({ id: 'c2', title: 'Running npm run lint' }),
    row({ id: 'req', kind: 'approval-requested', title: 'Approval needed', text: 'Allow npm test', status: 'pending' }),
    row({ id: 'c3', title: 'Running git status' })
  ]);
  assert.deepEqual(
    entries.map((entry) => (entry.kind === 'group' ? entry.id : entry.item.id)),
    ['c1', 'req', 'c3']
  );
  assert.equal(entries[1].kind, 'item');
});

test('a running burst uses the live wording and a failure wins the status', () => {
  const running = [
    row({ id: 'r1', title: 'Reading a.ts', status: 'completed' }),
    row({ id: 'r2', title: 'Searching for token', status: 'streaming' })
  ];
  assert.deepEqual(activitySummary(running), { label: 'Exploring…', status: 'streaming' });

  const failed = [
    row({ id: 'e1', title: 'Editing a.ts', status: 'completed' }),
    row({ id: 'e2', title: 'Editing b.ts', status: 'failed' })
  ];
  assert.equal(activitySummary(failed).label, 'Edited 2 files');
  assert.equal(activitySummary(failed).status, 'failed');

  const deleting = [
    row({ id: 'd1', title: 'Deleting a.ts', status: 'streaming' }),
    row({ id: 'd2', tool: 'delete', title: 'Deleting b.ts', status: 'pending' })
  ];
  assert.equal(activitySummary(deleting).label, 'Deleting…');
});

test('the group id stays the first child as later tools join the same run', () => {
  const first = groupTranscript([
    row({ id: 'r1', tool: 'read' }),
    row({ id: 'r2', tool: 'grep' })
  ]);
  const later = groupTranscript([
    row({ id: 'r1', tool: 'read' }),
    row({ id: 'r2', tool: 'grep' }),
    row({ id: 'r3', tool: 'glob' })
  ]);
  assert.equal(first[0].kind, 'group');
  assert.equal(later[0].kind, 'group');
  if (first[0].kind === 'group' && later[0].kind === 'group') {
    assert.equal(later[0].id, first[0].id);
    assert.equal(later[0].id, 'r1');
    assert.equal(later[0].items.length, 3);
  }
});

test('an unknown tool is its own line and splits the neighbors', () => {
  const entries = groupTranscript([
    row({ id: 'r1', title: 'Reading a.ts' }),
    row({ id: 't1', tool: 'todowrite', title: 'TodoWrite' }),
    row({ id: 'r2', title: 'Reading b.ts' })
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ['item', 'item', 'item']
  );
});
