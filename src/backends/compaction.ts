import type { TranscriptItem } from './types';
import { tokensFromText } from './contextUsage.ts';

function compactId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A conversation compacted down to a summary the next turn can continue from.
 *
 * Codex compacts inside the app-server. Ollama has no such call: the host asks
 * the same model for a summary and replaces the stored transcript, which is
 * what the next `/api/chat` request and a fresh opencode session are built
 * from. The title marks the summary so a fresh opencode session can carry it
 * once without writing it into later turns.
 */

export const COMPACTED_CONTEXT_TITLE = 'Compacted context';

export const COMPACTION_INSTRUCTIONS =
  'Compact this conversation so it can continue in a smaller context window. ' +
  'Write a standalone summary the assistant can continue from. Keep the user\'s goal, ' +
  'decisions, file paths, constraints, and unfinished work. Drop tool chatter and ' +
  'repeated attempts. Plain prose, no preamble.';

/** The user/assistant turns of a transcript, as plain lines a summary call can read. */
export function compactionSource(items: readonly Pick<TranscriptItem, 'kind' | 'role' | 'text'>[]): string {
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind !== 'message' || (item.role !== 'user' && item.role !== 'assistant')) {
      continue;
    }
    const text = item.text?.trim();
    if (!text) {
      continue;
    }
    lines.push(`${item.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
  }
  return lines.join('\n\n');
}

/**
 * Keep the tail of a source that would not fit the context window. The summary
 * call itself has to fit, so older turns are dropped before the request rather
 * than sent past the window.
 */
export function fitCompactionSource(source: string, maxTokens: number | undefined): string {
  if (!maxTokens || maxTokens <= 0 || !Number.isFinite(maxTokens)) {
    return source;
  }
  const budget = Math.max(1, Math.floor(maxTokens)) * 4;
  if (source.length <= budget) {
    return source;
  }
  return source.slice(source.length - budget);
}

/** Transcript that replaces the conversation after a summary is ready. */
export function compactedTranscript(summary: string): TranscriptItem[] {
  const text = summary.trim();
  return [
    { id: compactId('compact_notice'), kind: 'notice', title: 'Context compacted', text: '', status: 'completed' },
    {
      id: compactId('compact_user'),
      kind: 'message',
      role: 'user',
      title: COMPACTED_CONTEXT_TITLE,
      text: 'Continue from this summary of the earlier conversation.',
      status: 'completed'
    },
    {
      id: compactId('compact_assistant'),
      kind: 'message',
      role: 'assistant',
      title: COMPACTED_CONTEXT_TITLE,
      text,
      status: 'completed'
    }
  ];
}

/** The latest compaction summary stored on a thread, when one is present. */
export function compactedSummary(items: readonly TranscriptItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === 'message' && item.role === 'assistant' && item.title === COMPACTED_CONTEXT_TITLE) {
      const text = item.text?.trim();
      return text ? text : undefined;
    }
  }
  return undefined;
}

/** Preface a fresh opencode session with the summary, once. Later turns resume the session. */
export function compactionPreface(summary: string): string {
  return `Earlier conversation, compacted so it fits the context window:\n${summary.trim()}`;
}

/** Tokens the replacement transcript will occupy, until the next provider count arrives. */
export function compactedTokenEstimate(items: readonly Pick<TranscriptItem, 'text'>[]): number {
  return items.reduce((sum, item) => sum + tokensFromText(item.text ?? ''), 0);
}
