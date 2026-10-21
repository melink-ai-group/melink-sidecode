import type { TranscriptItem } from '../backends/types.ts';
import type { ChangeView } from '../changes/changeStore.ts';
import {
  runDiffReview,
  type DiffReviewResult,
  type DiffReviewRunner
} from './diffReview.ts';
import { buildTurnDiffReviewInput } from './reviewInput.ts';

/**
 * The host-free orchestration seam for one finished turn's advisory review.
 *
 * The host supplies the already-composed `ChangeView`, the opening user request,
 * a store seam, and optionally a model runner. This module decides only whether
 * to run, bounds the input, and persists the result. It never edits files, never
 * touches the journal or a checkpoint, and never changes a Keep/Reject decision.
 */

/** Default deadline for one review pass. A timeout becomes a visible failure. */
export const DIFF_REVIEW_TIMEOUT_MS = 15_000;

/** Stored when the turn has no opening request text to review against. */
export const DIFF_REVIEW_NO_REQUEST_NOTICE =
  'The diff review could not find the message that opened this turn.';

/**
 * The opt-in gate: the review runs only for an enabled workspace and a turn
 * that actually observed changes. Kept pure so the host's decision is testable
 * without a setting API or a running turn.
 */
export function shouldRunDiffReview(
  enabled: boolean,
  entries: readonly unknown[]
): boolean {
  return enabled && entries.length > 0;
}

/** The persistence slice the host binds to `ReviewStore`. */
export interface TurnDiffReviewStore {
  set(
    backendId: string,
    threadId: string,
    turnId: string,
    result: DiffReviewResult
  ): Promise<void>;
}

export interface RunTurnDiffReviewOptions {
  view: ChangeView;
  request?: string;
  store: TurnDiffReviewStore;
  runner?: DiffReviewRunner;
  timeoutMs?: number;
}

/**
 * Run and persist one turn review. A missing request, a thrown runner, or a
 * missed deadline all become a `failed` result with a non-blocking notice; no
 * failure escapes to the caller, so the turn's review panel and checkpoints
 * still appear.
 */
export async function runTurnDiffReview(
  options: RunTurnDiffReviewOptions
): Promise<DiffReviewResult> {
  const request = options.request?.trim() ?? '';
  const result =
    request.length === 0
      ? {
          status: 'failed' as const,
          findings: [],
          notice: DIFF_REVIEW_NO_REQUEST_NOTICE
        }
      : await runDiffReview(
          buildTurnDiffReviewInput(options.view, request),
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
    // The review is advisory. A storage failure must not fail the turn or hide
    // the findings that were just computed; the next reload simply has nothing
    // persisted to restore.
  }
  return result;
}

/**
 * Resolve the request that opened a turn.
 *
 * `messageId` is authoritative when the journal recorded it and the transcript
 * still has that user message. Otherwise the latest user message is the safest
 * fallback: a turn with no recorded message id still has one user request that
 * preceded it. Returns `undefined` when no non-empty user text exists.
 */
export function turnRequestText(
  transcript: readonly TranscriptItem[],
  messageId?: string
): string | undefined {
  if (messageId !== undefined) {
    const opening = transcript.find((item) => item.id === messageId);
    const openingText = userText(opening);
    if (openingText !== undefined) {
      return openingText;
    }
  }
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const text = userText(transcript[index]);
    if (text !== undefined) {
      return text;
    }
  }
  return undefined;
}

function userText(item: TranscriptItem | undefined): string | undefined {
  if (!item || item.kind !== 'message' || item.role !== 'user') {
    return undefined;
  }
  const text = item.text?.trim();
  return text && text.length > 0 ? text : undefined;
}
