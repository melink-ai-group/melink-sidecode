import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpcError } from './appserver/jsonrpc.ts';
import { isMissingThreadError, recoveryHandover, recoveryInstructions, threadRecoveredNotice } from './threadRecovery.ts';

test('a missing provider thread is recognized, and a missing CLI is not', () => {
  assert.equal(isMissingThreadError(new Error('thread not found: thr_123')), true);
  assert.equal(isMissingThreadError('Codex thread thr_123 is no longer available.'), true);
  assert.equal(isMissingThreadError('The saved opencode session is no longer available.'), true);
  assert.equal(isMissingThreadError('No such thread'), true);
  assert.equal(isMissingThreadError('no rollout found for thread id'), true);
  assert.equal(isMissingThreadError(new JsonRpcError({ code: -32000, message: 'failed to load thread', data: { id: 'thr_1' } })), true);
  assert.equal(isMissingThreadError('The opencode CLI was not found.'), false);
  assert.equal(isMissingThreadError('Codex CLI not found at "codex".'), false);
  assert.equal(isMissingThreadError('Codex is overloaded right now. Try again shortly.'), false);
  assert.equal(isMissingThreadError('Incorrect API key provided.'), false);
});

test('a lost thread carries the chat, the latest files, and the remaining work', () => {
  const handover = recoveryHandover({
    provider: 'Codex',
    transcript: [
      { kind: 'message', role: 'user', text: 'Fix the ring' },
      { kind: 'message', role: 'assistant', text: 'I started the ring.' },
      { kind: 'file-change', files: [{ path: 'src/old.ts', additions: 1, deletions: 0 }] },
      { kind: 'file-change', files: [{ path: 'src/ring.ts', additions: 12, deletions: 3 }] },
      { kind: 'message', role: 'user', text: 'Continue' }
    ],
    plan: {
      path: '.melink/plans/thr.md',
      title: 'Ring',
      summary: 'Show usage on the ring.',
      steps: [
        { text: 'Paint the ring', status: 'completed' },
        { text: 'Wire the refresh', status: 'pending' }
      ]
    },
    omitTrailingUserText: 'Continue'
  });
  assert.match(handover ?? '', /previous Codex thread no longer exists/);
  assert.match(handover ?? '', /User: Fix the ring/);
  assert.match(handover ?? '', /Assistant: I started the ring/);
  assert.equal((handover ?? '').includes('User: Continue'), false);
  assert.match(handover ?? '', /src\/ring\.ts \(\+12 -3\)/);
  assert.match(handover ?? '', /src\/old\.ts \(\+1 -0\)/);
  assert.match(handover ?? '', /Wire the refresh/);
  assert.match(handover ?? '', /\[pending\]/);
  assert.match(handover ?? '', /Latest request: Continue/);
  assert.match(threadRecoveredNotice('Codex'), /latest file changes/);
  assert.match(threadRecoveredNotice('OpenCode'), /opencode session/);
});

test('the replacement instructions keep the record ahead of the project snapshot', () => {
  const instructions = recoveryInstructions('Keep the plan.', 'Project: sidebar');
  assert.ok(instructions.indexOf('Keep the plan.') < instructions.indexOf('Project: sidebar'));
});

test('an empty record does not invent a handover', () => {
  assert.equal(recoveryHandover({ provider: 'OpenCode', transcript: [] }), undefined);
});
