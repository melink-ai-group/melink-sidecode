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

const FENCE = /```sidecode-question[^\n]*\r?\n([\s\S]*?)```/gi;

/**
 * Pull a valid question block out of an assistant reply and remove it.
 * Invalid JSON is left in place. An empty result means there is nothing to ask.
 */
export function extractSidecodeQuestions(text: string): { text: string; questions?: ClarifyingQuestion[] } {
  const matches = [...text.matchAll(FENCE)];
  if (matches.length === 0) {
    return { text };
  }
  const questions: ClarifyingQuestion[] = [];
  const removals: string[] = [];
  for (const match of matches) {
    const parsed = parseQuestionJson(match[1] ?? '');
    if (!parsed) {
      continue;
    }
    questions.push(...parsed);
    if (match[0]) {
      removals.push(match[0]);
    }
  }
  if (questions.length === 0) {
    return { text };
  }
  let stripped = text;
  for (const block of removals) {
    stripped = stripped.replace(block, '');
  }
  return {
    text: stripped.replace(/\n{3,}/g, '\n\n').trim(),
    questions: questions.map((question, index) => ({ ...question, id: question.id || `q${index + 1}` }))
  };
}

/** Hide a question fence from the transcript while Plan or Agent is streaming it. */
export function hideQuestionFence(text: string): string {
  return text
    .replace(FENCE, '')
    .replace(/```sidecode-question[^\n]*\r?\n[\s\S]*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The follow-up the agent reads after the card is finished.
 * One line per question, in the order they were asked.
 */
export function formatQuestionAnswers(questions: readonly ClarifyingQuestion[], answers: readonly QuestionAnswer[]): string {
  const lines = questions.map((question, index) => {
    const answer = answers.find((entry) => entry.questionId === question.id);
    const text = answer?.text.trim() || SKIPPED_ANSWER;
    return `${index + 1}. ${question.prompt}: ${text}`;
  });
  return `Answers:\n${lines.join('\n')}`;
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
    if (labels.length === 2) {
      break;
    }
  }
  return labels;
}

function parseQuestionJson(body: string): ClarifyingQuestion[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
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
  const prompt = asString(record.prompt) ?? asString(record.question) ?? asString(record.text);
  if (!prompt) {
    return undefined;
  }
  const header = asString(record.header);
  return {
    id: asString(record.id) ?? `q${index + 1}`,
    ...(header ? { header } : {}),
    prompt,
    options: rankedOptions(record.options)
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
