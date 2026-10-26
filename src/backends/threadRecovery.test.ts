import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpcError } from './appserver/jsonrpc.ts';
import { BackendError } from './types.ts';
import {
  STOP_CONTINUE_ATTEMPTS,
  continueAfterStopInstruction,
  isMissingThreadError,
  isTransientProviderError,
  recoveryHandover,
  recoveryInstructions,
  isQuietTurnError,
  quietContinueNotice,
  shouldAutoContinue,
  stopContinueNotice,
  threadRecoveredNotice,
  transientContinueNotice
} from './threadRecovery.ts';

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

test('a stopped provider continues a few times before the error is shown', () => {
  const stopped = new Error('The Codex app-server stopped unexpectedly.');
  assert.equal(shouldAutoContinue(stopped, 0), true);
  assert.equal(shouldAutoContinue(stopped, STOP_CONTINUE_ATTEMPTS - 1), true);
  assert.equal(shouldAutoContinue(stopped, STOP_CONTINUE_ATTEMPTS), false);
  assert.equal(shouldAutoContinue(new Error('Turn canceled.'), 0), false);
  assert.equal(shouldAutoContinue(new Error('The opencode CLI was not found.'), 0), false);
  assert.match(stopContinueNotice(1), /1 of 3/);
  assert.match(continueAfterStopInstruction(), /latest changes/);
  const quiet = new Error('The turn went quiet before it finished.');
  assert.equal(isQuietTurnError(quiet), true);
  assert.equal(shouldAutoContinue(quiet, 0), true);
  assert.equal(shouldAutoContinue(quiet, STOP_CONTINUE_ATTEMPTS), false);
  assert.match(quietContinueNotice(1), /Nothing new arrived/);
  assert.equal(isQuietTurnError(stopped), false);
});

test('a temporary provider failure continues instead of waiting for a click', () => {
  // The wording Codex sends when the selected model has no capacity, and the
  // other upstream failures a fresh turn can survive.
  for (const message of [
    'Selected model is at capacity. Please try a different model.',
    'The engine is currently overloaded, please try again later',
    'Rate limit reached for requests',
    '429 Too Many Requests',
    'Service unavailable',
    'Internal server error',
    'The response stream disconnected before the turn completed',
    'connection reset by peer'
  ]) {
    assert.equal(shouldAutoContinue(new Error(message), 0), true, message);
    assert.equal(isTransientProviderError(new Error(message)), true, message);
    assert.equal(
      shouldAutoContinue(new Error(message), STOP_CONTINUE_ATTEMPTS),
      false,
      `${message} must still respect the attempt cap`
    );
  }
  assert.match(transientContinueNotice(1), /temporary failure/);
  assert.match(transientContinueNotice(1), /1 of 3/);
});

test('a usage limit, auth failure, or cancel never joins the automatic continuation', () => {
  for (const message of [
    "You've hit your usage limit. Try again at 11:00 AM.",
    'Incorrect API key provided.',
    'Your authentication token has expired.',
    'Turn canceled.'
  ]) {
    assert.equal(shouldAutoContinue(new Error(message), 0), false, message);
    assert.equal(isTransientProviderError(new Error(message)), false, message);
  }
});

test('a backend-marked retryable failure continues even when its wording is new', () => {
  // A newer CLI may reword a structured failure. The adapter marks the kind, so
  // the host does not depend on the sentence.
  const marked = new BackendError('provider', 'Something surprising happened.');
  marked.retryable = true;
  assert.equal(shouldAutoContinue(marked, 0), true);
  assert.equal(shouldAutoContinue(marked, STOP_CONTINUE_ATTEMPTS), false);
  assert.equal(isTransientProviderError(marked), true);
  assert.equal(shouldAutoContinue(new BackendError('provider', 'Something surprising happened.'), 0), false);
});
