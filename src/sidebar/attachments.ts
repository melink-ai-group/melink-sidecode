import type { Attachment } from '../backends/types';
import { parseDraftAttachments, type ChatTabState } from '../chatTabs';

export {
  extensionForAttachment,
  kindForMime,
  MAX_ATTACHMENT_BYTES,
  MIME_BY_EXTENSION,
  mimeForName
} from '../attachments';

/** Stable-enough id for a chip; the webview only needs it to key and remove. */
export function createAttachmentId(): string {
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Metadata saved with the open tabs. Inline bytes stay out of workspace state. */
export function draftAttachmentsForStore(attachments: readonly Attachment[]): NonNullable<ChatTabState['draftAttachments']> {
  return parseDraftAttachments(persistableAttachments(attachments) ?? []);
}

export function decodeDataUrl(dataUrl: string): Uint8Array | undefined {
  const match = /^data:[^;,]+;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match?.[1]) {
    return undefined;
  }
  return Buffer.from(match[1], 'base64');
}

export function safeDraftFileName(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  return cleaned || 'attachment';
}

/** Strip inline bytes before an attachment is persisted. The path, when one was saved, stays. */
export function persistableAttachments(attachments?: readonly Attachment[]): Attachment[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }
  return attachments.map(({ dataUrl: _dataUrl, ...rest }) => rest);
}
