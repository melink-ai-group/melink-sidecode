/**
 * Clarifying questions the agent asks before it continues.
 *
 * Plan and Agent end a reply with one fenced `sidecode-question` block, or a
 * backend raises its own user-input request. Both become the same card: two
 * ranked suggestions, then a custom message the host always adds.
 */

import type { NoticeAction } from './webview/state.ts';

/** The third choice. The model does not supply it. */
export const CUSTOM_OPTION_LABEL = 'Something else';

/**
 * Recorded when the user skips a question so a blocking request can finish.
 * It is an instruction, not a decision: the model must not invent an answer.
 */
export const SKIPPED_ANSWER =
  'Skipped \u2014 do not assume an answer; re-ask this question, or choose the least-destructive option and state the assumption.';

/** The warning shown when a model's question payload is not valid JSON. */
export const INVALID_QUESTION_MESSAGE =
  'The agent sent a question in a format sideCode could not read. It was removed from the reply.';

/** Ask mode answers only, so a question payload there is a no-op. */
export const ASK_MODE_QUESTION_MESSAGE =
  'Ask mode does not ask questions. Switch to Agent or Plan if you want the assistant to ask.';

/** The turn sent when Retry is used on an unreadable question payload. */
export function questionRetryInstruction(): string {
  return 'Your previous question block could not be read. Re-ask the unanswered question using one valid JSON sidecode-question block, or ask it in plain text. Do not repeat work that is already done.';
}

export interface ClarifyingQuestion {
  id: string;
  /** Short label above the prompt, when the backend sent one. */
  header?: string;
  prompt: string;
  /** Ranked suggestions, preferred first. At most two. */
  options: string[];
}

export interface QuestionRequest {
  id: string;
  backendId: string;
  threadId: string;
  /** Assistant item the fence was removed from, when the ask came from a reply. */
  itemId?: string;
  /** That item's text after the fence was removed. */
  strippedText?: string;
  questions: ClarifyingQuestion[];
}

export interface QuestionAnswer {
  questionId: string;
  /** Chosen label, custom text, or {@link SKIPPED_ANSWER}. */
  text: string;
}

/** How many ranked suggestions a card keeps. The host still adds a custom answer. */
const MAX_OPTIONS = 6;

const CLOSED_FENCE = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
const QUESTION_FENCE_OPEN = /```[ \t]*(?:sidecode[-_ ]?questions?|questions?)[^\n`]*\r?\n/gi;
const QUESTION_FENCE_TEXT = /```[ \t]*(?:sidecode[-_ ]?questions?|questions?)[^\n`]*/i;
/**
 * A bare payload is only recognised at the start of a line, outside a fence.
 * JSON quoted inline in prose, or in a code sample, is not a question.
 */
const QUESTION_OBJECT_AT_LINE_START = /^[ \t]*\{\s*"questions"\s*:/gm;
const QUESTION_BODY_START = /^\s*\{\s*"questions"\s*:/;
const QUESTION_INFO = /^(?:sidecode[-_ ]?questions?|questions?)$/i;
const JSON_INFO = /^(?:json|jsonc)$/i;

interface QuestionSpan {
  start: number;
  end: number;
  /** Undefined on an invalid span, which is removed but cannot be asked. */
  questions?: ClarifyingQuestion[];
  invalid?: boolean;
}

/** The warning and retry affordance for a question payload that would not parse. */
export function invalidQuestionNotice(offerRetry = true): {
  level: 'warning';
  message: string;
  action?: NoticeAction;
} {
  return offerRetry
    ? { level: 'warning', message: INVALID_QUESTION_MESSAGE, action: 'retryQuestion' }
    : { level: 'warning', message: INVALID_QUESTION_MESSAGE };
}

/** The non-blocking notice Ask mode shows when a reply carries a question. */
export function askModeQuestionNotice(): { level: 'info'; message: string } {
  return { level: 'info', message: ASK_MODE_QUESTION_MESSAGE };
}

/**
 * True when `text` carries a question payload, valid or malformed. Used by Ask
 * mode to explain that it does not open a question card.
 */
export function containsQuestionPayload(text: string): boolean {
  // A question-tagged fence counts even while its closing fence is still
  // streaming. Everything else goes through the fence-aware span scan, so a
  // code sample that merely contains the payload text is not a question.
  return QUESTION_FENCE_TEXT.test(text) || findQuestionSpans(text).length > 0;
}

/**
 * Pull every question payload out of an assistant reply and remove all of them,
 * valid and invalid. Payloads keep source order; ids are reassigned `q1..` so
 * two payloads cannot collide. A malformed question fence is removed and
 * reported through `invalid`. An empty result means there is nothing to ask.
 */
export function extractSidecodeQuestions(text: string): {
  text: string;
  questions?: ClarifyingQuestion[];
  invalid?: boolean;
} {
  const spans = findQuestionSpans(text);
  if (spans.length === 0) {
    return { text };
  }
  const questions: ClarifyingQuestion[] = [];
  let invalid = false;
  for (const span of spans) {
    if (span.invalid) {
      invalid = true;
      continue;
    }
    if (span.questions) {
      questions.push(...span.questions);
    }
  }
  let stripped = text;
  for (const span of [...spans].reverse()) {
    stripped = stripped.slice(0, span.start) + stripped.slice(span.end);
  }
  const result: { text: string; questions?: ClarifyingQuestion[]; invalid?: boolean } = {
    text: stripped.replace(/\n{3,}/g, '\n\n').trim()
  };
  if (questions.length > 0) {
    result.questions = questions.map((question, index) => ({ ...question, id: `q${index + 1}` }));
  }
  if (invalid) {
    result.invalid = true;
  }
  return result;
}

/**
 * Hide every question payload from the transcript for every mode, including a
 * malformed fence and a payload that is still streaming.
 */
export function hideQuestionFence(text: string): string {
  let next = extractSidecodeQuestions(text).text;
  next = next.replace(/```[ \t]*(?:sidecode[-_ ]?questions?|questions?)[^\n`]*[\s\S]*$/i, '');
  next = hideUnbalancedQuestionTail(next);
  return next.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Every question payload in `text`, earliest first. A fence owns the JSON
 * inside it, so the same object is not reported twice. Invalid question fences
 * become spans too, so the malformed text is removed rather than shown.
 */
function findQuestionSpans(text: string): QuestionSpan[] {
  const spans: QuestionSpan[] = [];
  const fences: Array<[number, number]> = [];
  CLOSED_FENCE.lastIndex = 0;
  for (const match of text.matchAll(CLOSED_FENCE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    fences.push([start, end]);
    const info = match[1] ?? '';
    const body = match[2] ?? '';
    const questions = parseQuestionJson(body);
    if (questions) {
      spans.push({ start, end, questions });
    } else if (isQuestionInfo(info) || (isJsonInfo(info) && looksLikeQuestionPayload(body))) {
      spans.push({ start, end, invalid: true });
    }
  }
  const unclosed = findUnclosedQuestionFence(text, fences);
  if (unclosed) {
    spans.push(unclosed);
    fences.push([unclosed.start, unclosed.end]);
  }
  for (const bare of findBareQuestionSpans(text)) {
    // An unbalanced candidate runs to the end of the text, so containment must
    // be judged by where it starts, not where its (unfinished) span ends.
    const insideFence = fences.some(([start, end]) => bare.start >= start && bare.start < end);
    if (insideFence || spans.some((span) => spansOverlap(span, bare))) {
      continue;
    }
    spans.push(bare);
  }
  spans.sort((left, right) => left.start - right.start || left.end - right.end);
  return spans;
}

/**
 * A fence left open at the end of a streamed reply. A parseable payload keeps
 * any prose after it; an unreadable body is removed to the end as invalid.
 */
function findUnclosedQuestionFence(text: string, fences: Array<[number, number]>): QuestionSpan | undefined {
  QUESTION_FENCE_OPEN.lastIndex = 0;
  for (const match of text.matchAll(QUESTION_FENCE_OPEN)) {
    const start = match.index ?? 0;
    if (fences.some(([fenceStart, fenceEnd]) => start >= fenceStart && start < fenceEnd)) {
      continue;
    }
    const bodyStart = start + match[0].length;
    const body = text.slice(bodyStart);
    const inner = findBareQuestionObjects(body);
    const last = inner[inner.length - 1];
    if (last) {
      return { start, end: bodyStart + last.end, questions: last.questions };
    }
    return { start, end: text.length, invalid: true };
  }
  return undefined;
}

function isQuestionInfo(info: string): boolean {
  return QUESTION_INFO.test(info.trim());
}

function isJsonInfo(info: string): boolean {
  return JSON_INFO.test(info.trim());
}

function looksLikeQuestionPayload(body: string): boolean {
  return QUESTION_BODY_START.test(body);
}

function findBareQuestionObjects(text: string): QuestionSpan[] {
  return findBareQuestionSpans(text).filter((span) => span.questions !== undefined);
}

/**
 * Every bare `{"questions":...}` candidate at a line start, earliest first. A
 * balanced object that does not parse, or has no usable question, is still a
 * payload: it is removed and flagged invalid. An unbalanced candidate owns the
 * rest of the text, so a partial stream cannot leave raw JSON behind. Inline
 * prose and fenced code samples are never candidates.
 */
function findBareQuestionSpans(text: string): QuestionSpan[] {
  const spans: QuestionSpan[] = [];
  QUESTION_OBJECT_AT_LINE_START.lastIndex = 0;
  for (const match of text.matchAll(QUESTION_OBJECT_AT_LINE_START)) {
    const lineStart = match.index ?? 0;
    const candidate = lineStart + match[0].indexOf('{');
    if (spans.some((span) => candidate >= span.start && candidate < span.end)) {
      continue;
    }
    const end = matchingBrace(text, candidate);
    if (end < 0) {
      spans.push({ start: lineStart, end: text.length, invalid: true });
      break;
    }
    const expandedEnd = expandWrappingTicks(text, candidate, end)[1];
    const questions = parseQuestionJson(text.slice(candidate, end));
    spans.push(questions ? { start: lineStart, end: expandedEnd, questions } : { start: lineStart, end: expandedEnd, invalid: true });
  }
  return spans;
}

/** Include backticks that only wrap the JSON object. */
function expandWrappingTicks(text: string, start: number, end: number): [number, number] {
  let nextStart = start;
  let nextEnd = end;
  while (nextStart > 0 && text[nextStart - 1] === '`') {
    nextStart -= 1;
  }
  while (nextEnd < text.length && text[nextEnd] === '`') {
    nextEnd += 1;
  }
  return [nextStart, nextEnd];
}

function hideUnbalancedQuestionTail(text: string): string {
  const fences = closedFenceRanges(text);
  let last = -1;
  for (const match of text.matchAll(QUESTION_OBJECT_AT_LINE_START)) {
    const candidate = (match.index ?? 0) + match[0].indexOf('{');
    if (fences.some(([start, end]) => candidate >= start && candidate < end)) {
      continue;
    }
    last = candidate;
  }
  if (last < 0 || matchingBrace(text, last) >= 0) {
    return text;
  }
  const lineStart = text.lastIndexOf('\n', last) + 1;
  return text.slice(0, lineStart);
}

/** Every closed fence in `text`, as `[start, end)` offsets. */
function closedFenceRanges(text: string): Array<[number, number]> {
  const fences: Array<[number, number]> = [];
  CLOSED_FENCE.lastIndex = 0;
  for (const match of text.matchAll(CLOSED_FENCE)) {
    const start = match.index ?? 0;
    fences.push([start, start + match[0].length]);
  }
  return fences;
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return -1;
}

function spansOverlap(left: QuestionSpan, right: QuestionSpan): boolean {
  return left.start < right.end && right.start < left.end;
}

/**
 * The follow-up the agent reads after the card is finished.
 * One line per question, in the order they were asked.
 */
export function formatQuestionAnswers(questions: readonly ClarifyingQuestion[], answers: readonly QuestionAnswer[]): string {
  return `Answers:\n${planDecisionLines(questions, answers).join('\n')}`;
}

/** One line per answer, in ask order, for the plan document and the follow-up turn. */
export function planDecisionLines(questions: readonly ClarifyingQuestion[], answers: readonly QuestionAnswer[]): string[] {
  return questions.map((question, index) => {
    const answer = answers.find((entry) => entry.questionId === question.id);
    const text = answer?.text.trim() || SKIPPED_ANSWER;
    return `${index + 1}. ${question.prompt}: ${text}`;
  });
}

/**
 * The Plan-mode turn sent after a question card. The host treats it as a
 * revision, and the wording asks for a full updated plan rather than a chat reply.
 */
export function planUpdateFromAnswers(questions: readonly ClarifyingQuestion[], answers: readonly QuestionAnswer[]): string {
  return [
    'Update the plan document so these decisions are part of it. Reply with one full markdown plan: a title, the updated body, a "## Decisions" section listing each answer, and a final "## Steps" checkbox list. Do not implement the plan.',
    '',
    formatQuestionAnswers(questions, answers)
  ].join('\n');
}

/**
 * A Codex `item/tool/requestUserInput` or similar payload, reduced to the card.
 * Returns undefined when there is no thread or no usable question.
 */
export function questionRequestFromToolParams(
  backendId: string,
  requestId: string,
  params: unknown
): QuestionRequest | undefined {
  const record = asRecord(params);
  if (!record) {
    return undefined;
  }
  const threadId = asString(record.threadId) ?? asString(record.threadID);
  const questions = normalizeQuestionList(record.questions);
  if (!threadId || questions.length === 0) {
    return undefined;
  }
  return { id: requestId, backendId, threadId, questions };
}

/** An OpenCode `question.asked` bus payload, when it carries questions. */
export function questionAskFromBus(payload: Record<string, unknown>): QuestionRequest | undefined {
  if (payload.type !== 'question.asked') {
    return undefined;
  }
  const properties = asRecord(payload.properties) ?? payload;
  const id = asString(properties.id);
  const questions = normalizeQuestionList(properties.questions);
  if (!id || questions.length === 0) {
    return undefined;
  }
  const sessionId = asString(properties.sessionID);
  return {
    id,
    backendId: '',
    threadId: sessionId ?? '',
    questions
  };
}

/** Keep the first two distinct suggestions. A "something else" entry is dropped. */
export function rankedOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const labels: string[] = [];
  for (const entry of raw) {
    const label = optionLabel(entry);
    if (!label || label.toLowerCase() === CUSTOM_OPTION_LABEL.toLowerCase()) {
      continue;
    }
    if (labels.some((existing) => existing.toLowerCase() === label.toLowerCase())) {
      continue;
    }
    labels.push(label);
    if (labels.length === MAX_OPTIONS) {
      break;
    }
  }
  return labels;
}

function parseQuestionJson(body: string): ClarifyingQuestion[] | undefined {
  const value = parseJsonLoose(body);
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value);
  const list = record && Array.isArray(record.questions) ? record.questions : Array.isArray(value) ? value : undefined;
  if (!list) {
    return undefined;
  }
  const questions = normalizeQuestionList(list);
  return questions.length > 0 ? questions : undefined;
}

/** JSON.parse, then one repair for a trailing comma inside the payload. */
function parseJsonLoose(body: string): unknown {
  const trimmed = body.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Models often leave a comma before the closing brace.
  }
  try {
    return JSON.parse(trimmed.replace(/,\s*([}\]])/g, '$1')) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeQuestionList(raw: unknown): ClarifyingQuestion[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const questions: ClarifyingQuestion[] = [];
  for (const entry of raw) {
    const question = normalizeQuestion(entry, questions.length);
    if (question) {
      questions.push(question);
    }
  }
  return questions;
}

function normalizeQuestion(entry: unknown, index: number): ClarifyingQuestion | undefined {
  const record = asRecord(entry);
  if (!record) {
    return undefined;
  }
  const prompt =
    asString(record.prompt) ?? asString(record.question) ?? asString(record.text) ?? asString(record.query) ?? asString(record.title);
  if (!prompt) {
    return undefined;
  }
  const title = asString(record.title);
  const header = asString(record.header) ?? (title && title !== prompt ? title : undefined);
  return {
    id: asString(record.id) ?? `q${index + 1}`,
    ...(header ? { header } : {}),
    prompt,
    options: rankedOptions(record.options ?? record.choices)
  };
}

function optionLabel(entry: unknown): string {
  if (typeof entry === 'string') {
    return entry.trim();
  }
  const record = asRecord(entry);
  return asString(record?.label)?.trim() ?? asString(record?.text)?.trim() ?? '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
