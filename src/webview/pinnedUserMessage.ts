import { plainRowText } from './plainRowText.ts';
import { visibleTranscriptText } from './visibleTranscript.ts';

/** Preview length for a pinned user message. The row also clamps to three lines. */
export const PINNED_USER_MESSAGE_LIMIT = 280;

/**
 * How much of a user message may still peek in at the top before the compact
 * pin takes over. Below this, the full message is what the reader sees.
 */
export const PINNED_USER_MESSAGE_SLOP = 8;

/** A user message measured against the top of the transcript scrollport. */
export interface UserMessageFrame {
  id: string;
  /** Distance from the scrollport's top edge. Negative means it has moved above. */
  top: number;
  bottom: number;
}

/**
 * The user message that should sit at the top of the transcript.
 *
 * The relevant message is the latest one that has reached the top. It is pinned
 * only after it has scrolled fully past that edge, so a message still on screen
 * stays in its normal full form. Scrolling back down into an earlier message
 * releases the later pin and the previous message takes the top.
 */
export function pinnedUserMessage(
  frames: readonly UserMessageFrame[],
  slop = PINNED_USER_MESSAGE_SLOP
): string | undefined {
  let relevant: UserMessageFrame | undefined;
  for (const frame of frames) {
    // A message within `slop` of the top is already the one on screen. Picking
    // it (and then not pinning, because it is still visible) keeps the previous
    // message from covering it.
    if (frame.top <= slop) {
      relevant = frame;
    } else {
      break;
    }
  }
  if (!relevant || relevant.bottom > slop) {
    return undefined;
  }
  return relevant.id;
}

/** One block of plain text, cut on a word near the preview limit. */
export function pinnedUserPreview(text: string, limit = PINNED_USER_MESSAGE_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) {
    return flat;
  }
  const cut = flat.slice(0, limit);
  const word = cut.lastIndexOf(' ');
  return (word > limit * 0.6 ? cut.slice(0, word) : cut).trimEnd();
}

/** The words shown in the pin: the user's text, or the attachment names. */
export function userMessagePinText(text: string, attachmentNames: readonly string[] = []): string {
  const preview = pinnedUserPreview(plainRowText(visibleTranscriptText(text)));
  if (preview) {
    return preview;
  }
  if (attachmentNames.length > 0) {
    return attachmentNames.join(', ');
  }
  return 'Your message';
}
