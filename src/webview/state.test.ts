import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decisionLabel,
  decisionMessage,
  decisionScope,
  initialState,
  pendingApproval,
  reduce,
  requestMessage,
  visibleModeSnapshot,
  type AppState
} from './state.ts';
import type { ApprovalRequest } from '../backends/types.ts';

test('persisted diagnostic notices keep text and severity across tab replay', () => {
  const item = { id: 'double-check_t1', kind: 'notice' as const, detail: 'status',
    text: 'No errors found in the checked files.', noticeLevel: 'warning' as const, status: 'completed' as const };
  const chat = reduce(initialState, { type: 'conversation', backendId: 'opencode', threadId: 'one', replay: [] });
  const live = reduce(chat, { type: 'agentEvent', event: { type: 'item/started', backendId: 'opencode', threadId: 'one', item } });
  assert.equal(live.transcript.at(-1)?.text, item.text);
  assert.equal(live.transcript.at(-1)?.noticeLevel, 'warning');
  const away = reduce(live, { type: 'conversation', backendId: 'opencode', threadId: 'two', replay: [] });
  assert.equal(away.transcript.length, 0);
  const background = reduce(away, { type: 'agentEvent', event: { type: 'item/started', backendId: 'opencode', threadId: 'one', item } });
  assert.equal(background.transcript.length, 0);
  const back = reduce(background, { type: 'conversation', backendId: 'opencode', threadId: 'one', replay: [item] });
  assert.equal(back.transcript.length, 1);
  assert.equal(back.transcript[0].text, item.text);
  assert.equal(back.transcript[0].noticeLevel, 'warning');
});

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'req_1',
    kind: 'command',
    method: 'item/commandExecution/requestApproval',
    command: 'npm run build',
    origin: '/workspace',
    ...overrides
  };
}

test('each decision maps to a scope sentence that names how long it lasts', () => {
  assert.match(decisionScope('allow-once'), /one run/i);
  assert.match(decisionScope('allow-session'), /conversation/i);
  assert.match(decisionScope('allow-always'), /lasting/i);
  assert.equal(decisionLabel('allow-once'), 'Allowed once');
  assert.equal(decisionLabel('allow-always'), 'Allowed always');
  assert.equal(decisionLabel('allow-session'), 'Allowed for this session');
  assert.equal(decisionLabel('reject'), 'Rejected');
  assert.match(decisionMessage('reject'), /denied/i);
});

test('a denied notice shows the backend reason and only says the agent was told denied', () => {
  const state = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 'thread_1', replay: [] });
  const denied = reduce(state, {
    type: 'agentEvent',
    event: {
      type: 'approval/denied',
      backendId: 'codex',
      threadId: 'thread_1',
      requestId: 'req_1',
      subject: 'rm -rf /tmp/build',
      reason: 'Blocked recursive delete: rm -rf /tmp/build'
    }
  });
  const notice = denied.transcript[denied.transcript.length - 1];
  assert.match(notice.text, /rm -rf \/tmp\/build/);
  assert.match(notice.text, /Blocked recursive delete/);
  assert.match(notice.text, /agent was told it was denied/i);
});

test('the pending card and denied notice never fall back to the raw command', () => {
  const raw = 'mysql -uroot -psecret -e "DROP DATABASE app"';
  const requestWithDisplay = request({
    command: raw,
    displayCommand: 'mysql -uroot -p<redacted> -e "DROP DATABASE app"'
  });
  const card = requestMessage(requestWithDisplay);
  assert.equal(card.includes('secret'), false);
  assert.match(card, /<redacted>/);

  const state = reduce(initialState, {
    type: 'conversation',
    backendId: 'codex',
    threadId: 'thread_1',
    replay: [{ id: 'req_1', kind: 'approval-requested', approval: requestWithDisplay, text: card, status: 'pending' }]
  });
  const denied = reduce(state, {
    type: 'agentEvent',
    event: {
      type: 'approval/denied',
      backendId: 'codex',
      threadId: 'thread_1',
      requestId: 'req_1',
      subject: raw,
      reason: 'Blocked database drop: mysql -uroot -p<redacted> -e "DROP DATABASE app"'
    }
  });
  const notice = denied.transcript[denied.transcript.length - 1];
  assert.equal(notice.text.includes('secret'), false);
  assert.equal(notice.text.includes(raw), false);
  assert.match(notice.text, /<redacted>/);
});

test('a reload repaints exactly one pending prompt for the open request', () => {
  const open = request({ id: 'req_open' });
  const stale = request({ id: 'req_stale' });
  const state = reduce(initialState, {
    type: 'conversation',
    backendId: 'codex',
    threadId: 'thread_1',
    replay: [
      { id: 'u1', kind: 'message', role: 'user', text: 'hi' },
      { id: 'req_stale', kind: 'approval-requested', approval: stale, text: 'old', status: 'pending' }
    ],
    pendingApproval: open
  });

  const pendingCards = state.transcript.filter((item) => item.kind === 'approval-requested');
  assert.equal(pendingCards.length, 1, 'only the open request is a pending card');
  assert.equal(pendingCards[0].id, 'req_open');
  assert.equal(state.pendingApproval?.request.id, 'req_open');
  assert.equal(pendingApproval(state)?.id, 'req_open');
});

test('a reload with no open request shows no prompt at all', () => {
  const state = reduce(initialState, {
    type: 'conversation',
    backendId: 'codex',
    threadId: 'thread_1',
    replay: [
      { id: 'req_old', kind: 'approval-requested', approval: request(), text: 'old', status: 'pending' }
    ]
  });
  assert.equal(state.transcript.filter((item) => item.kind === 'approval-requested').length, 0);
  assert.equal(pendingApproval(state), undefined);
});

test('older history is prepended and a short page can still report more', () => {
  const open = reduce(initialState, {
    type: 'conversation',
    backendId: 'codex',
    threadId: 'thread_1',
    hasOlderHistory: true,
    replay: [{ id: 'reason', kind: 'reasoning', title: 'Reasoning', text: 'looking' }]
  });
  assert.equal(open.hasOlderHistory, true);
  assert.equal(open.transcript[0]?.kind, 'reasoning');
  const older = reduce(open, {
    type: 'olderHistory',
    backendId: 'codex',
    threadId: 'thread_1',
    hasOlderHistory: true,
    items: [{ id: 'user_1', kind: 'message', role: 'user', text: 'earlier prompt' }]
  });
  assert.deepEqual(
    older.transcript.map((item) => item.id),
    ['user_1', 'reason']
  );
  assert.equal(older.loadingOlder, false);
  assert.equal(older.hasOlderHistory, true);
});

test('a conversation notice is appended after the replayed transcript', () => {
  const state = reduce(initialState, {
    type: 'conversation',
    backendId: 'codex',
    threadId: 'thread_1',
    replay: [{ id: 'a1', kind: 'message', role: 'assistant', text: 'Earlier reply.', status: 'completed' }],
    notice: {
      level: 'warning',
      message: 'A question from the AI provider could not be restored after the window reloaded.',
      action: 'retryQuestion'
    }
  });
  assert.equal(state.transcript.length, 2);
  assert.equal(state.transcript[0]?.id, 'a1');
  const notice = state.transcript.at(-1);
  assert.equal(notice?.kind, 'notice');
  assert.match(notice?.text ?? '', /could not be restored/);
  assert.equal(notice?.noticeLevel, 'warning');
  assert.equal(notice?.noticeAction, 'retryQuestion');
});

test('a conversation notice survives an empty replay', () => {
  const state = reduce(initialState, {
    type: 'conversation',
    backendId: 'codex',
    threadId: 'thread_1',
    replay: [],
    notice: { level: 'warning', message: 'The question could not be restored.', action: 'retryQuestion' }
  });
  assert.equal(state.transcript.length, 1);
  assert.equal(state.transcript[0]?.kind, 'notice');
  assert.equal(state.transcript[0]?.noticeAction, 'retryQuestion');
});

test('a settled approval collapses to a decided card and clears the pending request', () => {
  const open = request({ id: 'req_live' });
  const requested: AppState = reduce(initialState, {
    type: 'conversation',
    backendId: 'codex',
    threadId: 'thread_1',
    replay: [],
    pendingApproval: open
  });
  const decided = reduce(requested, {
    type: 'agentEvent',
    event: {
      type: 'approval/decided',
      backendId: 'codex',
      threadId: 'thread_1',
      outcome: { requestId: 'req_live', decision: 'reject', subject: 'npm run build' }
    }
  });
  assert.equal(decided.pendingApproval, undefined);
  assert.equal(pendingApproval(decided), undefined);
  assert.equal(decided.transcript[0].kind, 'approval-denied');
  assert.equal(decided.transcript[0].approvalDecision, 'reject');
});

test('a later tool start fills the command without opening a second card', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'ollama', threadId: 't' });
  const started = reduce(active, {
    type: 'agentEvent',
    event: {
      type: 'item/started',
      backendId: 'ollama',
      threadId: 't',
      item: { id: 'tool_1', kind: 'tool', title: 'glob', detail: 'completed' }
    }
  });
  assert.equal(started.transcript.length, 1);
  assert.equal(started.transcript[0]?.detail, undefined);
  const updated = reduce(started, {
    type: 'agentEvent',
    event: {
      type: 'item/started',
      backendId: 'ollama',
      threadId: 't',
      item: {
        id: 'tool_1',
        kind: 'tool',
        title: 'Finding files **/*.ts',
        command: '**/*.ts',
        text: 'a.ts'
      }
    }
  });
  assert.equal(updated.transcript.length, 1);
  assert.equal(updated.transcript[0]?.command, '**/*.ts');
  assert.equal(updated.transcript[0]?.title, 'Finding files **/*.ts');
  assert.equal(updated.transcript[0]?.text, 'a.ts');
  assert.notEqual(updated.transcript[0]?.command, 'completed');
});

test('a later turn keeps the earlier duration and records its own', () => {
  const firstSent = Date.now() - 20_000;
  const secondSent = Date.now() - 5_000;
  const active = reduce(initialState, {
    type: 'conversation',
    backendId: 'codex',
    threadId: 't',
    replay: [
      { id: 'u1', kind: 'message', role: 'user', text: 'one', sentAt: firstSent, workedMs: 12_000, status: 'completed' },
      { id: 'a1', kind: 'message', role: 'assistant', text: 'done', status: 'completed' },
      { id: 'u2', kind: 'message', role: 'user', text: 'two', sentAt: secondSent, status: 'completed' }
    ]
  });
  const done = reduce(active, {
    type: 'agentEvent',
    event: { type: 'turn/completed', backendId: 'codex', threadId: 't', turnId: 'turn_2' }
  });
  assert.equal(done.transcript[0]?.workedMs, 12_000);
  const second = done.transcript[2]?.workedMs ?? -1;
  assert.ok(second >= 5_000 && second < 15_000);
});

test('a finished turn records how long it ran from the user message', () => {
  const sentAt = Date.now() - 110_000;
  const active = reduce(initialState, {
    type: 'conversation',
    backendId: 'codex',
    threadId: 't',
    replay: [{ id: 'u', kind: 'message', role: 'user', text: 'hi', sentAt, status: 'completed' }]
  });
  const done = reduce(active, {
    type: 'agentEvent',
    event: { type: 'turn/completed', backendId: 'codex', threadId: 't', turnId: 'turn_1' }
  });
  const worked = done.transcript[0]?.workedMs ?? -1;
  assert.ok(worked >= 110_000 && worked < 130_000);
  const again = reduce(done, {
    type: 'agentEvent',
    event: { type: 'turn/completed', backendId: 'codex', threadId: 't', turnId: 'turn_1' }
  });
  assert.equal(again.transcript[0]?.workedMs, worked);
});

test('a finished turn drops any lingering pending request', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't' });
  const state = reduce(active, {
    type: 'agentEvent',
    event: { type: 'approval/requested', backendId: 'codex', threadId: 't', approval: request() }
  });
  assert.ok(state.pendingApproval);
  const done = reduce(state, {
    type: 'agentEvent',
    event: { type: 'turn/completed', backendId: 'codex', threadId: 't', turnId: 'turn_1' }
  });
  assert.equal(done.pendingApproval, undefined);
});

test('the rules surface opens and closes without touching the transcript', () => {
  const opened = reduce(initialState, { type: 'openRules' });
  assert.equal(opened.rulesOpen, true);
  assert.equal(reduce(opened, { type: 'closeRules' }).rulesOpen, false);
});

test('a freshly stored always rule appears in the read model the rules surface uses', () => {
  const before = reduce(initialState, {
    type: 'permissions',
    permissions: { backendId: 'codex', hasApprovalChannel: true, options: [], selected: 'default', epoch: 0, rules: [] }
  });
  // What RulesScreen reads: `state.permissions?.rules`.
  assert.deepEqual(before.permissions?.rules, []);

  const stored = {
    id: 'rule_1',
    backendId: 'codex',
    kind: 'command' as const,
    scope: 'npm run build',
    createdAt: 1000
  };
  // The host pushes a fresh snapshot once the decision has stored its rule, so
  // the one-click revocation route lists the rule the user just created.
  const after = reduce(before, {
    type: 'permissions',
    permissions: {
      backendId: 'codex',
      hasApprovalChannel: true,
      options: [],
      selected: 'default',
      epoch: 0,
      rules: [stored]
    }
  });
  assert.deepEqual(after.permissions?.rules, [stored]);
});

test('a permission pick survives a stale permissions snapshot and a new conversation keeps it', () => {
  const picked = reduce(initialState, { type: 'selectPermission', level: 'read-only' });
  assert.equal(picked.permissionLevel, 'read-only');
  const stale = reduce(picked, {
    type: 'permissions',
    permissions: {
      backendId: 'ollama',
      hasApprovalChannel: true,
      options: [],
      selected: 'default',
      epoch: 0,
      rules: []
    }
  });
  assert.equal(stale.permissionLevel, 'read-only');
  assert.equal(stale.permissions?.selected, 'default');
  const nextChat = reduce(stale, {
    type: 'conversation',
    backendId: 'ollama',
    permissionLevel: 'read-only',
    mode: 'agent'
  });
  assert.equal(nextChat.permissionLevel, 'read-only');
});

test('switching chats applies that chat\'s mode to the mode menu', () => {
  const withModes = reduce(initialState, {
    type: 'modes',
    modes: {
      backendId: 'codex',
      options: [
        { mode: 'agent', label: 'Agent', description: '' },
        { mode: 'plan', label: 'Plan', description: '' }
      ],
      selected: 'agent'
    }
  });
  const planned = reduce(withModes, {
    type: 'conversation',
    backendId: 'codex',
    mode: 'plan',
    model: 'gpt-6'
  });
  assert.equal(planned.mode, 'plan');
  assert.equal(planned.modeOptions?.selected, 'plan');
  assert.equal(planned.selectedModel, 'gpt-6');
  const switched = reduce(planned, { type: 'conversation', backendId: 'ollama', threadId: 'ollama_thread' });
  assert.equal(switched.selectedBackendId, 'ollama');
  assert.equal(switched.selectedModel, undefined);
});

test('attachments accumulate, dedupe by path, and remove one chip at a time', () => {
  const image = { id: 'a1', name: 'shot.png', path: '/w/shot.png', mimeType: 'image/png', kind: 'image' as const };
  const note = { id: 'a2', name: 'notes.txt', path: '/w/notes.txt', mimeType: 'text/plain', kind: 'text' as const };
  const added = reduce(initialState, { type: 'addAttachments', attachments: [image, note] });
  assert.equal(added.attachments.length, 2);

  // Picking the same file again must not add a second chip.
  const again = reduce(added, { type: 'addAttachments', attachments: [{ ...image, id: 'a3' }] });
  assert.equal(again.attachments.length, 2);

  const removed = reduce(again, { type: 'removeAttachment', id: 'a1' });
  assert.deepEqual(removed.attachments.map((attachment) => attachment.id), ['a2']);
});

test('a changes snapshot replaces the visible set for the active thread', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't1' });
  const changed = reduce(active, {
    type: 'changesChanged',
    backendId: 'codex',
    threadId: 't1',
    turnId: 'turn_1',
    entries: [
      { absPath: '/w/a.ts', path: 'a.ts', status: 'modified', source: 'reported' },
      { absPath: '/w/b.ts', path: 'b.ts', status: 'created', source: 'watched' }
    ]
  });
  assert.equal(changed.turnChanges[0]?.turnId, 'turn_1');
  assert.deepEqual(
    changed.turnChanges[0]?.entries.map((entry) => [entry.path, entry.source]),
    [
      ['a.ts', 'reported'],
      ['b.ts', 'watched']
    ]
  );
});

test('an empty change set for one turn does not erase another turn', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't1' });
  assert.deepEqual(active.turnChanges, [], 'no observation is not a card');
  const withSet = reduce(active, {
    type: 'changesChanged',
    backendId: 'codex',
    threadId: 't1',
    turnId: 'turn_1',
    entries: [{ absPath: '/w/a.ts', path: 'a.ts', status: 'modified', source: 'reported' }]
  });
  const verifiedNoop = reduce(withSet, {
    type: 'changesChanged',
    backendId: 'codex',
    threadId: 't1',
    turnId: 'turn_2',
    entries: []
  });
  assert.equal(verifiedNoop.turnChanges.length, 1);
  assert.equal(verifiedNoop.turnChanges[0]?.turnId, 'turn_1');
});

test('a blank turn id clears every turn card', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't1' });
  const withSet = reduce(active, {
    type: 'changesChanged',
    backendId: 'codex',
    threadId: 't1',
    turnId: 'turn_1',
    entries: [{ absPath: '/w/a.ts', path: 'a.ts', status: 'modified', source: 'reported' }]
  });
  const cleared = reduce(withSet, {
    type: 'changesChanged',
    backendId: 'codex',
    threadId: 't1',
    turnId: '',
    entries: []
  });
  assert.deepEqual(cleared.turnChanges, []);
});

test('a later turn keeps the earlier turn changes', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't1' });
  const first = reduce(active, {
    type: 'changesChanged',
    backendId: 'codex',
    threadId: 't1',
    turnId: 'turn_1',
    messageId: 'user_1',
    entries: [{ absPath: '/w/a.ts', path: 'a.ts', status: 'modified', source: 'reported' }]
  });
  const second = reduce(first, {
    type: 'changesChanged',
    backendId: 'codex',
    threadId: 't1',
    turnId: 'turn_2',
    messageId: 'user_2',
    entries: [{ absPath: '/w/b.ts', path: 'b.ts', status: 'created', source: 'reported' }]
  });
  assert.deepEqual(
    second.turnChanges.map((turn) => turn.turnId),
    ['turn_1', 'turn_2']
  );
  assert.equal(second.turnChanges[0]?.messageId, 'user_1');
  assert.equal(second.turnChanges[1]?.entries[0]?.path, 'b.ts');
});

test('a background thread change set never replaces the visible one', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't1' });
  const withSet = reduce(active, {
    type: 'changesChanged',
    backendId: 'codex',
    threadId: 't1',
    turnId: 'turn_1',
    entries: [{ absPath: '/w/a.ts', path: 'a.ts', status: 'modified', source: 'reported' }]
  });
  const background = reduce(withSet, {
    type: 'changesChanged',
    backendId: 'codex',
    threadId: 'other_thread',
    turnId: 'turn_bg',
    entries: []
  });
  assert.equal(background.turnChanges[0]?.turnId, 'turn_1');
  assert.equal(background.turnChanges.length, 1);
});

test('a send that opens a thread keeps the optimistic user line and binds the new thread', () => {
  const drafted = reduce(initialState, { type: 'selectBackend', backendId: 'ollama' });
  const sent = reduce(drafted, { type: 'localUserMessage', text: 'hello from ollama' });
  const bound = reduce(sent, {
    type: 'conversation',
    backendId: 'ollama',
    threadId: 'ollama_thread',
    keepPendingUserMessage: true
  });
  assert.equal(bound.selectedBackendId, 'ollama');
  assert.equal(bound.activeThreadId, 'ollama_thread');
  assert.equal(bound.transcript.length, 1);
  assert.equal(bound.transcript[0].text, 'hello from ollama');
});

test('a provider handover keeps the optimistic user line after the compacted replay', () => {
  const drafted = reduce(initialState, { type: 'selectBackend', backendId: 'codex' });
  const sent = reduce(drafted, { type: 'localUserMessage', text: 'continue over there' });
  const bound = reduce(sent, {
    type: 'conversation',
    backendId: 'codex',
    threadId: 'codex_thread',
    keepPendingUserMessage: true,
    replay: [
      { id: 'compact_notice', kind: 'notice', title: 'Context compacted', text: '', status: 'completed' },
      {
        id: 'compact_assistant',
        kind: 'message',
        role: 'assistant',
        title: 'Compacted context',
        text: 'Keep the plan.',
        status: 'completed'
      }
    ]
  });
  assert.equal(bound.selectedBackendId, 'codex');
  assert.equal(bound.activeThreadId, 'codex_thread');
  assert.equal(bound.transcript.length, 3);
  assert.equal(bound.transcript[1]?.text, 'Keep the plan.');
  assert.equal(bound.transcript[2]?.text, 'continue over there');
});

test('a provider switch replays the chat the user had and keeps the message they sent', () => {
  const open = reduce(initialState, {
    type: 'conversation',
    backendId: 'ollama',
    threadId: 'old',
    replay: [
      { id: 'u0', kind: 'message', role: 'user', text: 'fix the ring', status: 'completed' },
      { id: 'a0', kind: 'message', role: 'assistant', text: 'I started the ring.', status: 'completed' }
    ]
  });
  const sent = reduce(open, { type: 'localUserMessage', text: 'continue over there' });
  const bound = reduce(sent, {
    type: 'conversation',
    backendId: 'codex',
    threadId: 'codex_thread',
    keepPendingUserMessage: true,
    replay: [
      { id: 'u0', kind: 'message', role: 'user', text: 'fix the ring', status: 'completed' },
      { id: 'a0', kind: 'message', role: 'assistant', text: 'I started the ring.', status: 'completed' }
    ]
  });
  assert.equal(bound.transcript.map((item) => item.text).join('\n'), 'fix the ring\nI started the ring.\ncontinue over there');
  assert.equal(
    bound.transcript.some((item) => item.text?.includes('Compacting this chat')),
    false
  );
});

test('switching conversation clears a failure banner from the previous chat', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'ollama', threadId: 't1' });
  const failed = reduce(active, {
    type: 'agentEvent',
    event: {
      type: 'error',
      backendId: 'ollama',
      threadId: 't1',
      message: 'The opencode session could not be started.',
      recoverable: true,
      code: 'provider'
    }
  });
  assert.equal(failed.notice, undefined);
  assert.equal(failed.transcript.at(-1)?.text, 'The opencode session could not be started.');
  assert.equal(failed.transcript.at(-1)?.noticeLevel, 'error');
  const same = reduce(failed, { type: 'conversation', backendId: 'ollama', threadId: 't1' });
  assert.equal(same.notice, undefined);
  const switched = reduce(failed, { type: 'conversation', backendId: 'ollama', threadId: 't2' });
  assert.equal(switched.notice, undefined);
  assert.equal(switched.transcript.some((item) => item.detail === 'status'), false);
  const late = reduce(switched, {
    type: 'agentEvent',
    event: {
      type: 'error',
      backendId: 'ollama',
      threadId: 't1',
      message: 'The opencode session could not be started.',
      recoverable: true,
      code: 'provider'
    }
  });
  assert.equal(late.notice, undefined);
});

test('switching conversation drops the previous thread change set', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't1' });
  const withSet = reduce(active, {
    type: 'changesChanged',
    backendId: 'codex',
    threadId: 't1',
    turnId: 'turn_1',
    entries: [{ absPath: '/w/a.ts', path: 'a.ts', status: 'modified', source: 'reported' }]
  });
  const switched = reduce(withSet, { type: 'conversation', backendId: 'codex', threadId: 't2' });
  assert.deepEqual(switched.turnChanges, []);
});

test('sending a message clears the pending attachments and stamps them on the turn', () => {
  const image = { id: 'a1', name: 'shot.png', path: '/w/shot.png', mimeType: 'image/png', kind: 'image' as const };
  const withAttachment = reduce(initialState, { type: 'addAttachments', attachments: [image] });
  const sent = reduce(withAttachment, { type: 'localUserMessage', text: 'look', attachments: [image] });
  assert.equal(sent.attachments.length, 0, 'chips leave the composer once sent');
  assert.deepEqual(sent.transcript[0].attachments, [image]);
});

test('a switch of conversation keeps pending composer attachments', () => {
  const image = { id: 'a1', name: 'shot.png', path: '/w/shot.png', mimeType: 'image/png', kind: 'image' as const };
  const withAttachment = reduce(initialState, { type: 'addAttachments', attachments: [image] });
  const switched = reduce(withAttachment, { type: 'conversation', backendId: 'codex', threadId: 't2' });
  assert.deepEqual(switched.attachments, [image]);
  const replaced = reduce(switched, { type: 'setAttachments', attachments: [] });
  assert.equal(replaced.attachments.length, 0);
});

test('an attach failure shows inline and clears on the next successful add', () => {
  const failed = reduce(initialState, { type: 'attachmentError', message: 'Could not attach that file.' });
  assert.equal(failed.attachmentError, 'Could not attach that file.');
  const added = reduce(failed, {
    type: 'addAttachments',
    attachments: [{ id: 'a1', name: 'shot.png', path: '/w/shot.png', mimeType: 'image/png', kind: 'image' }]
  });
  assert.equal(added.attachmentError, undefined);
});

test('a model change drops the previous capability so values never carry over', () => {
  const loaded: AppState = reduce(
    reduce(initialState, { type: 'snapshot', availability: [] }),
    {
      type: 'modelCapability',
      capability: {
        providerId: 'ollama',
        modelId: 'qwen',
        settings: {
          providerId: 'ollama',
          modelId: 'qwen',
          contextWindow: 32768,
          thinking: 'high',
          isOverridden: true,
          overridden: { contextWindow: true, thinking: true }
        }
      }
    }
  );
  // The stale answer is dropped: the panel resolves the new model fresh.
  const switched = reduce(
    { ...loaded, selectedBackendId: 'ollama', selectedModel: 'qwen' },
    { type: 'selectModel', model: 'llama' }
  );
  assert.equal(switched.modelCapability, undefined);
  assert.equal(switched.modelCapabilityStatus, 'loading');

  // A late answer for the model that is no longer selected is ignored.
  const late = reduce(switched, {
    type: 'modelCapability',
    capability: {
      providerId: 'ollama',
      modelId: 'qwen',
      settings: {
        providerId: 'ollama',
        modelId: 'qwen',
        contextWindow: 32768,
        thinking: 'high',
        isOverridden: true,
        overridden: { contextWindow: true, thinking: true }
      }
    }
  });
  assert.equal(late.modelCapability, undefined);

  // Only the answer for the selected model becomes the resolved view.
  const answer = reduce(switched, {
    type: 'modelCapability',
    capability: {
      providerId: 'ollama',
      modelId: 'llama',
      settings: {
        providerId: 'ollama',
        modelId: 'llama',
        contextWindow: 8192,
        thinking: 'medium',
        isOverridden: false,
        overridden: { contextWindow: false, thinking: false }
      }
    }
  });
  assert.equal(answer.modelCapability?.modelId, 'llama');
  assert.equal(answer.modelCapabilityStatus, 'ready');
});

test('re-selecting the same model does not mark capabilities loading without a fetch', () => {
  const base = {
    ...initialState,
    selectedBackendId: 'ollama',
    selectedModel: 'llama',
    modelCapabilityStatus: 'ready' as const
  };
  const again = reduce(base, { type: 'selectModel', model: 'llama' });
  assert.equal(again.selectedModel, 'llama');
  assert.equal(again.modelCapabilityStatus, 'ready');

  const sameBackend = reduce(base, { type: 'selectBackend', backendId: 'ollama' });
  assert.equal(sameBackend, base);
});

test('a capability read failure marks the panel and is cleared by a later success', () => {
  const base = { ...initialState, selectedBackendId: 'ollama', selectedModel: 'qwen' };
  const failed = reduce(base, {
    type: 'modelCapabilityError',
    providerId: 'ollama',
    modelId: 'qwen',
    message: 'registry unreachable'
  });
  assert.equal(failed.modelCapabilityStatus, 'error');
  assert.equal(failed.modelCapabilityError, 'registry unreachable');
  // A failure for a model that is not selected leaves the current one alone.
  const stale = reduce(failed, {
    type: 'modelCapabilityError',
    providerId: 'ollama',
    modelId: 'other',
    message: 'nope'
  });
  assert.equal(stale.modelCapabilityError, 'registry unreachable');
});

test('the context view is stored from the host and clears local exclusions when none apply', () => {
  const view = {
    status: 'ready' as const,
    workspaceName: 'app',
    selectionLines: 0,
    categories: [],
    includedCount: 3,
    excludedCount: 0,
    remainingGroups: 2,
    viewedFileIncluded: false
  };
  const withView = reduce(initialState, {
    type: 'context',
    view,
    settingsEnabled: true,
    exclusions: [],
    includeViewedFile: false
  });
  assert.equal(withView.contextView?.workspaceName, 'app');
  assert.equal(withView.contextSettingsEnabled, true);

  const excluded = reduce(withView, { type: 'toggleContextExclusion', key: 'category:shape' });
  assert.deepEqual(excluded.contextExclusions, ['category:shape']);

  // The host echo is the source of truth: it carries the exclusion set actually
  // in effect, so a turn that consumed the exclusions cannot leave a stale one.
  const restored = reduce(excluded, {
    type: 'context',
    view,
    settingsEnabled: true,
    exclusions: [],
    includeViewedFile: false
  });
  assert.deepEqual(restored.contextExclusions, []);
});

test('toggling the same context exclusion twice turns it back on', () => {
  const once = reduce(initialState, { type: 'toggleContextExclusion', key: 'item:instructions:AGENTS.md' });
  const twice = reduce(once, { type: 'toggleContextExclusion', key: 'item:instructions:AGENTS.md' });
  assert.deepEqual(twice.contextExclusions, []);
});

test('reset clears every per-turn context exclusion', () => {
  const keyed = reduce(initialState, { type: 'toggleContextExclusion', key: 'category:shape' });
  const withTwo = reduce(keyed, { type: 'toggleContextExclusion', key: 'category:editor' });
  const reset = reduce(withTwo, { type: 'resetContextExclusions' });
  assert.deepEqual(reset.contextExclusions, []);
});

test('a revision marks the plan card in flight and a fresh plan settles it', () => {
  const plan = { path: '.melink/plans/t.md', title: 'Plan', steps: [{ text: 'a', status: 'pending' as const }], updatedAt: 1 };
  const withPlan = reduce(initialState, { type: 'plan', plan });
  assert.equal(withPlan.planRevising, false);

  const revising = reduce(withPlan, { type: 'planRevising' });
  assert.equal(revising.planRevising, true);

  // The updated plan replaces the old one in place: one artifact, no second card.
  const revised = reduce(revising, {
    type: 'plan',
    plan: { ...plan, steps: [{ text: 'a', status: 'pending' }, { text: 'b', status: 'pending' }], updatedAt: 2 }
  });
  assert.equal(revised.planRevising, false);
  assert.equal(revised.plan?.steps.length, 2);
});

test('a finished turn clears an in-flight revision that never echoed a plan', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't' });
  const revising = reduce(active, { type: 'planRevising' });
  const done = reduce(revising, {
    type: 'agentEvent',
    event: { type: 'turn/completed', backendId: 'codex', threadId: 't', turnId: 'turn_1' }
  });
  assert.equal(done.planRevising, false);
});

test('a failed Codex auth while Ollama is selected surfaces no status in the UI', () => {
  const ollamaSelected = reduce(initialState, {
    type: 'snapshot',
    availability: [
      { id: 'ollama', label: 'Ollama Cloud', badge: 'Ollama', status: 'available' },
      { id: 'codex', label: 'OpenAI Codex CLI', badge: 'Codex', status: 'available' }
    ]
  });
  assert.equal(ollamaSelected.selectedBackendId, 'ollama');

  const afterCodexError = reduce(ollamaSelected, {
    type: 'agentEvent',
    event: {
      type: 'error',
      backendId: 'codex',
      message: 'Codex rejected an API key.',
      recoverable: true,
      code: 'auth-mismatch'
    }
  });
  // No notice and no transcript change for a provider the user is not driving.
  assert.equal(afterCodexError.notice, undefined);
  assert.deepEqual(afterCodexError.transcript, ollamaSelected.transcript);
});

test('an API-key-vs-ChatGPT mismatch on the selected provider is surfaced distinctly', () => {
  const codexSelected = reduce(initialState, {
    type: 'snapshot',
    availability: [
      { id: 'ollama', label: 'Ollama Cloud', badge: 'Ollama', status: 'unavailable' },
      { id: 'codex', label: 'OpenAI Codex CLI', badge: 'Codex', status: 'available' }
    ]
  });
  assert.equal(codexSelected.selectedBackendId, 'codex');
  const afterError = reduce(codexSelected, {
    type: 'agentEvent',
    event: {
      type: 'error',
      backendId: 'codex',
      message: 'Codex rejected an API key. The CLI is not using your ChatGPT login.',
      recoverable: true,
      code: 'auth-mismatch'
    }
  });
  assert.equal(afterError.notice, undefined);
  assert.equal(afterError.transcript.at(-1)?.noticeLevel, 'warning');
  assert.equal(afterError.transcript.at(-1)?.noticeAction, 'refresh');
  assert.match(afterError.transcript.at(-1)?.text ?? '', /API key/);
});

test('reject confirmation opens, cancels, and closes when a plan is written', () => {
  const opened = reduce(initialState, { type: 'requestRejectConfirmation' });
  assert.equal(opened.rejectConfirmationOpen, true);
  assert.equal(reduce(opened, { type: 'cancelRejectConfirmation' }).rejectConfirmationOpen, false);

  const settled = reduce(opened, {
    type: 'plan',
    plan: { path: 'p', title: 'Plan', steps: [], updatedAt: 1 }
  });
  assert.equal(settled.rejectConfirmationOpen, false);
});

test('a native plan update keeps the artifact summary and built flag', () => {
  const plan = {
    path: '.melink/plans/t.md',
    title: 'Fix the bug',
    summary: 'Make buildContext read the live model.',
    body: 'Make buildContext read the live model.\n\nTouch buildContext.ts only.',
    built: true,
    steps: [{ text: 'a', status: 'completed' as const }],
    updatedAt: 1
  };
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't' });
  const withPlan = reduce(active, { type: 'plan', plan });
  const updated = reduce(withPlan, {
    type: 'agentEvent',
    event: {
      type: 'plan/updated',
      backendId: 'codex',
      threadId: 't',
      turnId: 'turn_1',
      steps: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'inProgress' }]
    }
  });
  assert.equal(updated.plan?.summary, 'Make buildContext read the live model.');
  assert.equal(updated.plan?.body, 'Make buildContext read the live model.\n\nTouch buildContext.ts only.');
  assert.equal(updated.plan?.built, true);
  assert.equal(updated.plan?.steps.length, 2);
});

test('a later message hides a finished plan row, and new work brings it back', () => {
  const plan = {
    path: '.melink/plans/t.md',
    title: 'Fix the bug',
    built: true,
    steps: [
      { text: 'a', status: 'completed' as const },
      { text: 'b', status: 'completed' as const }
    ],
    updatedAt: 1
  };
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't' });
  const withPlan = reduce(active, { type: 'plan', plan });
  const sent = reduce(withPlan, { type: 'localUserMessage', text: 'what is left?' });
  assert.equal(sent.plan?.completedDismissed, true);

  const resumed = reduce(sent, {
    type: 'agentEvent',
    event: {
      type: 'plan/updated',
      backendId: 'codex',
      threadId: 't',
      turnId: 'turn_2',
      steps: [
        { text: 'a', status: 'completed' },
        { text: 'b', status: 'pending' }
      ]
    }
  });
  assert.equal(resumed.plan?.completedDismissed, undefined);
});

test('a refused send drops the optimistic bubble and leaves the rest of the chat', () => {
  const sent = reduce(initialState, { type: 'localUserMessage', text: 'hello there' });
  const kept = reduce(sent, { type: 'revertLocalSend', text: 'other' });
  assert.equal(kept.transcript.length, 1);
  const reverted = reduce(sent, { type: 'revertLocalSend', text: 'hello there' });
  assert.equal(reverted.transcript.length, 0);
});

test('a live user bubble takes the host message id so its restore control can match', () => {
  const sent = reduce(initialState, { type: 'localUserMessage', text: 'fix the header' });
  assert.equal(sent.transcript[0]?.id.startsWith('local_'), true);
  const bound = reduce(sent, {
    type: 'userMessageId',
    backendId: 'codex',
    threadId: 'thr',
    messageId: 'user_1_0'
  });
  assert.equal(bound.transcript[0]?.id, 'user_1_0');
});

test('checkpoints are carried for the active thread and dropped on a conversation switch', () => {
  const withCheckpoints = reduce(initialState, {
    type: 'checkpoints',
    checkpoints: [
      { messageId: 'u1', turnId: 't1', threadId: 'thr', backendId: 'codex', createdAt: 1, fileCount: 2, paths: ['a.ts', 'b.ts'] }
    ]
  });
  assert.equal(withCheckpoints.checkpoints?.length, 1);

  const switched = reduce(withCheckpoints, { type: 'conversation', backendId: 'codex' });
  assert.equal(switched.checkpoints, undefined, 'a thread switch drops the previous thread checkpoints');
});

test('a restore confirmation opens from a preview, including other chats, and closes on confirm or cancel', () => {
  const preview = {
    messageId: 'u1',
    thisChat: {
      backendId: 'codex',
      threadId: 'thr',
      title: 'This chat',
      messages: [{ id: 'u1', preview: 'fix the header' }],
      paths: ['a.ts'],
      planChanges: true
    },
    otherChats: [
      {
        backendId: 'codex',
        threadId: 'other',
        title: 'Other chat',
        messages: [{ id: 'u9', preview: 'add tests' }],
        paths: ['b.ts'],
        planChanges: false
      }
    ]
  };
  const opened = reduce(initialState, { type: 'restorePreview', preview });
  assert.equal(opened.restoreConfirmation?.otherChats.length, 1);
  assert.equal(opened.restoreConfirmation?.otherChats[0].title, 'Other chat');
  assert.equal(opened.restoreConfirmation?.thisChat.planChanges, true);

  const cancelled = reduce(opened, { type: 'cancelRestoreConfirmation' });
  assert.equal(cancelled.restoreConfirmation, undefined);

  const switched = reduce(opened, { type: 'conversation', backendId: 'codex' });
  assert.equal(switched.restoreConfirmation, undefined, 'a thread switch drops the restore confirmation');

  const restored = reduce(opened, {
    type: 'restoreResult',
    result: {
      targetId: 'u1',
      undoPointId: 'undo-1',
      ok: true,
      partial: false,
      hasConflicts: false,
      aborted: false,
      fileCount: 2,
      results: [],
      message: 'Restore complete.'
    }
  });
  assert.equal(restored.restoreConfirmation, undefined);
  assert.equal(restored.restoreResult?.ok, true);
});

test('a mode switch prompt stays up until it is answered', () => {
  const opened = reduce(initialState, {
    type: 'modeSwitchPrompt',
    requestId: 'mode-switch-1',
    from: 'plan',
    to: 'agent'
  });
  assert.equal(opened.modeSwitch?.from, 'plan');
  assert.equal(opened.modeSwitch?.to, 'agent');

  const replaced = reduce(opened, {
    type: 'modeSwitchPrompt',
    requestId: 'mode-switch-2',
    from: 'ask',
    to: 'plan'
  });
  assert.equal(replaced.modeSwitch?.requestId, 'mode-switch-2');

  const cleared = reduce(replaced, { type: 'clearModeSwitch' });
  assert.equal(cleared.modeSwitch, undefined);
});

test('a partial restore result is carried so the surface can report it as partial', () => {
  const state = reduce(initialState, {
    type: 'restoreResult',
    result: {
      targetId: 'u1',
      ok: false,
      partial: true,
      hasConflicts: true,
      aborted: false,
      fileCount: 2,
      results: [
        { relPath: 'a.ts', outcome: 'reverted' },
        { relPath: 'b.ts', outcome: 'conflict', reason: 'changed outside the agent' }
      ],
      message: 'Restore was partial: 1 of 2 files restored, 1 left unchanged.'
    }
  });
  assert.equal(state.restoreResult?.partial, true);
  assert.equal(state.restoreResult?.hasConflicts, true);
  assert.equal(state.restoreResult?.results.length, 2);
});

test('a review snapshot for the active thread replaces the visible one', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't1' });
  const review = {
    backendId: 'codex',
    threadId: 't1',
    turnId: 'turn_1',
    files: [
      {
        absPath: '/w/a.ts',
        path: 'a.ts',
        status: 'modified' as const,
        source: 'reported' as const,
        binary: false,
        diffable: true,
        additions: 3,
        deletions: 1,
        decision: 'pending' as const,
        hunks: []
      }
    ],
    additions: 3,
    deletions: 1,
    fullyDecided: false
  };
  const withReview = reduce(active, { type: 'changeReview', review });
  assert.equal(withReview.turnChanges[0]?.review?.turnId, 'turn_1');
});

test('a changes/review carrying a diffReview survives the reducer intact', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't1' });
  const diffReview = {
    status: 'reviewed' as const,
    findings: [
      { path: 'src/b.ts', line: 1, severity: 'warning' as const, message: 'The request mentions src/b.ts, but the turn did not change it.' }
    ]
  };
  const reviewed = reduce(active, {
    type: 'changeReview',
    review: {
      backendId: 'codex',
      threadId: 't1',
      turnId: 'turn_1',
      files: [],
      additions: 0,
      deletions: 0,
      fullyDecided: false,
      diffReview
    }
  });

  assert.deepEqual(reviewed.turnChanges[0]?.review?.diffReview, diffReview);
});

test('a review snapshot keeps its attached check view across later updates', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't1' });
  const checks = {
    status: 'failed' as const,
    summary: 'Checks: 1 failed · 1 passed',
    results: [
      {
        name: 'typecheck',
        command: 'npm run typecheck',
        status: 'passed' as const,
        durationMs: 1000
      },
      {
        name: 'test',
        command: 'npm run test',
        status: 'failed' as const,
        durationMs: 2000,
        output: 'AssertionError'
      }
    ],
    startedAt: 1,
    finishedAt: 3
  };
  const review = {
    backendId: 'codex',
    threadId: 't1',
    turnId: 'turn_1',
    files: [
      {
        absPath: '/w/a.ts',
        path: 'a.ts',
        status: 'modified' as const,
        source: 'reported' as const,
        binary: false,
        diffable: true,
        additions: 3,
        deletions: 1,
        decision: 'pending' as const,
        hunks: []
      }
    ],
    additions: 3,
    deletions: 1,
    fullyDecided: false,
    checks
  };
  const withReview = reduce(active, { type: 'changeReview', review });
  assert.equal(withReview.turnChanges[0]?.review?.checks?.status, 'failed');

  const withHunks = reduce(withReview, {
    type: 'changeHunks',
    turnId: 'turn_1',
    path: 'a.ts',
    hunks: [],
    truncated: false
  });
  assert.equal(withHunks.turnChanges[0]?.review?.checks?.status, 'failed');
  assert.equal(withHunks.turnChanges[0]?.review?.checks?.results.length, 2);
});

test('a background thread review never replaces the visible one', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't1' });
  const background = reduce(active, {
    type: 'changeReview',
    review: { backendId: 'codex', threadId: 'other', turnId: 'turn_bg', files: [], additions: 0, deletions: 0, fullyDecided: false }
  });
  assert.deepEqual(background.turnChanges, [], 'a background thread review is ignored');
});

test('switching conversation drops the review and any destructive confirmation', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't1' });
  const withReview = reduce(active, {
    type: 'changeReview',
    review: { backendId: 'codex', threadId: 't1', turnId: 'turn_1', files: [], additions: 0, deletions: 0, fullyDecided: false }
  });
  const opened = reduce(withReview, {
    type: 'requestChangeRejectConfirmation',
    turnId: 'turn_1',
    scope: 'all',
    paths: ['a.ts']
  });
  assert.equal(opened.changeRejectConfirm?.scope, 'all');

  const switched = reduce(opened, { type: 'conversation', backendId: 'codex', threadId: 't2' });
  assert.deepEqual(switched.turnChanges, []);
  assert.equal(switched.changeRejectConfirm, undefined);
});

test('a reject confirmation names its scope and clears once cancelled', () => {
  const fileScoped = reduce(initialState, {
    type: 'requestChangeRejectConfirmation',
    turnId: 'turn_1',
    scope: 'file',
    paths: ['src/a.ts']
  });
  assert.deepEqual(fileScoped.changeRejectConfirm, { turnId: 'turn_1', scope: 'file', paths: ['src/a.ts'] });
  const cancelled = reduce(fileScoped, { type: 'cancelChangeRejectConfirmation' });
  assert.equal(cancelled.changeRejectConfirm, undefined);
});

test('a decision answer settles the in-flight lock and closes the confirmation', () => {
  const deciding = reduce(initialState, { type: 'changeDeciding', value: true });
  assert.equal(deciding.changeDeciding, true);
  const opened = reduce(deciding, {
    type: 'requestChangeRejectConfirmation',
    turnId: 'turn_1',
    scope: 'file',
    paths: ['a.ts']
  });
  const answered = reduce(opened, {
    type: 'changeDecision',
    results: [{ relPath: 'a.ts', decision: 'rejected', ok: true }]
  });
  assert.equal(answered.changeDeciding, false);
  assert.equal(answered.changeRejectConfirm, undefined);
  assert.equal(answered.changeDecision?.results[0].ok, true);
});

test('a failure line stays where it happened once the user or the next turn continues', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'ollama', threadId: 'thread_1' });
  const failed = reduce(active, {
    type: 'agentEvent',
    event: {
      type: 'error',
      backendId: 'ollama',
      threadId: 'thread_1',
      message: 'The opencode stream ended before the turn completed.',
      recoverable: true,
      code: 'stream'
    }
  });
  assert.equal(failed.notice, undefined);
  assert.equal(failed.transcript.at(-1)?.text, 'The opencode stream ended before the turn completed.');
  const continued = reduce(failed, { type: 'localUserMessage', text: 'Continue the remaining steps.' });
  assert.equal(continued.notice, undefined);
  assert.equal(continued.transcript[0]?.text, 'The opencode stream ended before the turn completed.');
  assert.equal(continued.transcript.at(-1)?.text, 'Continue the remaining steps.');
  const again = reduce(failed, {
    type: 'agentEvent',
    event: { type: 'turn/started', backendId: 'ollama', threadId: 'thread_1', turnId: 'turn_2' }
  });
  assert.equal(again.notice, undefined);
  assert.equal(again.transcript.at(-1)?.text, 'The opencode stream ended before the turn completed.');
});

test('a new turn keeps the review but stops claiming a decision is in flight', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't1' });
  const withReview = reduce(active, {
    type: 'changeReview',
    review: { backendId: 'codex', threadId: 't1', turnId: 'turn_1', files: [], additions: 0, deletions: 0, fullyDecided: false }
  });
  const started = reduce(withReview, {
    type: 'agentEvent',
    event: { type: 'turn/started', backendId: 'codex', threadId: 't1', turnId: 'turn_2' }
  });
  assert.equal(started.busy, true);
  assert.equal(started.changeDeciding, false);
  assert.equal(started.changeRejectConfirm, undefined);
  assert.equal(started.turnChanges[0]?.review?.turnId, 'turn_1', 'the earlier turn keeps its review');
});

test('a later turn with no changes leaves the earlier review in place', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't1' });
  const withReview = reduce(active, {
    type: 'changeReview',
    review: { backendId: 'codex', threadId: 't1', turnId: 'turn_1', files: [], additions: 0, deletions: 0, fullyDecided: false }
  });
  assert.equal(withReview.turnChanges[0]?.review?.turnId, 'turn_1');

  const noop = reduce(withReview, {
    type: 'changesChanged',
    backendId: 'codex',
    threadId: 't1',
    turnId: 'turn_2',
    entries: []
  });
  assert.equal(noop.turnChanges.length, 1);
  assert.equal(noop.turnChanges[0]?.turnId, 'turn_1', 'a verified no-op turn does not erase an earlier card');
});

test('a repaint of the same turn keeps the current review instead of clearing it', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't1' });
  const withReview = reduce(active, {
    type: 'changeReview',
    review: { backendId: 'codex', threadId: 't1', turnId: 'turn_1', files: [], additions: 0, deletions: 0, fullyDecided: false }
  });
  const repaint = reduce(withReview, {
    type: 'changesChanged',
    backendId: 'codex',
    threadId: 't1',
    turnId: 'turn_1',
    entries: []
  });
  assert.equal(repaint.turnChanges[0]?.review?.turnId, 'turn_1', 'the same turn keeps its review across a repaint');
});

test('Ollama keeps Agent, Plan, and Ask when the host snapshot is missing or belongs to Codex', () => {
  const ollama = reduce(initialState, { type: 'selectBackend', backendId: 'ollama' });
  const offered = visibleModeSnapshot(ollama);
  assert.deepEqual(
    offered?.options.map((option) => option.mode),
    ['agent', 'plan', 'ask']
  );
  const stale = reduce(ollama, {
    type: 'modes',
    modes: {
      backendId: 'codex',
      options: [
        { mode: 'agent', label: 'Agent', description: 'Acts.' },
        { mode: 'plan', label: 'Plan', description: 'Plans.' },
        { mode: 'ask', label: 'Ask', description: 'Answers.' }
      ],
      selected: 'plan'
    }
  });
  assert.equal(stale.mode, 'agent', 'a Codex snapshot does not change the Ollama mode');
  assert.deepEqual(
    visibleModeSnapshot(stale)?.options.map((option) => option.mode),
    ['agent', 'plan', 'ask']
  );
});

test('streamed text moves the context fill and a provider count replaces it', () => {
  const started = reduce(
    { ...initialState, selectedBackendId: 'ollama', activeThreadId: 'thread_1' },
    { type: 'localUserMessage', text: 'abcd' }
  );
  assert.equal(started.contextUsedTokens, 1);
  const streamed = reduce(started, {
    type: 'agentEvent',
    event: {
      type: 'item/delta',
      backendId: 'ollama',
      threadId: 'thread_1',
      itemId: 'item_1',
      delta: 'abcdefgh'
    }
  });
  assert.equal(streamed.contextUsedTokens, 3);
  const reported = reduce(streamed, {
    type: 'agentEvent',
    event: {
      type: 'context/usage',
      backendId: 'ollama',
      threadId: 'thread_1',
      usedTokens: 1040,
      windowTokens: 8192
    }
  });
  assert.equal(reported.contextUsedTokens, 1040);
  assert.equal(reported.contextWindowTokens, 8192);
});

test('a question request replaces the fenced assistant text and stays pending', () => {
  const seeded: AppState = {
    ...initialState,
    transcript: [
      {
        id: 'a1',
        kind: 'message',
        role: 'assistant',
        text: 'Hello\n```sidecode-question\n{}\n```',
        status: 'completed'
      }
    ]
  };
  const asked = reduce(seeded, {
    type: 'questionAsked',
    request: {
      id: 'fence_a1',
      backendId: 'ollama',
      threadId: 'thread_1',
      itemId: 'a1',
      strippedText: 'Hello',
      questions: [{ id: 'q1', prompt: 'Which layout?', options: ['Two columns', 'Single column'] }]
    }
  });
  assert.equal(asked.pendingQuestion?.id, 'fence_a1');
  assert.equal(asked.transcript[0]?.text, 'Hello');
  const cleared = reduce(asked, { type: 'questionCleared' });
  assert.equal(cleared.pendingQuestion, undefined);
});

test('an info notice stays in the transcript where it happened', () => {
  const open = reduce(initialState, { type: 'conversation', backendId: 'ollama', threadId: 'thread_1' });
  const sent = reduce(open, { type: 'localUserMessage', text: 'build the plan' });
  const switched = reduce(sent, {
    type: 'notice',
    level: 'info',
    message: 'Switched to Agent mode for this request.'
  });
  assert.equal(switched.notice, undefined);
  assert.equal(switched.transcript[1]?.detail, 'status');
  assert.equal(switched.transcript[1]?.text, 'Switched to Agent mode for this request.');
  const continued = reduce(switched, {
    type: 'agentEvent',
    event: {
      type: 'item/started',
      backendId: 'ollama',
      threadId: 'thread_1',
      item: { id: 'a1', kind: 'message', role: 'assistant', text: '' }
    }
  });
  assert.equal(continued.transcript[1]?.text, 'Switched to Agent mode for this request.');
  assert.equal(continued.transcript[2]?.id, 'a1');
  assert.equal(continued.notice, undefined);
});

test('a usage limit leaves the user message in the chat', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't1' });
  const sent = reduce(active, { type: 'localUserMessage', text: 'fix the ring' });
  const message = "You've hit your usage limit. Try again at 11:00 AM.";
  const failed = reduce(sent, {
    type: 'agentEvent',
    event: { type: 'error', backendId: 'codex', threadId: 't1', message, recoverable: true, code: 'provider' }
  });
  assert.equal(failed.transcript.some((item) => item.role === 'user' && item.text === 'fix the ring'), true);
  assert.equal(failed.transcript.some((item) => item.text === message), true);
  const repainted = reduce(failed, {
    type: 'conversation',
    backendId: 'codex',
    threadId: 't1',
    replay: []
  });
  assert.equal(repainted.transcript.some((item) => item.role === 'user' && item.text === 'fix the ring'), true);
});

test('the same provider failure is one status line, and Retry can clear it', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't1' });
  const busy = reduce(active, { type: 'busy', value: true, backendId: 'codex', threadId: 't1' });
  const message = "You've hit your usage limit. Try again at 11:00 AM.";
  const once = reduce(busy, {
    type: 'agentEvent',
    event: { type: 'error', backendId: 'codex', threadId: 't1', message, recoverable: true, code: 'provider' }
  });
  const twice = reduce(once, {
    type: 'agentEvent',
    event: { type: 'error', backendId: 'codex', threadId: 't1', message, recoverable: true, code: 'provider' }
  });
  const banners = twice.transcript.filter((item) => item.detail === 'status' && item.text === message);
  assert.equal(banners.length, 1);
  assert.equal(banners[0]?.noticeAction, 'retry');
  assert.equal(twice.busy, false);
  const distinct = reduce(twice, {
    type: 'agentEvent',
    event: {
      type: 'error',
      backendId: 'codex',
      threadId: 't1',
      message: 'The Codex turn failed.',
      recoverable: true,
      code: 'provider'
    }
  });
  assert.equal(distinct.transcript.filter((item) => item.detail === 'status').length, 2);
  const cleared = reduce(distinct, { type: 'dismissStatusNotice', text: message });
  assert.equal(cleared.transcript.some((item) => item.text === message), false);
  assert.equal(cleared.transcript.some((item) => item.text === 'The Codex turn failed.'), true);
});

test('a warning with a recovery action is a transcript line, not a pinned banner', () => {
  const open = reduce(initialState, { type: 'conversation', backendId: 'ollama', threadId: 'thread_1' });
  const warned = reduce(open, {
    type: 'notice',
    level: 'warning',
    message: 'Ollama needs a token before you can chat.',
    action: 'setToken'
  });
  assert.equal(warned.notice, undefined);
  assert.equal(warned.transcript.at(-1)?.noticeLevel, 'warning');
  assert.equal(warned.transcript.at(-1)?.noticeAction, 'setToken');
  assert.equal(warned.transcript.at(-1)?.text, 'Ollama needs a token before you can chat.');
});

test('a conversation repaint keeps queued chips for the same chat and clears them on a switch', () => {
  const open = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 'thread_1', replay: [] });
  const queued = reduce(open, {
    type: 'queuedTurns',
    entries: [{ id: 'q1', textPreview: 'first queued', attachmentCount: 1, attachmentNames: ['guard.png'] }]
  });
  assert.equal(queued.queuedTurns.length, 1);

  const repaint = reduce(queued, { type: 'conversation', backendId: 'codex', threadId: 'thread_1', replay: [] });
  assert.deepEqual(repaint.queuedTurns, queued.queuedTurns);

  const switched = reduce(repaint, { type: 'conversation', backendId: 'codex', threadId: 'thread_2', replay: [] });
  assert.deepEqual(switched.queuedTurns, []);
});

test('settings save state is tracked and cleared when the screen closes', () => {
  const pending = reduce(initialState, { type: 'settingsSave', pending: true });
  assert.equal(pending.settingsSave?.pending, true);

  const saved = reduce(pending, { type: 'settingsSave', pending: false, ok: true });
  assert.deepEqual(saved.settingsSave, { pending: false, ok: true, message: undefined });

  const failed = reduce(pending, {
    type: 'settingsSave',
    pending: false,
    ok: false,
    message: 'One setting was not saved.'
  });
  assert.equal(failed.settingsSave?.ok, false);
  assert.match(failed.settingsSave?.message ?? '', /not saved/);

  const closed = reduce({ ...saved, settingsOpen: true }, { type: 'closeSettings' });
  assert.equal(closed.settingsSave, undefined);
});
