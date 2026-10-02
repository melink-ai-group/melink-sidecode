/**
 * Collapse a flat transcript into major steps.
 *
 * Consecutive lookup, change, or command items become one summary row.
 * A message, reasoning card, approval, or anything we cannot classify
 * stays its own line and ends the current run. A single tool stays a
 * single row; a group exists only when two or more items share a family.
 */

import { isRawToolName } from '../backends/toolLabel.ts';
import type { ItemStatus, TranscriptItemView } from './state.ts';

export type ActivityFamily = 'lookup' | 'change' | 'command';

export type TranscriptEntry =
  | { kind: 'item'; item: TranscriptItemView }
  | { kind: 'group'; id: string; family: ActivityFamily; items: TranscriptItemView[] };

export interface ActivitySummary {
  label: string;
  status: ItemStatus;
}

type Bucket = 'file' | 'search' | 'edit' | 'delete' | 'command';

interface Classified {
  family: ActivityFamily;
  bucket: Bucket;
}

const FILE_TOOLS = new Set(['read', 'list', 'ls', 'listdir']);
const SEARCH_TOOLS = new Set([
  'grep',
  'search',
  'codesearch',
  'rg',
  'glob',
  'find',
  'webfetch',
  'web_fetch',
  'fetch',
  'websearch',
  'web_search'
]);
const EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'strreplace', 'apply_patch']);
const DELETE_TOOLS = new Set(['delete', 'remove']);
const COMMAND_TOOLS = new Set(['bash', 'shell', 'command', 'exec', 'powershell']);

/** Walk the transcript once and wrap each burst of the same family. */
export function groupTranscript(items: TranscriptItemView[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let family: ActivityFamily | undefined;
  let buffer: TranscriptItemView[] = [];

  const flush = (): void => {
    if (buffer.length === 0 || !family) {
      buffer = [];
      family = undefined;
      return;
    }
    if (buffer.length === 1) {
      entries.push({ kind: 'item', item: buffer[0] });
    } else {
      entries.push({ kind: 'group', id: buffer[0].id, family, items: buffer });
    }
    buffer = [];
    family = undefined;
  };

  for (const item of items) {
    const classified = classify(item);
    if (!classified) {
      flush();
      entries.push({ kind: 'item', item });
      continue;
    }
    if (family && classified.family !== family) {
      flush();
    }
    family = classified.family;
    buffer.push(item);
  }
  flush();
  return entries;
}

/** One line for a burst: present while it is still running, counts once it settles. */
export function activitySummary(items: TranscriptItemView[]): ActivitySummary {
  const status = groupStatus(items);
  const classified = items.flatMap((item) => {
    const next = classify(item);
    return next ? [next] : [];
  });
  const family = classified[0]?.family ?? 'lookup';
  const running = status === 'streaming';

  if (family === 'lookup') {
    return { status, label: running ? 'Exploring…' : exploredLabel(classified) };
  }
  if (family === 'command') {
    return { status, label: running ? 'Running…' : `Ran ${countPhrase(items.length, 'command', 'commands')}` };
  }
  const onlyDeletes = classified.length > 0 && classified.every((entry) => entry.bucket === 'delete');
  if (running) {
    return { status, label: onlyDeletes ? 'Deleting…' : 'Editing…' };
  }
  return { status, label: changedLabel(items, classified) };
}

function groupStatus(items: TranscriptItemView[]): ItemStatus {
  if (items.some((item) => item.status === 'streaming' || item.status === 'pending')) {
    return 'streaming';
  }
  if (items.some((item) => item.status === 'failed')) {
    return 'failed';
  }
  if (items.some((item) => item.status === 'canceled')) {
    return 'canceled';
  }
  if (items.some((item) => item.status === 'warning')) {
    return 'warning';
  }
  return 'completed';
}

function exploredLabel(classified: Classified[]): string {
  const files = classified.filter((entry) => entry.bucket === 'file').length;
  const searches = classified.filter((entry) => entry.bucket === 'search').length;
  const parts: string[] = [];
  if (files > 0) {
    parts.push(countPhrase(files, 'file', 'files'));
  }
  if (searches > 0) {
    parts.push(countPhrase(searches, 'search', 'searches'));
  }
  return parts.length > 0 ? `Explored ${parts.join(', ')}` : 'Explored';
}

function changedLabel(items: TranscriptItemView[], classified: Classified[]): string {
  const files = items.reduce((total, item) => total + filesTouched(item), 0);
  const deletes = classified.filter((entry) => entry.bucket === 'delete').length;
  const edits = classified.length - deletes;
  const phrase = countPhrase(files, 'file', 'files');
  if (edits === 0 && deletes > 0) {
    return `Deleted ${phrase}`;
  }
  if (deletes === 0) {
    return `Edited ${phrase}`;
  }
  return `Changed ${phrase}`;
}

function filesTouched(item: TranscriptItemView): number {
  if (item.files && item.files.length > 0) {
    return item.files.length;
  }
  return 1;
}

function countPhrase(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function classify(item: TranscriptItemView): Classified | undefined {
  if (item.kind === 'file-change') {
    return { family: 'change', bucket: startsWith(item.title, 'Deleting') ? 'delete' : 'edit' };
  }
  if (item.kind === 'notice' && item.title?.trim().toLowerCase() === 'web search') {
    return { family: 'lookup', bucket: 'search' };
  }
  if (item.kind !== 'tool') {
    return undefined;
  }
  const tool = toolId(item);
  if (tool) {
    return fromToolId(tool);
  }
  return fromTitle(item.title ?? '');
}

function toolId(item: TranscriptItemView): string | undefined {
  const explicit = item.tool?.trim().toLowerCase();
  if (explicit) {
    return explicit;
  }
  const title = item.title?.trim() ?? '';
  if (isRawToolName(title)) {
    return title.toLowerCase();
  }
  return undefined;
}

function fromToolId(tool: string): Classified | undefined {
  if (FILE_TOOLS.has(tool)) {
    return { family: 'lookup', bucket: 'file' };
  }
  if (SEARCH_TOOLS.has(tool)) {
    return { family: 'lookup', bucket: 'search' };
  }
  if (EDIT_TOOLS.has(tool)) {
    return { family: 'change', bucket: 'edit' };
  }
  if (DELETE_TOOLS.has(tool)) {
    return { family: 'change', bucket: 'delete' };
  }
  if (COMMAND_TOOLS.has(tool)) {
    return { family: 'command', bucket: 'command' };
  }
  return undefined;
}

/** Titles already produced by friendlyToolTitle, for threads that never stored a tool id. */
function fromTitle(title: string): Classified | undefined {
  if (startsWith(title, 'Searching the web')) {
    return { family: 'lookup', bucket: 'search' };
  }
  if (startsWith(title, 'Reading')) {
    return { family: 'lookup', bucket: 'file' };
  }
  if (startsWith(title, 'Searching')) {
    return { family: 'lookup', bucket: 'search' };
  }
  if (startsWith(title, 'Finding files')) {
    return { family: 'lookup', bucket: 'search' };
  }
  if (startsWith(title, 'Listing')) {
    return { family: 'lookup', bucket: 'file' };
  }
  if (startsWith(title, 'Fetching')) {
    return { family: 'lookup', bucket: 'search' };
  }
  if (startsWith(title, 'Editing') || startsWith(title, 'Writing')) {
    return { family: 'change', bucket: 'edit' };
  }
  if (startsWith(title, 'Deleting')) {
    return { family: 'change', bucket: 'delete' };
  }
  if (startsWith(title, 'Running')) {
    return { family: 'command', bucket: 'command' };
  }
  return undefined;
}

function startsWith(value: string | undefined, prefix: string): boolean {
  return (value ?? '').trim().toLowerCase().startsWith(prefix.toLowerCase());
}
