/**
 * Collapse a flat transcript into major steps.
 *
 * Reasoning, lookups, and commands are one investigation. They stay on a
 * single collapsed line until a major change: an edit, a message, an
 * approval, or a tool we cannot classify. Edits group with other edits.
 * A single item stays the row it already is.
 */

import { isRawToolName, isZvecSemanticSearch } from '../backends/toolLabel.ts';
import { messageSentAt } from '../backends/turnTiming.ts';
import { plainRowText } from './plainRowText.ts';
import type { ItemStatus, TranscriptItemView } from './state.ts';

export type ActivityFamily = 'lookup' | 'change' | 'command' | 'work';

export type TranscriptEntry =
  | { kind: 'item'; item: TranscriptItemView }
  | { kind: 'group'; id: string; family: ActivityFamily; items: TranscriptItemView[] }
  | { kind: 'narration'; id: string; message: TranscriptItemView; items: TranscriptItemView[] };

/** One reasoning highlight and the tool calls that followed it. */
export interface ActivitySection {
  id: string;
  reasoning?: TranscriptItemView;
  tools: TranscriptItemView[];
}

/** Consecutive tool calls of one family, nested under a section. */
export interface ToolBurst {
  id: string;
  family: ActivityFamily;
  items: TranscriptItemView[];
}

export interface ActivitySummary {
  label: string;
  /** Counts, when the label is a reasoning highlight. */
  detail?: string;
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

/** Walk the transcript once. Investigation stays together; an edit starts a new line. */
export function groupTranscript(items: TranscriptItemView[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let run: 'work' | 'change' | undefined;
  let buffer: TranscriptItemView[] = [];

  const flush = (): void => {
    if (buffer.length === 0 || !run) {
      buffer = [];
      run = undefined;
      return;
    }
    if (buffer.length === 1) {
      entries.push({ kind: 'item', item: buffer[0] });
    } else {
      entries.push({ kind: 'group', id: buffer[0].id, family: groupFamily(buffer), items: buffer });
    }
    buffer = [];
    run = undefined;
  };

  for (const item of items) {
    const next = runOf(item);
    if (!next) {
      flush();
      entries.push({ kind: 'item', item });
      continue;
    }
    if (run && next !== run) {
      flush();
    }
    run = next;
    buffer.push(item);
  }
  flush();
  return foldNarration(entries);
}

/**
 * A one-line assistant sentence becomes the row for the lookups and commands
 * that follow it. The sentence is the click target; the calls stay inside.
 * An edit, a reply with more than one line, or another message starts a new row.
 */
function foldNarration(entries: TranscriptEntry[]): TranscriptEntry[] {
  const folded: TranscriptEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.kind !== 'item' || !isNarrationMessage(entry.item)) {
      folded.push(entry);
      continue;
    }
    const details: TranscriptItemView[] = [];
    let next = index + 1;
    while (next < entries.length && isDetailEntry(entries[next])) {
      details.push(...itemsOf(entries[next]));
      next += 1;
    }
    if (details.length === 0) {
      folded.push(entry);
      continue;
    }
    folded.push({ kind: 'narration', id: entry.item.id, message: entry.item, items: details });
    index = next - 1;
  }
  return folded;
}

/**
 * Entry id that should carry the finished-turn note. The note sits under the
 * last row of the turn that started at the user message storing `workedMs`,
 * and it stays there. A later message that opened its own turn gets its own
 * note once that turn finishes. A steer, which has no start time, stays in
 * the turn already open.
 */
export function turnElapsedNotes(entries: TranscriptEntry[]): Map<string, number> {
  const notes = new Map<string, number>();
  let workedMs: number | undefined;
  let lastId: string | undefined;
  const flush = (): void => {
    if (lastId != null && workedMs != null) {
      notes.set(lastId, workedMs);
    }
    workedMs = undefined;
    lastId = undefined;
  };
  for (const entry of entries) {
    if (entry.kind === 'item' && entry.item.kind === 'message' && entry.item.role === 'user') {
      const opensTurn = entry.item.workedMs != null || messageSentAt(entry.item) != null;
      if (opensTurn) {
        flush();
        if (entry.item.workedMs != null) {
          workedMs = entry.item.workedMs;
        }
      } else if (workedMs != null) {
        lastId = entry.item.id;
      }
      continue;
    }
    if (workedMs == null || (entry.kind === 'item' && entry.item.kind === 'notice')) {
      continue;
    }
    lastId = entry.kind === 'item' ? entry.item.id : entry.id;
  }
  flush();
  return notes;
}

/** Ids of replies that should show the speaker name: the first, and the last once the turn has settled. */
export function speakerRows(entries: TranscriptEntry[], settled: boolean): Set<string> {
  const shown = new Set<string>();
  const turns: string[][] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) {
      turns.push(current);
    }
    current = [];
  };
  for (const entry of entries) {
    if (entry.kind === 'item' && entry.item.kind === 'message' && entry.item.role === 'user') {
      flush();
      continue;
    }
    const id = replyId(entry);
    if (id) {
      current.push(id);
    }
  }
  flush();
  turns.forEach((ids, index) => {
    shown.add(ids[0]);
    const turnSettled = settled || index < turns.length - 1;
    if (turnSettled && ids.length > 1) {
      shown.add(ids[ids.length - 1]);
    }
  });
  return shown;
}

function replyId(entry: TranscriptEntry): string | undefined {
  if (entry.kind === 'narration') {
    return entry.id;
  }
  if (entry.kind === 'item' && entry.item.kind === 'message' && entry.item.role === 'assistant') {
    return entry.item.id;
  }
  return undefined;
}

function isNarrationMessage(item: TranscriptItemView): boolean {
  if (item.kind !== 'message' || item.role !== 'assistant') {
    return false;
  }
  const text = item.text.trim();
  return text.length > 0 && !/[\r\n]/.test(text);
}

function isDetailEntry(entry: TranscriptEntry): boolean {
  if (entry.kind === 'group') {
    return entry.family !== 'change';
  }
  if (entry.kind === 'narration') {
    return false;
  }
  return isDetailItem(entry.item);
}

function isDetailItem(item: TranscriptItemView): boolean {
  if (item.kind === 'reasoning') {
    return true;
  }
  if (item.kind === 'notice' && item.title?.trim().toLowerCase() === 'web search') {
    return true;
  }
  if (item.kind === 'tool') {
    return runOf(item) !== 'change';
  }
  return false;
}

function itemsOf(entry: TranscriptEntry): TranscriptItemView[] {
  if (entry.kind === 'group') {
    return entry.items;
  }
  if (entry.kind === 'narration') {
    return [entry.message, ...entry.items];
  }
  return [entry.item];
}

/**
 * Pair each reasoning highlight with the tool calls that followed it,
 * up to the next thought. Calls before the first thought stand alone.
 */
export function activitySections(items: TranscriptItemView[]): ActivitySection[] {
  const sections: ActivitySection[] = [];
  let reasoning: TranscriptItemView | undefined;
  let tools: TranscriptItemView[] = [];

  const flush = (): void => {
    if (!reasoning && tools.length === 0) {
      return;
    }
    sections.push({
      id: reasoning?.id ?? tools[0].id,
      ...(reasoning ? { reasoning } : {}),
      tools
    });
    reasoning = undefined;
    tools = [];
  };

  for (const item of items) {
    if (item.kind === 'reasoning') {
      flush();
      reasoning = item;
      continue;
    }
    tools.push(item);
  }
  flush();
  return sections;
}

/** Split a section's tools into consecutive same-family bursts. */
export function toolBursts(items: TranscriptItemView[]): ToolBurst[] {
  const bursts: ToolBurst[] = [];
  let family: ActivityFamily | undefined;
  let buffer: TranscriptItemView[] = [];

  const flush = (): void => {
    if (buffer.length === 0 || !family) {
      buffer = [];
      family = undefined;
      return;
    }
    bursts.push({ id: buffer[0].id, family, items: buffer });
    buffer = [];
    family = undefined;
  };

  for (const item of items) {
    const classified = classify(item);
    const next = classified?.family ?? 'work';
    if (family && next !== family) {
      flush();
    }
    family = next;
    buffer.push(item);
  }
  flush();
  return bursts;
}

/** One line for a step. A thought is the highlight; counts sit beside it. */
export function activitySummary(items: TranscriptItemView[]): ActivitySummary {
  const status = groupStatus(items);
  const classified = items.flatMap((item) => {
    const next = classify(item);
    return next ? [next] : [];
  });
  const family = groupFamily(items);
  const running = status === 'streaming';
  const highlight = latestThought(items);

  if (family === 'change') {
    const onlyDeletes = classified.length > 0 && classified.every((entry) => entry.bucket === 'delete');
    if (running) {
      return { status, label: onlyDeletes ? 'Deleting…' : 'Editing…' };
    }
    return { status, label: changedLabel(items, classified) };
  }

  const counts = workCountLabel(classified);
  if (highlight) {
    return counts ? { status, label: highlight, detail: counts } : { status, label: highlight };
  }
  if (running) {
    return { status, label: liveWorkLabel(classified) };
  }
  return { status, label: counts ?? 'Worked' };
}

function groupFamily(items: TranscriptItemView[]): ActivityFamily {
  const families = new Set(
    items.flatMap((item) => {
      const classified = classify(item);
      return classified ? [classified.family] : [];
    })
  );
  if (families.size === 1) {
    return [...families][0];
  }
  return 'work';
}

/** Reasoning joins lookups and commands. An edit is its own run. */
function runOf(item: TranscriptItemView): 'work' | 'change' | undefined {
  if (item.kind === 'reasoning') {
    return 'work';
  }
  const classified = classify(item);
  if (!classified) {
    return undefined;
  }
  return classified.family === 'change' ? 'change' : 'work';
}

function latestThought(items: TranscriptItemView[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind !== 'reasoning') {
      continue;
    }
    const snippet = plainRowText(item.text);
    if (snippet) {
      return snippet;
    }
  }
  return undefined;
}

function liveWorkLabel(classified: Classified[]): string {
  const families = new Set(classified.map((entry) => entry.family));
  if (families.size === 1 && families.has('command')) {
    return 'Running…';
  }
  if (families.has('lookup') && !families.has('command')) {
    return 'Exploring…';
  }
  if (families.has('command')) {
    return 'Working…';
  }
  return 'Exploring…';
}

function workCountLabel(classified: Classified[]): string | undefined {
  const lookups = classified.filter((entry) => entry.family === 'lookup');
  const commands = classified.filter((entry) => entry.family === 'command');
  const parts: string[] = [];
  if (lookups.length > 0) {
    parts.push(exploredLabel(lookups));
  }
  if (commands.length > 0) {
    const phrase = `Ran ${countPhrase(commands.length, 'command', 'commands')}`;
    parts.push(parts.length > 0 ? phrase.charAt(0).toLowerCase() + phrase.slice(1) : phrase);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
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
  if (SEARCH_TOOLS.has(tool) || isZvecSemanticSearch(tool)) {
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
