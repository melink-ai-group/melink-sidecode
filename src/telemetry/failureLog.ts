import { MODE_PROMPT_VERSION } from '../backends/modes.ts';

/**
 * The fixed classes a missed-issue entry can carry. The list is small and
 * documented on purpose: a closed taxonomy keeps the local log useful for
 * spotting patterns without accepting free-form categories.
 */
export const FAILURE_LOG_ISSUE_CLASSES = [
  'missed-fe-detail',
  'missed-requirement',
  'wrong-command',
  'bad-decision',
  'tool-misuse',
  'other'
] as const;

export type FailureIssueClass = (typeof FAILURE_LOG_ISSUE_CLASSES)[number];

/** One line of the local JSONL log. The shape is fixed; there are no extras. */
export interface FailureLogEntry {
  timestamp: string;
  issueClass: FailureIssueClass;
  modelId: string;
  providerId: string;
  promptVersion: string;
  summary: string;
}

/** What the caller may provide. Anything else on the object is ignored. */
export interface FailureLogDraft {
  issueClass: unknown;
  modelId: unknown;
  providerId: unknown;
  /** Omitted means the current `MODE_PROMPT_VERSION`. */
  promptVersion?: unknown;
  summary: unknown;
}

/**
 * The host seam. `enabled` gates every write, `append` receives one complete
 * JSONL line, and `now` makes the timestamp deterministic in tests. The module
 * itself never touches the filesystem or the network.
 */
export interface FailureLogSink {
  enabled: () => boolean;
  append: (line: string) => Promise<void>;
  now: () => string;
}

export type FailureLogFailureReason = 'disabled' | 'invalid';

export type FailureLogResult =
  | { ok: true; entry: FailureLogEntry; line: string }
  | { ok: false; reason: FailureLogFailureReason; message?: string };

/** The summary is capped so one entry stays one short line. */
export const FAILURE_LOG_SUMMARY_MAX = 200;

const MODEL_ID_MAX = 120;
const PROVIDER_ID_MAX = 64;
const PROMPT_VERSION_MAX = 64;

/** True when a value is one of the documented issue classes. */
export function isFailureIssueClass(value: unknown): value is FailureIssueClass {
  return typeof value === 'string' && (FAILURE_LOG_ISSUE_CLASSES as readonly string[]).includes(value);
}

/**
 * Common credential shapes. They are replaced with the literal `<redacted>`
 * before the summary is capped or written, so a paste cannot land in the file.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bghp_[A-Za-z0-9]{8,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:token|password|passwd|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi
];

/**
 * Strip control characters and newlines, collapse whitespace, redact
 * secret-like values, then cap. Redaction runs before the cap on purpose, so a
 * credential that straddles the boundary is still replaced rather than
 * truncated into the written line. Applied to every text field, not just the
 * summary, so an identity field cannot smuggle one either.
 */
function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  const flattened = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return redactFailureLogSecrets(flattened).slice(0, max).trim();
}

/** Replace secret-like values wherever they appear in a string. */
export function redactFailureLogSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, '<redacted>'), value);
}

/**
 * The summary a caller pasted is treated as untrusted metadata: control
 * characters and newlines become spaces, secrets are redacted, and the result
 * is capped. It is never interpreted or split into more lines.
 */
export function sanitizeFailureLogSummary(value: unknown): string {
  return cleanText(value, 4000).slice(0, FAILURE_LOG_SUMMARY_MAX).trim();
}

/**
 * Validate a draft and, when the sink is enabled, append exactly one compact
 * JSONL line. Returning a result instead of throwing keeps the command path
 * simple: a disabled log is a normal outcome, not an error.
 *
 * The entry is built field by field from the allow-list above. A `content`,
 * `prompt`, `stderr`, `code`, or `secret` property on the draft is therefore
 * never copied into the entry or the line.
 */
export async function recordFailureEntry(
  sink: FailureLogSink,
  draft: FailureLogDraft
): Promise<FailureLogResult> {
  // Off means no timestamp read and no append. The host never creates its
  // directory or file either, because nothing on this path calls the sink.
  if (!sink.enabled()) {
    return { ok: false, reason: 'disabled' };
  }

  if (!isFailureIssueClass(draft.issueClass)) {
    return {
      ok: false,
      reason: 'invalid',
      message: `Choose one of: ${FAILURE_LOG_ISSUE_CLASSES.join(', ')}.`
    };
  }

  const modelId = cleanText(draft.modelId, MODEL_ID_MAX);
  if (!modelId) {
    return { ok: false, reason: 'invalid', message: 'A model id is required.' };
  }

  const providerId = cleanText(draft.providerId, PROVIDER_ID_MAX);
  if (!providerId) {
    return { ok: false, reason: 'invalid', message: 'A provider id is required.' };
  }

  const promptVersion = cleanText(
    draft.promptVersion === undefined ? MODE_PROMPT_VERSION : draft.promptVersion,
    PROMPT_VERSION_MAX
  );
  if (!promptVersion) {
    return { ok: false, reason: 'invalid', message: 'A prompt version is required.' };
  }

  const summary = sanitizeFailureLogSummary(draft.summary);
  if (!summary) {
    return { ok: false, reason: 'invalid', message: 'A short summary is required.' };
  }

  const entry: FailureLogEntry = {
    timestamp: sink.now(),
    issueClass: draft.issueClass,
    modelId,
    providerId,
    promptVersion,
    summary
  };
  const line = JSON.stringify(entry);
  await sink.append(`${line}\n`);
  return { ok: true, entry, line };
}
