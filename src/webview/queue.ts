import type { BackendStatus } from '../backends/types';
import { canSteer } from './steer.ts';

/**
 * What the composer should do with its current text and attachments.
 *
 * While a turn is running, a send can only steer when the provider accepts a
 * text-only steer and there are no attachments. Everything else is queued for
 * the host to start after the turn; an idle composer always sends normally.
 */
export type SendIntent = 'blocked' | 'send' | 'steer' | 'queue';

export interface SendIntentInput {
  busy: boolean;
  backendId: string | undefined;
  backendStatus: BackendStatus | undefined;
  text: string;
  attachmentCount: number;
  restoring: boolean;
  pendingApproval: boolean;
  askingQuestion: boolean;
  modeSwitch: boolean;
}

export function sendIntent(input: SendIntentInput): SendIntent {
  const text = input.text.trim();
  const hasContent = text.length > 0 || input.attachmentCount > 0;
  if (
    !hasContent ||
    input.restoring ||
    input.pendingApproval ||
    input.askingQuestion ||
    input.modeSwitch ||
    input.backendStatus !== 'available'
  ) {
    return 'blocked';
  }
  if (!input.busy) {
    return 'send';
  }
  return canSteer({
    busy: true,
    backendId: input.backendId,
    backendStatus: input.backendStatus,
    hasDraft: text.length > 0,
    attachmentCount: input.attachmentCount,
    restoring: input.restoring,
    pendingApproval: input.pendingApproval,
    askingQuestion: input.askingQuestion,
    modeSwitch: input.modeSwitch
  })
    ? 'steer'
    : 'queue';
}

/** The host previews queued text at this length; keep both sides equal. */
export const QUEUED_TEXT_PREVIEW_LIMIT = 80;

/**
 * The same preview the host builds for `QueuedTurnEntryView`, so the webview
 * can recognize its own entry in a `queuedTurns` echo without carrying ids.
 */
export function queuedTextPreview(text: string, limit = QUEUED_TEXT_PREVIEW_LIMIT): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1).trimEnd()}\u2026` : collapsed;
}

export interface QueuedPreviewEntry {
  textPreview: string;
  attachmentCount: number;
}

/** True when the host's echo contains the message the composer just queued. */
export function queuedEntryMatches(
  entries: readonly QueuedPreviewEntry[],
  text: string,
  attachmentCount: number
): boolean {
  const preview = queuedTextPreview(text);
  return entries.some(
    (entry) => entry.textPreview === preview && entry.attachmentCount === attachmentCount
  );
}

/** Compare chip sets by id, which is all the webview retains after a send. */
export function sameAttachmentIds(
  left: readonly { id: string }[],
  right: readonly { id: string }[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const ids = new Set(left.map((attachment) => attachment.id));
  return right.every((attachment) => ids.has(attachment.id));
}
