import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Attachment } from '../types.ts';
import { isAbsoluteExecutable } from '../executables.ts';

/** OpenCode's native prompt limit is lower than the composer's 25 MiB cap. */
export const OPENCODE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface OpencodeAttachmentFile {
  uri: string;
  name: string;
  mime: string;
}

/** Explicit user attachments travel as native media/text parts, never argv,
 * invented workspace files, or a bare filename the model cannot open.
 */
export async function prepareOpencodeAttachments(attachments: readonly Attachment[] = []): Promise<OpencodeAttachmentFile[]> {
  const files: OpencodeAttachmentFile[] = [];
  for (const attachment of attachments) {
    const name = attachment.name.replace(/[\r\n]/g, ' ');
    const mime = attachment.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : attachment.mimeType.split(';')[0].trim().toLowerCase();
    const supported = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'application/pdf', 'application/json', 'application/xml'].includes(mime) || mime.startsWith('text/');
    if (!supported) throw new Error(`OpenCode cannot send the attachment "${name}" (${mime}). Attach text, a PDF, or a PNG, JPEG, GIF, or WebP image.`);
    if ((attachment.size ?? 0) > OPENCODE_ATTACHMENT_BYTES) throw new Error(`The attachment "${name}" exceeds OpenCode's 20 MiB limit.`);
    let uri: string;
    if (attachment.dataUrl) {
      const match = /^data:([^;,]+)(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/]*={0,2})$/.exec(attachment.dataUrl);
      if (!match || match[1].toLowerCase() !== mime || (!match[2] && !mime.startsWith('text/')) || match[2].length % 4 !== 0) throw new Error(`The attachment "${name}" has invalid inline content. Attach it again.`);
      if (Buffer.byteLength(match[2], 'base64') > OPENCODE_ATTACHMENT_BYTES) throw new Error(`The attachment "${name}" exceeds OpenCode's 20 MiB limit.`);
      uri = attachment.dataUrl;
    } else if (attachment.path && isAbsoluteExecutable(attachment.path)) {
      const info = await stat(attachment.path).catch(() => undefined);
      if (!info?.isFile()) throw new Error(`The attachment "${name}" is no longer readable. Attach it again.`);
      if (info.size > OPENCODE_ATTACHMENT_BYTES) throw new Error(`The attachment "${name}" exceeds OpenCode's 20 MiB limit.`);
      uri = pathToFileURL(attachment.path).href;
    } else {
      throw new Error(`The attachment "${name}" has no readable content. Attach it again.`);
    }
    files.push({ uri, name, mime });
  }
  return files;
}

/** V1 file parts and V2 file references deliberately have different shapes. */
export function opencodeV1Parts(prompt: string, files: readonly OpencodeAttachmentFile[] = []): unknown[] {
  return [{ type: 'text', text: prompt }, ...files.map((file) => ({ type: 'file', url: file.uri, filename: file.name,
    mime: file.mime === 'image/svg+xml' ? 'text/plain' : file.mime }))];
}

export function opencodeV2Prompt(prompt: string, files: readonly OpencodeAttachmentFile[] = []): Record<string, unknown> {
  return { text: prompt, ...(files.length ? { files: files.map(({ uri, name }) => ({ uri, name })) } : {}) };
}

/** Custom providers otherwise default to text-only and silently replace media
 * with a note. Preserve known model capabilities; for unknown models forward
 * the requested modality and let the provider accept or reject it explicitly.
 */
export function opencodeAttachmentConfig(config: Record<string, unknown>, modelRef: string, files: readonly OpencodeAttachmentFile[]): Record<string, unknown> {
  const media = [...new Set(files.flatMap((file) => file.mime === 'application/pdf' ? ['pdf'] : file.mime.startsWith('image/') && file.mime !== 'image/svg+xml' ? ['image'] : []))];
  if (!media.length) return config;
  const slash = modelRef.indexOf('/');
  const providerId = modelRef.slice(0, slash);
  const modelId = modelRef.slice(slash + 1);
  const providers = config.provider as Record<string, Record<string, unknown>> | undefined;
  const provider = providers?.[providerId];
  const models = provider?.models as Record<string, Record<string, unknown>> | undefined;
  const model = models?.[modelId];
  if (!provider || !models || !model) throw new Error('The selected OpenCode model configuration is unavailable for attachments. Refresh models and try again.');
  const modalities = model.modalities as { input?: string[]; output?: string[] } | undefined;
  if (modalities?.input && media.some((item) => !modalities.input!.includes(item))) {
    throw new Error('The selected model does not support this attachment type. Choose a model with the required image or PDF input.');
  }
  return { ...config, provider: { ...providers, [providerId]: { ...provider, models: { ...models, [modelId]: { ...model,
    modalities: { input: modalities?.input ?? ['text', ...media], output: modalities?.output ?? ['text'] }
  } } } } };
}
