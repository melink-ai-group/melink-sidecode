/**
 * The pending question card that belongs to a conversation.
 *
 * Only one card is open at a time, but a reload can restore the one that was
 * open. Values live in `workspaceState`, keyed by `backendId:threadId`, and are
 * bounded so a long-lived workspace cannot grow without limit. The store is a
 * plain data seam over a `vscode.Memento`; it never touches the host runtime.
 */

import type { Memento } from 'vscode';
import type { ClarifyingQuestion, QuestionRequest } from './questions.ts';

export const PENDING_QUESTIONS_KEY = 'melink.questions.pending';
/** How many conversations keep a pending card. Oldest entries fall off first. */
export const MAX_PENDING_QUESTIONS = 20;

export type QuestionSource = 'fence' | 'native';

export interface PendingQuestion {
  source: QuestionSource;
  request: QuestionRequest;
}

type PendingQuestions = Record<string, PendingQuestion>;

/** The `workspaceState` key a conversation's pending card is stored under. */
export function pendingQuestionKey(backendId: string, threadId: string): string {
  return `${backendId}:${threadId}`;
}

export class QuestionStore {
  private readonly storage: Memento;
  private readonly maxThreads: number;

  constructor(storage: Memento, maxThreads: number = MAX_PENDING_QUESTIONS) {
    this.storage = storage;
    this.maxThreads = Number.isFinite(maxThreads) && maxThreads > 0 ? Math.floor(maxThreads) : MAX_PENDING_QUESTIONS;
  }

  /** The stored card for one conversation, after validation. */
  get(backendId: string, threadId: string): PendingQuestion | undefined {
    return this.load()[pendingQuestionKey(backendId, threadId)];
  }

  /** Store a card, replacing any previous card for the same conversation. */
  async set(backendId: string, threadId: string, pending: PendingQuestion): Promise<void> {
    const key = pendingQuestionKey(backendId, threadId);
    if (!isPendingQuestion(pending) || key !== pendingQuestionKey(pending.request.backendId, pending.request.threadId)) {
      return;
    }
    const entries = this.load();
    delete entries[key];
    entries[key] = pending;
    await this.write(entries);
  }

  /** Drop a conversation's card; a miss is harmless. */
  async clear(backendId: string, threadId: string): Promise<void> {
    const key = pendingQuestionKey(backendId, threadId);
    const entries = this.load();
    if (!(key in entries)) {
      return;
    }
    delete entries[key];
    await this.write(entries);
  }

  private load(): PendingQuestions {
    const raw = this.storage.get<unknown>(PENDING_QUESTIONS_KEY);
    const entries: PendingQuestions = {};
    if (!isRecord(raw)) {
      return entries;
    }
    for (const [key, value] of Object.entries(raw)) {
      if (!isPendingQuestion(value)) {
        continue;
      }
      if (key !== pendingQuestionKey(value.request.backendId, value.request.threadId)) {
        continue;
      }
      entries[key] = value;
    }
    return trimOldest(entries, this.maxThreads);
  }

  private async write(entries: PendingQuestions): Promise<void> {
    const bounded = trimOldest(entries, this.maxThreads);
    await this.storage.update(PENDING_QUESTIONS_KEY, bounded);
  }
}

/** Keep the most recently written entries, which are the last object keys. */
function trimOldest(entries: PendingQuestions, maxThreads: number): PendingQuestions {
  const keys = Object.keys(entries);
  if (keys.length <= maxThreads) {
    return entries;
  }
  const bounded: PendingQuestions = {};
  for (const key of keys.slice(keys.length - maxThreads)) {
    bounded[key] = entries[key] as PendingQuestion;
  }
  return bounded;
}

function isPendingQuestion(value: unknown): value is PendingQuestion {
  if (!isRecord(value)) {
    return false;
  }
  if (value.source !== 'fence' && value.source !== 'native') {
    return false;
  }
  return isQuestionRequest(value.request);
}

function isQuestionRequest(value: unknown): value is QuestionRequest {
  if (!isRecord(value)) {
    return false;
  }
  if (!isText(value.id) || !isText(value.backendId) || !isText(value.threadId)) {
    return false;
  }
  if (value.itemId !== undefined && typeof value.itemId !== 'string') {
    return false;
  }
  if (value.strippedText !== undefined && typeof value.strippedText !== 'string') {
    return false;
  }
  return Array.isArray(value.questions) && value.questions.length > 0 && value.questions.every(isClarifyingQuestion);
}

function isClarifyingQuestion(value: unknown): value is ClarifyingQuestion {
  if (!isRecord(value)) {
    return false;
  }
  if (!isText(value.id) || !isText(value.prompt)) {
    return false;
  }
  if (value.header !== undefined && typeof value.header !== 'string') {
    return false;
  }
  return Array.isArray(value.options) && value.options.every((option) => typeof option === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
