import type { Attachment } from '../backends/types';

/** Unsent composer text and files for one chat tab. */
export interface ComposerDraft {
  text: string;
  attachments: Attachment[];
}

export function emptyComposerDraft(): ComposerDraft {
  return { text: '', attachments: [] };
}

/**
 * Remember the composer when the open tab changes.
 * A new-chat carry is copied onto the destination. The source keeps its own copy.
 * A tab with no local draft must not be written back until the host restores it.
 */
export function switchComposerDraft(
  remembered: Readonly<Record<string, ComposerDraft>>,
  previousTabId: string | undefined,
  nextTabId: string | undefined,
  current: ComposerDraft,
  carry: ComposerDraft | undefined
): {
  remembered: Record<string, ComposerDraft>;
  next: ComposerDraft;
  carried: boolean;
  waitForHost: boolean;
} {
  const nextRemembered: Record<string, ComposerDraft> = { ...remembered };
  if (previousTabId && previousTabId !== nextTabId) {
    nextRemembered[previousTabId] = {
      text: current.text,
      attachments: current.attachments.map((attachment) => ({ ...attachment }))
    };
  }
  if (!nextTabId || previousTabId === nextTabId) {
    return { remembered: nextRemembered, next: current, carried: false, waitForHost: false };
  }
  if (carry) {
    const copied: ComposerDraft = {
      text: carry.text,
      attachments: carry.attachments.map((attachment) => ({ ...attachment }))
    };
    nextRemembered[nextTabId] = copied;
    return { remembered: nextRemembered, next: copied, carried: true, waitForHost: false };
  }
  const stored = nextRemembered[nextTabId];
  if (stored) {
    return { remembered: nextRemembered, next: stored, carried: false, waitForHost: false };
  }
  return { remembered: nextRemembered, next: emptyComposerDraft(), carried: false, waitForHost: true };
}

/**
 * Apply a draft the host restored after a reload.
 * A tab the user has already edited, or one already remembered, keeps its local text.
 */
export function acceptComposerRestore(
  remembered: Readonly<Record<string, ComposerDraft>>,
  tabId: string,
  dirty: boolean,
  incoming?: ComposerDraft
): boolean {
  if (dirty) {
    return false;
  }
  const stored = remembered[tabId];
  if (stored === undefined) {
    return true;
  }
  // Send clears the composer before the host can refuse. The refusal puts the
  // text back, and that empty local draft must not block it.
  return (
    incoming !== undefined &&
    stored.text.trim() === '' &&
    stored.attachments.length === 0 &&
    (incoming.text.trim() !== '' || incoming.attachments.length > 0)
  );
}

/**
 * Attachments for a host save. Inline image bytes travel once; later saves send
 * the id and path so a keystroke does not repeat the file.
 */
export function hostAttachments(attachments: readonly Attachment[], sentBytes: Set<string>): Attachment[] {
  return attachments.map((attachment) => {
    if (!attachment.dataUrl || sentBytes.has(attachment.id)) {
      const { dataUrl: _dataUrl, ...rest } = attachment;
      return rest;
    }
    sentBytes.add(attachment.id);
    return { ...attachment };
  });
}
