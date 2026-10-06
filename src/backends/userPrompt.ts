import type { Attachment, AttachmentKind } from './types.ts';

/**
 * The "Attached files:" section `turnInput` adds in front of the user's words.
 * A restored Codex turn stores that whole provider text. The section is not
 * part of what the user wrote, and the lines are the attachment list.
 */
const ATTACHMENT_SECTION = /(?:^|\n{2})Attached files:\n((?:(?:Image|File): [^\n]*\n?)+)/g;

const LINE = /^(Image|File): ([^\n]*?)(?: \((.+)\))?$/;

/** Remove the provider attachment section and return the files it named. */
export function takeAttachmentSection(text: string): { text: string; attachments: Attachment[] } {
  const attachments: Attachment[] = [];
  const next = text.replace(ATTACHMENT_SECTION, (_match, body: string) => {
    attachments.push(...attachmentsFromSection(body));
    return '\n\n';
  });
  return { text: next.replace(/\n{3,}/g, '\n\n').trim(), attachments };
}

function attachmentsFromSection(body: string): Attachment[] {
  const attachments: Attachment[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const match = LINE.exec(line);
    if (!match) {
      continue;
    }
    const kind: AttachmentKind = match[1] === 'Image' ? 'image' : 'file';
    const name = (match[2] ?? '').trim();
    const path = match[3]?.trim();
    if (!name && !path) {
      continue;
    }
    const shown = name || basename(path ?? '');
    attachments.push({
      id: `file_${path ?? shown}`,
      name: shown,
      ...(path ? { path } : {}),
      mimeType: kind === 'image' ? mimeForName(shown) : 'application/octet-stream',
      kind
    });
  }
  return attachments;
}

function basename(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function mimeForName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lower.endsWith('.gif')) {
    return 'image/gif';
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp';
  }
  return 'image/png';
}
