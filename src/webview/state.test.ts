import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decisionLabel,
  decisionMessage,
  decisionScope,
  initialState,
  pendingApproval,
  reduce,
  visibleModeSnapshot,
  type AppState
} from './state.ts';
import type { ApprovalRequest } from '../backends/types.ts';

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
  assert.equal(changed.changesTurnId, 'turn_1');
  assert.deepEqual(
    changed.changes?.map((entry) => [entry.path, entry.source]),
    [
      ['a.ts', 'reported'],
      ['b.ts', 'watched']
    ]
  );
});

test('an empty verified change set stays distinct from no observation', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't1' });
  assert.equal(active.changes, undefined, 'no observation is not an empty set');
  const verifiedNoop = reduce(active, {
    type: 'changesChanged',
    backendId: 'codex',
    threadId: 't1',
    turnId: 'turn_1',
    entries: []
  });
  assert.deepEqual(verifiedNoop.changes, []);
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
  assert.equal(background.changesTurnId, 'turn_1');
  assert.equal(background.changes?.length, 1);
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
  assert.equal(failed.notice?.message, 'The opencode session could not be started.');
  const same = reduce(failed, { type: 'conversation', backendId: 'ollama', threadId: 't1' });
  assert.equal(same.notice?.message, 'The opencode session could not be started.');
  const switched = reduce(failed, { type: 'conversation', backendId: 'ollama', threadId: 't2' });
  assert.equal(switched.notice, undefined);
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
  assert.equal(switched.changes, undefined);
  assert.equal(switched.changesTurnId, undefined);
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
  assert.equal(afterError.notice?.level, 'warning');
  assert.match(afterError.notice?.message ?? '', /API key/);
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

test('a restore confirmation opens with the affected files and closes on confirm or cancel', () => {
  const opened = reduce(initialState, {
    type: 'requestRestoreConfirmation',
    messageId: 'u1',
    fileCount: 2,
    paths: ['a.ts', 'b.ts']
  });
  assert.deepEqual(opened.restoreConfirmation, { messageId: 'u1', fileCount: 2, paths: ['a.ts', 'b.ts'] });

  const cancelled = reduce(opened, { type: 'cancelRestoreConfirmation' });
  assert.equal(cancelled.restoreConfirmation, undefined);

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
  assert.equal(withReview.changeReview?.turnId, 'turn_1');
});

test('a background thread review never replaces the visible one', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't1' });
  const background = reduce(active, {
    type: 'changeReview',
    review: { backendId: 'codex', threadId: 'other', turnId: 'turn_bg', files: [], additions: 0, deletions: 0, fullyDecided: false }
  });
  assert.equal(background.changeReview, undefined, 'a background thread review is ignored');
});

test('switching conversation drops the review and any destructive confirmation', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't1' });
  const withReview = reduce(active, {
    type: 'changeReview',
    review: { backendId: 'codex', threadId: 't1', turnId: 'turn_1', files: [], additions: 0, deletions: 0, fullyDecided: false }
  });
  const opened = reduce(withReview, { type: 'requestChangeRejectConfirmation', scope: 'all', paths: ['a.ts'] });
  assert.equal(opened.changeRejectConfirm?.scope, 'all');

  const switched = reduce(opened, { type: 'conversation', backendId: 'codex', threadId: 't2' });
  assert.equal(switched.changeReview, undefined);
  assert.equal(switched.changeRejectConfirm, undefined);
});

test('a reject confirmation names its scope and clears once cancelled', () => {
  const fileScoped = reduce(initialState, {
    type: 'requestChangeRejectConfirmation',
    scope: 'file',
    paths: ['src/a.ts']
  });
  assert.deepEqual(fileScoped.changeRejectConfirm, { scope: 'file', paths: ['src/a.ts'] });
  const cancelled = reduce(fileScoped, { type: 'cancelChangeRejectConfirmation' });
  assert.equal(cancelled.changeRejectConfirm, undefined);
});

test('a decision answer settles the in-flight lock and closes the confirmation', () => {
  const deciding = reduce(initialState, { type: 'changeDeciding', value: true });
  assert.equal(deciding.changeDeciding, true);
  const opened = reduce(deciding, { type: 'requestChangeRejectConfirmation', scope: 'file', paths: ['a.ts'] });
  const answered = reduce(opened, {
    type: 'changeDecision',
    results: [{ relPath: 'a.ts', decision: 'rejected', ok: true }]
  });
  assert.equal(answered.changeDeciding, false);
  assert.equal(answered.changeRejectConfirm, undefined);
  assert.equal(answered.changeDecision?.results[0].ok, true);
});

test('a failure banner leaves once the user or the next turn continues', () => {
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
  assert.equal(failed.notice?.message, 'The opencode stream ended before the turn completed.');
  const continued = reduce(failed, { type: 'localUserMessage', text: 'Continue the remaining steps.' });
  assert.equal(continued.notice, undefined);
  const again = reduce(failed, {
    type: 'agentEvent',
    event: { type: 'turn/started', backendId: 'ollama', threadId: 'thread_1', turnId: 'turn_2' }
  });
  assert.equal(again.notice, undefined);
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
  assert.equal(started.changeReview?.turnId, 'turn_1', 'the panel keeps the last review to render it pending');
});

test('a new turn with no changes drops the previous review so no stale panel lingers', () => {
  const active = reduce(initialState, { type: 'conversation', backendId: 'codex', threadId: 't1' });
  const withReview = reduce(active, {
    type: 'changeReview',
    review: { backendId: 'codex', threadId: 't1', turnId: 'turn_1', files: [], additions: 0, deletions: 0, fullyDecided: false }
  });
  assert.equal(withReview.changeReview?.turnId, 'turn_1');

  const noop = reduce(withReview, {
    type: 'changesChanged',
    backendId: 'codex',
    threadId: 't1',
    turnId: 'turn_2',
    entries: []
  });
  assert.deepEqual(noop.changes, []);
  assert.equal(noop.changeReview, undefined, 'a verified no-op turn shows no review surface');
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
  assert.equal(repaint.changeReview?.turnId, 'turn_1', 'the same turn keeps its review across a repaint');
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
