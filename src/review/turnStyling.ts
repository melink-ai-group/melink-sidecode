import type { ChangeView } from '../changes/changeStore.ts';
import type { DiffReviewResult } from './diffReview.ts';
import { buildTurnStylingReviewInput } from './reviewInput.ts';
import {
  STYLING_REVIEW_FAILURE_NOTICE,
  runStylingReview,
  type StylingBrandKitFile,
  type StylingReviewRunner
} from './stylingReview.ts';

export { STYLING_REVIEW_TIMEOUT_MS } from './stylingReview.ts';

/**
 * The host-free seam for one finished turn's advisory styling check.
 *
 * The host supplies the change view, the request that opened the turn, the
 * project's brand kit when one exists, and a store. This module decides nothing
 * about whether the pass is enabled: the host gates that before calling. It
 * only builds bounded input, runs the reviewer, and persists the result.
 */

/** Stored when the turn has no opening request text to review against. */
export const STYLING_REVIEW_NO_REQUEST_NOTICE =
  'The styling check could not find the message that opened this turn.';

/** The persistence slice the host binds to `ReviewStore`. */
export interface TurnStylingReviewStore {
  set(
    backendId: string,
    threadId: string,
    turnId: string,
    result: DiffReviewResult
  ): Promise<void>;
}

export interface RunTurnStylingReviewOptions {
  view: ChangeView;
  request?: string;
  brandKit?: readonly StylingBrandKitFile[];
  store: TurnStylingReviewStore;
  runner?: StylingReviewRunner;
  timeoutMs?: number;
}

/**
 * Run and persist one styling check. A missing request, a thrown runner, or a
 * missed deadline all become a non-blocking `failed` result; nothing escapes to
 * the caller, so the turn's change review still appears.
 */
export async function runTurnStylingReview(
  options: RunTurnStylingReviewOptions
): Promise<DiffReviewResult> {
  const request = options.request?.trim() ?? '';
  const result =
    request.length === 0
      ? {
          status: 'failed' as const,
          findings: [],
          notice: STYLING_REVIEW_NO_REQUEST_NOTICE
        }
      : await runStylingReview(
          buildTurnStylingReviewInput(options.view, request, options.brandKit),
          options.runner,
          options.timeoutMs
        );

  try {
    await options.store.set(
      options.view.backendId,
      options.view.threadId,
      options.view.turnId,
      result
    );
  } catch {
    // The check is advisory. A storage failure must not fail the turn; the
    // next reload simply has nothing persisted to restore.
  }
  return result;
}

/** The stable failure result so callers can render a visible notice. */
export const STYLING_CHECK_FAILED: DiffReviewResult = {
  status: 'failed',
  findings: [],
  notice: STYLING_REVIEW_FAILURE_NOTICE
};
