import test from 'node:test';
import assert from 'node:assert/strict';
import { activitySections, activitySummary, groupTranscript, speakerRows, toolBursts, type TranscriptEntry } from './activityGroups.ts';
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

test('a thought used as the row title drops markdown markers', () => {
  const summary = activitySummary([
    row({ id: 't1', kind: 'reasoning', text: '**Adding tests**' }),
    row({ id: 'c1', title: 'Running npm test' })
  ]);
  assert.equal(summary.label, 'Adding tests');
  assert.equal(summary.detail, 'Ran 1 command');
});

test('a message starts a new line and reasoning stays inside the investigation', () => {
  const entries = groupTranscript([
    row({ id: 'r1', tool: 'read', title: 'Reading a.ts' }),
    row({ id: 'r2', tool: 'grep', title: 'Searching for token' }),
    row({ id: 'm1', kind: 'message', role: 'assistant', title: 'Agent', text: 'Found it.' }),
    row({ id: 'think', kind: 'reasoning', title: 'Reasoning', text: 'Next I will read the test.' }),
    row({ id: 'r3', tool: 'read', title: 'Reading b.ts' }),
    row({ id: 'r4', tool: 'read', title: 'Reading c.ts' })
  ]);
  assert.deepEqual(entries.map(entryKey), ['group:r1', 'narration:m1']);
  const narration = entries[1];
  assert.equal(narration.kind, 'narration');
  if (narration.kind === 'narration') {
    assert.deepEqual(
      narration.items.map((item) => item.id),
      ['think', 'r3', 'r4']
    );
  }
});

test('a single tool stays unwrapped', () => {
  const entries = groupTranscript([row({ id: 'r1', title: 'Reading App.tsx' })]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'item');
});

test('lookups, commands, and reasoning are one line until an edit', () => {
  const entries = groupTranscript([
    row({ id: 't1', kind: 'reasoning', text: 'Let me explore the repo structure.' }),
    row({ id: 'r1', title: 'Reading app.py' }),
    row({ id: 'g1', title: 'Searching for users' }),
    row({ id: 't2', kind: 'reasoning', text: 'Let me check the deployed endpoint.' }),
    row({ id: 'c1', title: 'Running curl https://example.test' }),
    row({ id: 'c2', title: 'Running curl -I https://example.test' }),
    row({ id: 't3', kind: 'reasoning', text: 'The route redirects.' }),
    row({ id: 'r2', title: 'Reading routes.py' }),
    row({ id: 'e1', title: 'Editing routes.py' })
  ]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, 'group');
  assert.equal(entries[1].kind, 'item');
  if (entries[0].kind !== 'group') {
    return;
  }
  assert.equal(entries[0].id, 't1');
  assert.equal(entries[0].family, 'work');
  assert.equal(activitySummary(entries[0].items).label, 'The route redirects.');
  assert.equal(activitySummary(entries[0].items).detail, 'Explored 2 files, 1 search, ran 2 commands');
  const sections = activitySections(entries[0].items);
  assert.equal(sections.length, 3);
  assert.equal(sections[1].reasoning?.id, 't2');
  assert.deepEqual(
    toolBursts(sections[1].tools).map((burst) => burst.family),
    ['command']
  );
});

test('edits stay their own line after an investigation', () => {
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
    entries.map((entry) => (entry.kind === 'item' ? entry.item.id : entry.id)),
    ['c1', 'req', 'c3']
  );
  assert.equal(entries[1].kind, 'item');
});

test('a running investigation shows the latest thought', () => {
  const summary = activitySummary([
    row({ id: 't1', kind: 'reasoning', text: 'Let me explore the repo structure.', status: 'completed' }),
    row({ id: 'r1', title: 'Reading app.py', status: 'completed' }),
    row({ id: 't2', kind: 'reasoning', text: 'Let me check the endpoint.', status: 'streaming' })
  ]);
  assert.equal(summary.label, 'Let me check the endpoint.');
  assert.equal(summary.detail, 'Explored 1 file');
  assert.equal(summary.status, 'streaming');
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

function entryKey(entry: TranscriptEntry): string {
  if (entry.kind === 'group') {
    return `group:${entry.id}`;
  }
  if (entry.kind === 'narration') {
    return `narration:${entry.id}`;
  }
  return entry.item.id;
}

test('a one-line reply holds the following lookups and a later reply starts the next line', () => {
  const entries = groupTranscript([
    row({ id: 'a1', kind: 'message', role: 'assistant', text: 'Let me read the key files to understand the current structure.' }),
    row({ id: 'r1', title: 'Reading Settings.tsx' }),
    row({ id: 'r2', title: 'Reading Tabs.tsx' }),
    row({ id: 'r3', title: 'Reading styles.css' }),
    row({ id: 'a2', kind: 'message', role: 'assistant', text: 'Let me examine the tab navigation.' }),
    row({ id: 'g1', title: 'Searching for tab' }),
    row({ id: 'g2', title: 'Searching for nav' }),
    row({ id: 'a3', kind: 'message', role: 'assistant', text: 'The tabs need a shared label.\n\nI would put it in the header.' })
  ]);
  assert.deepEqual(entries.map(entryKey), ['narration:a1', 'narration:a2', 'a3']);
});

test('a one-line reply does not swallow an edit', () => {
  const entries = groupTranscript([
    row({ id: 'a1', kind: 'message', role: 'assistant', text: 'I will update the header.' }),
    row({ id: 'e1', title: 'Editing Header.tsx' })
  ]);
  assert.deepEqual(entries.map(entryKey), ['a1', 'e1']);
});

test('melink is marked on the first reply, and on the last only once the turn has settled', () => {
  const entries = groupTranscript([
    row({ id: 'u', kind: 'message', role: 'user', text: 'look at settings' }),
    row({ id: 'a1', kind: 'message', role: 'assistant', text: 'I will look at the settings pages.' }),
    row({ id: 'r1', title: 'Reading a.ts' }),
    row({ id: 'r2', title: 'Reading b.ts' }),
    row({ id: 'a2', kind: 'message', role: 'assistant', text: 'Let me read the next files.' }),
    row({ id: 'r3', title: 'Reading c.ts' }),
    row({ id: 'a3', kind: 'message', role: 'assistant', text: 'Done.\n\nThe header can carry the name.' })
  ]);
  const running = speakerRows(entries, false);
  assert.equal(running.has('a1'), true);
  assert.equal(running.has('a2'), false);
  assert.equal(running.has('a3'), false);
  const settled = speakerRows(entries, true);
  assert.equal(settled.has('a1'), true);
  assert.equal(settled.has('a2'), false);
  assert.equal(settled.has('a3'), true);
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
