import type { FileChange, FileChangeLine, TranscriptItem } from '../types';
import { friendlyToolTitle, targetFromJson } from '../toolLabel.ts';
import type { ThreadItem } from '../../../schemas/v2/ThreadItem';
import type { CommandExecutionStatus } from '../../../schemas/v2/CommandExecutionStatus';
import type { PatchApplyStatus } from '../../../schemas/v2/PatchApplyStatus';
import type { UserInput } from '../../../schemas/v2/UserInput';

/**
 * Translate an app-server `ThreadItem` into the provider-neutral transcript
 * shape. Kept pure and free of the transport so the mapping is unit-testable and
 * so any protocol drift shows up here as a type error.
 *
 * Approval items are not translated here: `requestApproval` arrives as a server
 * *request*, not a thread item, and is translated by `approvalRequests.ts` into
 * the `approval-requested` / `approval-decided` / `approval-denied` kinds.
 */

export interface TranslatedItem {
  /** The provider item id, used to correlate deltas and completions. */
  id: string;
  item: TranscriptItem;
  /** True when the item can never receive further deltas. */
  terminal: boolean;
}

/** Which transcript kind an app-server item maps to. */
export function itemId(item: ThreadItem): string {
  return item.id;
}

export function translateItem(item: ThreadItem): TranslatedItem {
  switch (item.type) {
    case 'userMessage':
      return {
        id: item.id,
        terminal: true,
        item: {
          id: item.id,
          kind: 'message',
          role: 'user',
          text: userInputText(item.content)
        }
      };
    case 'agentMessage':
      return {
        id: item.id,
        terminal: false,
        item: {
          id: item.id,
          kind: 'message',
          role: 'assistant',
          text: item.text
        }
      };
    case 'reasoning':
      return {
        id: item.id,
        // Reasoning text streams through `item/reasoning/textDelta`; the item
        // itself only carries the summary and any content already produced.
        terminal: false,
        item: {
          id: item.id,
          kind: 'reasoning',
          title: 'Reasoning',
          text: [...item.summary, ...item.content].join('\n\n')
        }
      };
    case 'plan':
      return {
        id: item.id,
        terminal: true,
        item: { id: item.id, kind: 'notice', title: 'Plan', text: item.text }
      };
    case 'commandExecution':
      return {
        id: item.id,
        terminal: isCommandTerminal(item.status),
        item: {
          id: item.id,
          kind: 'tool',
          title: friendlyToolTitle('command', item.command ?? undefined),
          tool: 'command',
          command: item.command,
          detail: item.aggregatedOutput ?? undefined,
          text: item.aggregatedOutput ?? '',
          status: commandStatus(item.status)
        }
      };
    case 'fileChange':
      return {
        id: item.id,
        terminal: isPatchTerminal(item.status),
        item: {
          id: item.id,
          kind: 'file-change',
          title: 'Edited',
          files: item.changes.map((change) => summarizeChange(change.path, change.diff)),
          status: patchStatus(item.status)
        }
      };
    case 'mcpToolCall':
      return {
        id: item.id,
        terminal: item.status !== 'inProgress',
        item: {
          id: item.id,
          kind: 'tool',
          title: `${item.server} · ${friendlyToolTitle(item.tool, targetFromJson(item.tool, item.arguments))}`,
          tool: item.tool,
          command: targetFromJson(item.tool, item.arguments),
          detail: item.error?.message ?? undefined,
          status: item.status === 'inProgress' ? undefined : item.status === 'completed' ? 'completed' : 'failed'
        }
      };
    case 'dynamicToolCall':
      return {
        id: item.id,
        terminal: item.status !== 'inProgress',
        item: {
          id: item.id,
          kind: 'tool',
          title: friendlyToolTitle(item.tool, targetFromJson(item.tool, item.arguments)),
          tool: item.tool,
          command: targetFromJson(item.tool, item.arguments),
          status: item.status === 'inProgress' ? undefined : item.status === 'completed' ? 'completed' : 'failed'
        }
      };
    case 'webSearch':
      return {
        id: item.id,
        terminal: true,
        item: { id: item.id, kind: 'notice', title: 'Web search', text: item.query }
      };
    case 'contextCompaction':
      return {
        id: item.id,
        terminal: true,
        item: { id: item.id, kind: 'notice', title: 'Context compacted', text: '' }
      };
    default:
      // Unknown future item types still render as a neutral notice rather than
      // being dropped, so a newer Codex release degrades visibly, not silently.
      return {
        id: item.id,
        terminal: false,
        item: { id: item.id, kind: 'notice', title: 'Activity', text: '' }
      };
  }
}

/**
 * Whether an item-level terminal status is authoritative. Only used as a
 * fallback: the `item/completed` notification is the primary completion signal.
 */
export function isItemTerminal(item: ThreadItem): boolean {
  switch (item.type) {
    case 'commandExecution':
      return isCommandTerminal(item.status);
    case 'fileChange':
      return isPatchTerminal(item.status);
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return item.status !== 'inProgress';
    case 'agentMessage':
    case 'reasoning':
      // These stream deltas; their completion is the `item/completed` event.
      return false;
    default:
      return true;
  }
}

function isCommandTerminal(status: CommandExecutionStatus): boolean {
  return status !== 'inProgress';
}

function isPatchTerminal(status: PatchApplyStatus): boolean {
  return status !== 'inProgress';
}

function commandStatus(status: CommandExecutionStatus): 'completed' | 'failed' | undefined {
  if (status === 'inProgress') {
    return undefined;
  }
  return status === 'completed' ? 'completed' : 'failed';
}

function patchStatus(status: PatchApplyStatus): 'completed' | 'failed' | undefined {
  if (status === 'inProgress') {
    return undefined;
  }
  return status === 'completed' ? 'completed' : 'failed';
}

/** Concatenate the text portions of a user message's input parts. */
export function userInputText(content: UserInput[]): string {
  return content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}

/** Build a renderable file-change entry, deriving diff counts from the patch. */
export function summarizeChange(path: string, diff: string): FileChange {
  const lines = parsePatch(diff);
  const additions = lines?.filter((line) => line.kind === 'add').length;
  const deletions = lines?.filter((line) => line.kind === 'del').length;
  return {
    path,
    additions,
    deletions,
    lines
  };
}

/**
 * Turn a unified-diff patch body into renderable lines. Lines the renderer
 * cannot classify are dropped rather than shown as raw hunk headers.
 */
export function parsePatch(diff: string | undefined): FileChangeLine[] | undefined {
  if (!diff) {
    return undefined;
  }
  const lines: FileChangeLine[] = [];
  for (const raw of diff.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('@@') || raw.startsWith('diff ')) {
      continue;
    }
    if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text: raw.slice(1) });
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', text: raw.slice(1) });
    } else if (raw.startsWith(' ')) {
      lines.push({ kind: 'context', text: raw.slice(1) });
    }
  }
  return lines.length > 0 ? lines : undefined;
}

/**
 * Flatten a `Turn.items` payload into transcript items. Used when resuming a
 * thread, where the app-server returns historical turns rather than replaying
 * item notifications.
 *
 * User messages are included. A resumed transcript replaces what is on screen,
 * so dropping them left the scrollback starting at the next row, which is the
 * turn's reasoning. The host overlays its own message ids afterwards so a
 * checkpoint still addresses the bubble it recorded.
 */
export function translateTurnItems(items: ThreadItem[]): TranscriptItem[] {
  const seen = new Set<string>();
  const transcript: TranscriptItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    const { item: translated } = translateItem(item);
    // Every item in a persisted turn has already finished, so a replayed item is
    // terminal even for kinds (messages, reasoning) that stream live.
    transcript.push({
      ...translated,
      text: translated.text ?? '',
      status: translated.status === 'failed' ? 'failed' : 'completed'
    });
  }
  return transcript;
}
