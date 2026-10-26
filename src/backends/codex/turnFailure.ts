/**
 * Classification of a failed Codex turn.
 *
 * A turn can end `failed` for two very different reasons. Either the attempt
 * itself was interrupted by the model host — capacity, an upstream rate limit,
 * a dropped response stream, an internal server error — or the request can
 * never succeed as sent (usage limit, context window, auth, policy). Codex has
 * already retried the first kind internally by the time the turn ends, so the
 * only recovery left is the app's own bounded continuation. The second kind
 * must be shown as a terminal failure: re-sending it would loop.
 *
 * Kept pure and schema-typed so the rule is unit-testable and so a re-pin that
 * renames an error kind is a compile error here rather than a silent
 * misclassification at runtime.
 */

import type { CodexErrorInfo } from '../../../schemas/v2/CodexErrorInfo';
import type { TurnError } from '../../../schemas/v2/TurnError';

/**
 * Error kinds whose same turn may be sent again. `threadRollbackFailed` and the
 * connection variants are included because the model never answered: the work
 * is still outstanding. `usageLimitExceeded`, `sessionBudgetExceeded`,
 * `contextWindowExceeded`, `unauthorized`, the policy kinds and `badRequest`
 * are deliberately absent.
 */
const RETRYABLE_KINDS: ReadonlySet<string> = new Set([
  'serverOverloaded',
  'rateLimitExceeded',
  'internalServerError',
  'threadRollbackFailed',
  'responseTooManyFailedAttempts',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'httpConnectionFailed'
]);

/**
 * Kinds that mean the same turn cannot succeed unchanged. Only consulted when
 * the server does not send a usable `codexErrorInfo`, so a message that merely
 * mentions a limit never overrides an explicit kind.
 */
const TERMINAL_KINDS: ReadonlySet<string> = new Set([
  'usageLimitExceeded',
  'sessionBudgetExceeded',
  'contextWindowExceeded',
  'cyberPolicy',
  'misalignmentPolicyViolation',
  'unauthorized',
  'badRequest',
  'sandboxError',
  'activeTurnNotSteerable'
]);

/**
 * Provider wording used only when `codexErrorInfo` is absent or `other` (older
 * servers, and the pinned window includes them). The patterns are deliberately
 * narrow: no bare `error`, no bare `limit`, so an auth or policy sentence is
 * never swept in.
 */
const RETRYABLE_MESSAGE =
  /at capacity|overloaded|over capacity|rate limit|too many requests|\b429\b|temporarily unavailable|service unavailable|bad gateway|internal server error|server had an error|stream (disconnected|ended)|connection (reset|refused|closed|failed|aborted)|went quiet before it finished/i;

/** True when `codexErrorInfo` names a kind that is worth retrying. */
function retryableKind(info: CodexErrorInfo | null | undefined): boolean | undefined {
  if (info === null || info === undefined) {
    return undefined;
  }
  if (typeof info === 'string') {
    if (RETRYABLE_KINDS.has(info)) {
      return true;
    }
    if (TERMINAL_KINDS.has(info)) {
      return false;
    }
    // `other`: the kind says nothing useful, so the message may decide.
    return undefined;
  }
  const key = Object.keys(info)[0];
  if (key && RETRYABLE_KINDS.has(key)) {
    return true;
  }
  return undefined;
}

/**
 * True when a failed turn may be continued automatically. The caller uses this
 * to hand the turn back to the host's bounded continuation instead of leaving
 * the chat stopped and waiting for a click.
 */
export function isRetryableCodexFailure(error: TurnError | null | undefined): boolean {
  if (!error) {
    return false;
  }
  const kind = retryableKind(error.codexErrorInfo);
  if (kind !== undefined) {
    return kind;
  }
  return RETRYABLE_MESSAGE.test(error.message ?? '');
}
