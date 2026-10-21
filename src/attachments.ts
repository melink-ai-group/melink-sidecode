import type { Attachment } from './backends/types';

/** Largest pasted/attached file accepted client-side, matching the host cap. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Extension -> mime map for the formats the picker filter offers. */
export const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  webm: 'video/webm',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  jsonc: 'application/json',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/plain',
  csv: 'text/csv',
  log: 'text/plain',
  xml: 'application/xml',
  html: 'text/html',
  css: 'text/css',
  scss: 'text/css',
  less: 'text/css',
  js: 'text/javascript',
  jsx: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  kt: 'text/x-kotlin',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  hpp: 'text/x-c++',
  cs: 'text/x-csharp',
  sh: 'text/x-sh',
  ps1: 'text/x-powershell',
  sql: 'text/x-sql'
};

/** Provider-neutral mime for a filename; `application/octet-stream` when unknown. */
export function mimeForName(name: string): string {
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/** The broad class a chip uses, mirroring the host's mapping. */
export function kindForMime(mimeType: string): Attachment['kind'] {
  if (mimeType.startsWith('image/')) {
    return 'image';
  }
  if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) {
    return 'audio';
  }
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') {
    return 'text';
  }
  return 'file';
}

/** The file extension an attachment should be saved with. */
export function extensionForAttachment(attachment: Attachment): string {
  const fromName = attachment.name.includes('.') ? attachment.name.slice(attachment.name.lastIndexOf('.')) : '';
  if (fromName) {
    return fromName;
  }
  if (attachment.mimeType === 'image/jpeg') {
    return '.jpg';
  }
  if (attachment.mimeType === 'image/gif') {
    return '.gif';
  }
  if (attachment.mimeType === 'image/webp') {
    return '.webp';
  }
  return '.png';
}
