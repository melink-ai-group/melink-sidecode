import type { TranscriptItem } from './types.ts';
import { compactionSource, fitCompactionSource } from './compaction.ts';

/**
 * A provider thread can disappear while sideCode still has the chat: Codex
 * drops a rollout, or opencode no longer has the session file. The sidebar
 * conversation is the record that survives. This module turns that record into
 * the standing context a replacement thread starts with.
 */

const STATUS_LABEL: Record<string, string> = {
  pending: 'pending',
  inProgress: 'in progress',
  completed: 'done',
  denied: 'denied'
};

/** Conversation tail kept in the replacement thread. Changes and the plan sit outside this budget. */
const RECOVERY_CONVERSATION_TOKENS = 6_000;

/**
 * How many times a stopped turn is continued on its own before the error is shown.
 * A user send starts the count over.
 */
export const STOP_CONTINUE_ATTEMPTS = 3;

/** The automatic turn sent after the provider stops, before any error is shown. */
export function continueAfterStopInstruction(): string {
  return 'The previous turn stopped before it finished. Continue the remaining work from the conversation and the latest changes. Do not repeat work that is already done, and do not ask whether to continue.';
}

/** Status line while an automatic continuation is still available. */
export function stopContinueNotice(attempt: number, max = STOP_CONTINUE_ATTEMPTS): string {
  return `The provider stopped. Continuing automatically (${attempt} of ${max}).`;
}

/** Status line when a live turn went quiet and is continued on its own. */
export function quietContinueNotice(attempt: number, max = STOP_CONTINUE_ATTEMPTS): string {
  return `Nothing new arrived, so this continues automatically (${attempt} of ${max}).`;
}

/** True when this failure is a quiet OpenCode turn, not a crash. */
export function isQuietTurnError(error: unknown): boolean {
  return /went quiet before it finished/i.test(errorText(error));
}

/**
 * True when this failure should start another turn instead of showing an error.
 * A cancel, a missing CLI, and an auth failure are shown immediately.
 */
export function shouldAutoContinue(error: unknown, attempts: number, max = STOP_CONTINUE_ATTEMPTS): boolean {
  if (attempts >= max || attempts < 0) {
    return false;
  }
  const message = errorText(error);
  if (/cancel/i.test(message)) {
    return false;
  }
  if (/unauthor|unauthenticated|api key|not found at /i.test(message) && !isMissingThreadError(error)) {
    return false;
  }
  if (isMissingThreadError(error)) {
    return true;
  }
  return /stopped unexpectedly|exited unexpectedly|connection closed|not accepting requests|session could not be started or resumed|stream ended before the turn completed|reached the output limit|went quiet before it finished/i.test(
    message
  );
}

export function threadRecoveredNotice(provider: 'Codex' | 'OpenCode'): string {
  const subject = provider === 'Codex' ? 'Codex thread' : 'opencode session';
  return `The ${subject} was not found, so this conversation continued on a new one with the earlier chat, the latest file changes, and the remaining work.`;
}

/**
 * True when a failure means the provider thread itself is gone.
 * A missing CLI, an auth failure, or an overload is a different problem and
 * must not start a replacement thread.
 */
export function isMissingThreadError(error: unknown): boolean {
  const message = errorText(error);
  if (!message.trim()) {
    return false;
  }
  if (/overloaded|rate limit|unauthorized|unauthenticated|incorrect api key|api key/i.test(message) && !/not found/i.test(message)) {
    return false;
  }
  return (
    /thread[^.\n]{0,160}(not found|does not exist|no longer available|missing)/i.test(message) ||
    /(not found|does not exist|unknown|missing|no such)[^.\n]{0,120}thread/i.test(message) ||
    /session[^.\n]{0,160}(not found|does not exist|no longer available|missing)/i.test(message) ||
    /(not found|does not exist|unknown|missing|no such)[^.\n]{0,120}session/i.test(message) ||
    /no such (thread|session)/i.test(message) ||
    /failed to (load|resume|find|open) (the )?(thread|session)/i.test(message) ||
    /(could not|unable to|cannot|can't) (find|load|resume|open) (the )?(thread|session)/i.test(message) ||
    /no rollout found/i.test(message) ||
    /rollout[^.\n]{0,120}(not found|missing|no such)/i.test(message)
  );
}

export interface RecoveryInput {
  provider: 'Codex' | 'OpenCode';
  transcript: readonly Pick<TranscriptItem, 'kind' | 'role' | 'text' | 'files' | 'orchestration'>[];
  plan?: {
    path?: string;
    title?: string;
    summary?: string;
    steps?: readonly { text: string; status: string }[];
  };
  /**
   * The user text about to be sent on the replacement thread. It is left out of
   * the conversation section so the turn is not pasted twice.
   */
  omitTrailingUserText?: string;
}

/**
 * Standing context for a thread that replaces one the provider no longer has.
 * Returns undefined when the sidebar has nothing to carry forward.
 */
export function recoveryHandover(input: RecoveryInput): string | undefined {
  const transcript = omitTrailingUser(input.transcript, input.omitTrailingUserText);
  const conversation = fitCompactionSource(compactionSource(transcript), RECOVERY_CONVERSATION_TOKENS).trim();
  const changes = latestChangeLines(input.transcript);
  const work = workLines(input.plan, lastUserText(input.transcript));
  if (!conversation && changes.length === 0 && work.length === 0) {
    return undefined;
  }
  const subject = input.provider === 'Codex' ? 'Codex thread' : 'opencode session';
  const parts = [
    `The previous ${subject} no longer exists. Continue this same conversation from the record below. The workspace already contains the latest changes. Do the remaining work. Do not ask the user to repeat the history.`
  ];
  if (conversation) {
    parts.push(`Conversation:\n${conversation}`);
  }
  if (changes.length > 0) {
    parts.push(`Latest changes:\n${changes.join('\n')}`);
  }
  if (work.length > 0) {
    parts.push(`What to do:\n${work.join('\n')}`);
  }
  return parts.join('\n\n');
}

/** Developer instructions for the replacement thread: the record, then the project snapshot. */
export function recoveryInstructions(handover: string, snapshot?: string): string {
  const parts = [handover.trim(), snapshot?.trim() || undefined].filter((part): part is string => Boolean(part));
  return parts.join('\n\n');
}

function errorText(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    const data = (error as { data?: unknown }).data;
    const extra = data === undefined ? '' : typeof data === 'string' ? data : safeJson(data);
    return `${error.message}\n${extra}`;
  }
  return String(error ?? '');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function omitTrailingUser(
  items: readonly Pick<TranscriptItem, 'kind' | 'role' | 'text' | 'files'>[],
  text: string | undefined
): readonly Pick<TranscriptItem, 'kind' | 'role' | 'text' | 'files'>[] {
  const omitted = text?.trim();
  if (!omitted) {
    return items;
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === 'message' && item.role === 'user') {
      if (item.text?.trim() === omitted) {
        return items.slice(0, index);
      }
      return items;
    }
  }
  return items;
}

function lastUserText(items: readonly Pick<TranscriptItem, 'kind' | 'role' | 'text' | 'orchestration'>[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === 'message' && item.role === 'user' && !item.orchestration) {
      const text = item.text?.trim();
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}

function latestChangeLines(items: readonly Pick<TranscriptItem, 'kind' | 'files'>[]): string[] {
  const byPath = new Map<string, { additions?: number; deletions?: number }>();
  for (const item of items) {
    if (item.kind !== 'file-change') {
      continue;
    }
    for (const file of item.files ?? []) {
      const path = file.path?.trim();
      if (!path) {
        continue;
      }
      byPath.set(path, { additions: file.additions, deletions: file.deletions });
    }
  }
  return [...byPath.entries()].slice(-40).map(([path, stats]) => {
    if (stats.additions === undefined && stats.deletions === undefined) {
      return `- ${path}`;
    }
    return `- ${path} (+${stats.additions ?? 0} -${stats.deletions ?? 0})`;
  });
}

function workLines(
  plan: RecoveryInput['plan'],
  latestRequest: string | undefined
): string[] {
  const lines: string[] = [];
  if (plan && (plan.title || plan.summary || (plan.steps && plan.steps.length > 0))) {
    const title = plan.title?.trim() || 'Plan';
    lines.push(plan.path ? `Plan: ${title} (${plan.path})` : `Plan: ${title}`);
    const summary = plan.summary?.trim();
    if (summary) {
      lines.push(summary);
    }
    for (const step of plan.steps ?? []) {
      const text = step.text.trim();
      if (!text) {
        continue;
      }
      const status = STATUS_LABEL[step.status] ?? step.status;
      lines.push(`- [${status}] ${text}`);
    }
    const remaining = (plan.steps ?? []).filter((step) => step.status !== 'completed' && step.text.trim());
    if (remaining.length > 0) {
      lines.push('Remaining work is every step that is not done.');
    }
  }
  if (latestRequest) {
    lines.push(`Latest request: ${latestRequest}`);
  }
  return lines;
}
