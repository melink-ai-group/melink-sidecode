import { basename } from 'node:path';
import type { Attachment } from '../backends/types';
import { createAttachmentId, MAX_ATTACHMENT_BYTES } from '../attachments.ts';
import { screenshotBaseName, screenshotTimestamp } from './screenshots.ts';

/**
 * Turn a PNG captured from the browser into a composer attachment.
 *
 * With a saved file the attachment points at it and keeps the PNG only for the
 * chip preview; without a workspace the inline `dataUrl` is the attachment and
 * the host writes it beside the draft. The name is always a basename, so no
 * directory or query string leaks into the chip.
 */
export interface BrowserCaptureInput {
  pngBase64: string;
  title: string;
  url: string;
  /** Absolute file written under `.melink/reports/browser/`, when a workspace is open. */
  path?: string;
  kind: 'page' | 'snippet';
  now?: Date;
}

export function browserImageAttachment(input: BrowserCaptureInput): Attachment {
  const bytes = Buffer.from(input.pngBase64, 'base64');
  if (bytes.byteLength === 0) {
    throw new Error('The capture was empty.');
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error('The capture is too large to attach.');
  }
  const name = input.path
    ? basename(input.path)
    : `${input.kind}-${screenshotTimestamp(input.now ?? new Date())}-${screenshotBaseName(
        input.title,
        input.url
      )}.png`;
  return {
    id: createAttachmentId(),
    name,
    ...(input.path ? { path: input.path } : {}),
    mimeType: 'image/png',
    size: bytes.byteLength,
    dataUrl: `data:image/png;base64,${input.pngBase64}`,
    kind: 'image'
  };
}
