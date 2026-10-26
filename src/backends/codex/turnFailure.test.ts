import test from 'node:test';
import assert from 'node:assert/strict';
import type { TurnError } from '../../../schemas/v2/TurnError';
import { shouldAutoContinue } from '../threadRecovery.ts';
import { isRetryableCodexFailure } from './turnFailure.ts';

function turnError(message: string, codexErrorInfo: TurnError['codexErrorInfo'] = null): TurnError {
  return { message, codexErrorInfo, additionalDetails: null, misalignment: null };
}

test('the structured overload kind is retryable even with terse provider wording', () => {
  assert.equal(isRetryableCodexFailure(turnError('Something failed.', 'serverOverloaded')), true);
  assert.equal(isRetryableCodexFailure(turnError('', 'rateLimitExceeded')), true);
  assert.equal(isRetryableCodexFailure(turnError('', 'internalServerError')), true);
});

test('the HTTP-shaped connection kinds are retryable', () => {
  assert.equal(
    isRetryableCodexFailure(turnError('', { httpConnectionFailed: { httpStatusCode: 502 } })),
    true
  );
  assert.equal(
    isRetryableCodexFailure(turnError('', { responseStreamDisconnected: { httpStatusCode: null } })),
    true
  );
  assert.equal(
    isRetryableCodexFailure(
      turnError('', { responseStreamConnectionFailed: { httpStatusCode: 503 } })
    ),
    true
  );
  assert.equal(
    isRetryableCodexFailure(turnError('', { responseTooManyFailedAttempts: { httpStatusCode: 529 } })),
    true
  );
});

test('the newer CLI wording for a full model is retryable', () => {
  // The wording Codex 0.164 reports when the selected model has no capacity.
  assert.equal(
    isRetryableCodexFailure(turnError('Selected model is at capacity. Please try a different model.')),
    true
  );
  assert.equal(isRetryableCodexFailure(turnError('The engine is currently overloaded, please try again later')), true);
  assert.equal(isRetryableCodexFailure(turnError('Rate limit reached for requests')), true);
});

test('a terminal kind wins over a message that happens to mention a limit', () => {
  assert.equal(
    isRetryableCodexFailure(turnError('Rate limit reached: usage limit for this plan', 'usageLimitExceeded')),
    false
  );
  assert.equal(
    isRetryableCodexFailure(turnError('The model is overloaded', 'contextWindowExceeded')),
    false
  );
});

test('usage, context, auth and policy failures are never retried', () => {
  assert.equal(
    isRetryableCodexFailure(turnError("You've hit your usage limit. Try again at 11:00 AM.", 'usageLimitExceeded')),
    false
  );
  assert.equal(isRetryableCodexFailure(turnError('Session budget exceeded.', 'sessionBudgetExceeded')), false);
  assert.equal(isRetryableCodexFailure(turnError('Context window exceeded.', 'contextWindowExceeded')), false);
  assert.equal(isRetryableCodexFailure(turnError('Incorrect API key provided.', 'unauthorized')), false);
  assert.equal(isRetryableCodexFailure(turnError('Blocked by policy.', 'cyberPolicy')), false);
  assert.equal(isRetryableCodexFailure(turnError('Incorrect API key provided.')), false);
  assert.equal(isRetryableCodexFailure(turnError('The request was invalid.')), false);
});

test('a missing error is not retryable', () => {
  assert.equal(isRetryableCodexFailure(null), false);
  assert.equal(isRetryableCodexFailure(undefined), false);
});

test('the retryable wording reaches the host continuation, the terminal wording does not', () => {
  // The adapter rejects the pending turn with the provider sentence, so that
  // sentence must also satisfy the host's policy. The structured kind still
  // decides when the wording is new.
  const retryable = turnError('Selected model is at capacity. Please try a different model.', 'serverOverloaded');
  assert.equal(shouldAutoContinue(new Error(retryable.message), 0), true);
  assert.equal(shouldAutoContinue(new Error('Something surprising happened.'), 0), false);
  const terminal = turnError("You've hit your usage limit. Try again at 11:00 AM.", 'usageLimitExceeded');
  assert.equal(isRetryableCodexFailure(terminal), false);
  assert.equal(shouldAutoContinue(new Error(terminal.message), 0), false);
});
