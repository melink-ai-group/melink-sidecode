/**
 * Clarifying questions the agent asks before it continues.
 *
 * Plan and Agent end a reply with one fenced `sidecode-question` block, or a
 * backend raises its own user-input request. Both become the same card: two
 * ranked suggestions, then a custom message the host always adds.
 */

/** The third choice. The model does not supply it. */
export const CUSTOM_OPTION_LABEL = 'Something else';

/** Recorded when the user skips a question so a blocking request can finish. */
export const SKIPPED_ANSWER = 'Skipped';

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
const UNCLOSED_QUESTION_FENCE = /```[ \t]*(sidecode[-_ ]?questions?|questions?)[^\n]*\r?\n([\s\S]*)$/i;
const QUESTION_OBJECT_START = /\{\s*"questions"\s*:/g;

interface QuestionSpan {
  start: number;
  end: number;
  questions: ClarifyingQuestion[];
}

/**
 * Pull a question payload out of an assistant reply and remove it.
 * Accepts a `sidecode-question` fence, the same JSON in another fence, and a
 * bare `{"questions":[...]}` object. The last payload is the one that is asked.
 * Invalid JSON is left in place. An empty result means there is nothing to ask.
 */
export function extractSidecodeQuestions(text: string): { text: string; questions?: ClarifyingQuestion[] } {
  const spans = findQuestionSpans(text);
  if (spans.length === 0) {
    return { text };
  }
  const questions = spans[spans.length - 1]?.questions ?? [];
  let stripped = text;
  for (const span of [...spans].reverse()) {
    stripped = stripped.slice(0, span.start) + stripped.slice(span.end);
  }
  return {
    text: stripped.replace(/\n{3,}/g, '\n\n').trim(),
    questions: questions.map((question, index) => ({ ...question, id: question.id || `q${index + 1}` }))
  };
}

/** Hide a question payload from the transcript while Plan or Agent is streaming it. */
export function hideQuestionFence(text: string): string {
  const extracted = extractSidecodeQuestions(text);
  let next = extracted.questions ? extracted.text : text;
  next = next.replace(/```[ \t]*(?:sidecode[-_ ]?questions?|questions?)[^\n]*\r?\n[\s\S]*$/i, '');
  next = hideUnbalancedQuestionTail(next);
  return next.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Every question payload in `text`, earliest first. A fence owns the JSON
 * inside it, so the same object is not reported twice.
 */
function findQuestionSpans(text: string): QuestionSpan[] {
  const spans: QuestionSpan[] = [];
  const fences: Array<[number, number]> = [];
  CLOSED_FENCE.lastIndex = 0;
  for (const match of text.matchAll(CLOSED_FENCE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    fences.push([start, end]);
    const questions = parseQuestionJson(match[2] ?? '');
    if (questions) {
      spans.push({ start, end, questions });
    }
  }
  const unclosed = findUnclosedQuestionFence(text);
  if (unclosed && !spans.some((span) => spansOverlap(span, unclosed))) {
    spans.push(unclosed);
    fences.push([unclosed.start, unclosed.end]);
  }
  for (const bare of findBareQuestionObjects(text)) {
    const insideFence = fences.some(([start, end]) => bare.start >= start && bare.end <= end);
    if (insideFence || spans.some((span) => spansOverlap(span, bare))) {
      continue;
    }
    spans.push(bare);
  }
  spans.sort((left, right) => left.start - right.start || left.end - right.end);
  return spans;
}

function findUnclosedQuestionFence(text: string): QuestionSpan | undefined {
  const match = UNCLOSED_QUESTION_FENCE.exec(text);
  if (!match || match.index === undefined) {
    return undefined;
  }
  const body = match[2] ?? '';
  const inner = findBareQuestionObjects(body);
  const last = inner[inner.length - 1];
  if (!last) {
    return undefined;
  }
  const bodyStart = match.index + match[0].length - body.length;
  return { start: match.index, end: bodyStart + last.end, questions: last.questions };
}

function findBareQuestionObjects(text: string): QuestionSpan[] {
  const spans: QuestionSpan[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '{') {
      continue;
    }
    const end = matchingBrace(text, index);
    if (end < 0) {
      continue;
    }
    const questions = parseQuestionJson(text.slice(index, end));
    if (!questions) {
      continue;
    }
    const [start, expandedEnd] = expandWrappingTicks(text, index, end);
    spans.push({ start, end: expandedEnd, questions });
    index = expandedEnd - 1;
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
  let last = -1;
  for (const match of text.matchAll(QUESTION_OBJECT_START)) {
    last = match.index ?? last;
  }
  if (last < 0 || matchingBrace(text, last) >= 0) {
    return text;
  }
  return text.slice(0, last);
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
