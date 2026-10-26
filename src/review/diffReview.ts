/**
 * The host-free second-pass diff reviewer.
 *
 * A turn can stop as soon as the agent says it is done, even when the request
 * named a file the agent never touched. This module gives the host one pure
 * seam for a cheap review pass: build a read-only prompt, bound the diff that
 * goes into it, parse the model's JSON findings, and fall back to a
 * deterministic local check when no model review is available.
 *
 * The host supplies a read-only model worker for live orchestration. Callers
 * without a runner retain the deterministic local check ({@link localDiffReview}).
 *
 * ## Contracts
 *
 * - **Host-free.** No `vscode`, filesystem, child-process, or network import,
 *   so the whole module runs under `node --test` and can never mutate the
 *   workspace itself.
 * - **Read-only by construction.** The prompt is advisory, the parsers only
 *   return data, and the local reviewer only compares strings.
 * - **Deterministic.** Findings are sorted by path, line, severity, and
 *   message; no clocks, locale comparison, or random identities.
 * - **Bounded.** Every prompt carries at most {@link DIFF_REVIEW_CHAR_LIMIT}
 *   characters of diff text and each file at most
 *   {@link DIFF_REVIEW_LINE_LIMIT} lines. Truncation always leaves a `…`
 *   marker. The host still applies its own per-hunk review cap.
 * - **Advisory.** A failed review never fails the turn: it returns a `failed`
 *   result with a notice and the changes remain ready for review.
 */

export type DiffReviewSeverity = 'error' | 'warning' | 'info';

export interface DiffReviewFinding {
  path: string;
  line: number;
  severity: DiffReviewSeverity;
  message: string;
}

export interface DiffReviewFile {
  path: string;
  diff: string;
}

export interface DiffReviewInput {
  request: string;
  files: readonly DiffReviewFile[];
}

export type DiffReviewStatus = 'reviewed' | 'no-findings' | 'failed';

export interface DiffReviewResult {
  status: DiffReviewStatus;
  findings: readonly DiffReviewFinding[];
  notice?: string;
}

export type DiffReviewRunner = (
  input: DiffReviewInput,
  prompt: string
) => Promise<readonly DiffReviewFinding[] | DiffReviewResult>;

/** Per-file line cap for the diff text embedded in a review prompt. */
export const DIFF_REVIEW_LINE_LIMIT = 200;

/** Overall character cap for all diff text embedded in a review prompt. */
export const DIFF_REVIEW_CHAR_LIMIT = 24_000;

/** Upper bound on findings accepted from one reviewer response. */
export const DIFF_REVIEW_MAX_FINDINGS = 50;

/** Shown when a runner throws or misses its deadline. */
export const DIFF_REVIEW_FAILURE_NOTICE =
  'The diff review could not complete. Your changes are still ready for review.';

const TRUNCATION_MARKER = '…';

/**
 * Extensions treated as explicit file paths in a request. A version number such
 * as `1.93.0` or `22.12` must not look like one, so only real source, document,
 * and configuration suffixes are matched. Lower-case membership is checked.
 */
const PATH_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'css',
  'scss',
  'less',
  'html',
  'json',
  'md',
  'mdx',
  'vue',
  'svelte',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'swift',
  'rb',
  'php',
  'cs',
  'c',
  'cpp',
  'h',
  'yml',
  'yaml',
  'toml',
  'sh',
  'ps1',
  'sql'
]);

const PATH_EXTENSION_PATTERN = [...PATH_EXTENSIONS]
  .sort((left, right) => right.length - left.length)
  .join('|');

const PATH_TOKEN_PATTERN = new RegExp(
  `(?:(?:\\.{1,2}|[A-Za-z]:)[\\\\/])?(?:[A-Za-z0-9_@+.-]+[\\\\/])*[A-Za-z0-9_@+.-]+\\.(?:${PATH_EXTENSION_PATTERN})\\b`,
  'gi'
);

/**
 * Build the read-only reviewer prompt for one turn.
 *
 * Live orchestration sends this prompt through a read-only model worker.
 * Callers without a runner retain `localDiffReview`.
 *
 * The diff is bounded here rather than by the caller so every path into the
 * reviewer carries the same size guarantee.
 */
export function buildDiffReviewPrompt(input: DiffReviewInput): string {
  const files = boundDiffFiles(input.files);
  const diffText =
    files.length === 0
      ? '(no changed files in this turn)'
      : files
          .map(
            (file) =>
              `--- ${file.path} ---\n${file.diff.length > 0 ? file.diff : '(empty diff)'}`
          )
          .join('\n\n');

  return [
    'You are a read-only second-pass diff reviewer for an autonomous coding agent.',
    '',
    'This review is advisory only. Do not edit files, do not run commands, and do not change the workspace in any way. Another agent already made these changes; you never modify them.',
    '',
    'Original request:',
    '"""',
    input.request,
    '"""',
    '',
    'Changed files in this turn (bounded diff):',
    diffText,
    '',
    'Review rules:',
    '- Report only defects introduced or left by this turn that matter to the request.',
    '- Ignore style nits: formatting, naming preferences, import ordering, and subjective taste.',
    '- Verify the changes the user requested. A file named only as a reference, comparison, or read-only context does not need to be changed.',
    '- Use the changed file path exactly as shown above.',
    '- Line numbers are 1-based in the new file.',
    '- Return ONLY a JSON array of findings. No prose, no markdown fences, no explanations.',
    '- Each finding must be {"path":"<changed file>","line":1,"severity":"error"|"warning"|"info","message":"<one sentence>"}.',
    '- If there are no findings, return exactly [].'
  ].join('\n');
}

/**
 * Parse a reviewer response into validated findings.
 *
 * Accepts a plain JSON array, a fenced `json` block, or an array embedded in
 * prose. Invalid entries are dropped; a line below 1 is clamped to 1; the
 * result is sorted and capped at {@link DIFF_REVIEW_MAX_FINDINGS}.
 */
export function parseDiffReviewFindings(text: string): DiffReviewFinding[] {
  const parsed = extractFindingArray(text);
  if (parsed === undefined) {
    return [];
  }

  const findings: DiffReviewFinding[] = [];
  for (const entry of parsed) {
    const finding = normalizeFinding(entry);
    if (finding !== undefined) {
      findings.push(finding);
    }
  }
  return sortFindings(findings).slice(0, DIFF_REVIEW_MAX_FINDINGS);
}

/**
 * Deterministic local reviewer used when no model review is configured.
 *
 * It catches one specific failure: the request names a path that this turn did
 * not change. It is intentionally not a semantic reviewer and never invents a
 * finding when the request names no path.
 */
export function localDiffReview(input: DiffReviewInput): DiffReviewResult {
  const changed = new Set(
    input.files
      .filter((file) => file.diff.trim().length > 0)
      .map((file) => normalizePath(file.path).toLowerCase())
  );

  const findings: DiffReviewFinding[] = [];
  for (const path of extractMentionedPaths(input.request)) {
    if (changed.has(path.toLowerCase())) {
      continue;
    }
    findings.push({
      path,
      line: 1,
      severity: 'warning',
      message: `The request mentions ${path}, but the turn did not change it.`
    });
  }

  const sorted = sortFindings(findings);
  return {
    status: sorted.length === 0 ? 'no-findings' : 'reviewed',
    findings: sorted
  };
}

/**
 * Review one turn through an injected model runner, with a hard deadline.
 *
 * With no runner, the deterministic local Reviewer runs and no prompt is
 * built: there is no model call to make. A runner may return either a
 * findings array or a complete {@link DiffReviewResult}. Empty findings become
 * `no-findings`. A throw or a missed deadline becomes `failed` with a stable
 * notice; this function never throws and never blocks the caller after the
 * deadline.
 */
export async function runDiffReview(
  input: DiffReviewInput,
  runner?: DiffReviewRunner,
  timeoutMs = 15_000
): Promise<DiffReviewResult> {
  if (!runner) {
    return localDiffReview(input);
  }
  const prompt = buildDiffReviewPrompt(input);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('diff review timed out')),
      Math.max(0, timeoutMs)
    );
  });

  try {
    const raw = await Promise.race([
      Promise.resolve().then(() => runner(input, prompt)),
      timeout
    ]);

    if (Array.isArray(raw)) {
      return resultFromFindings(raw);
    }

    const result = raw as DiffReviewResult;
    const findings = normalizeFindings(result.findings);
    if (result.status === 'failed') {
      return {
        status: 'failed',
        findings,
        notice: result.notice ?? DIFF_REVIEW_FAILURE_NOTICE
      };
    }
    return {
      status: findings.length > 0 ? 'reviewed' : 'no-findings',
      findings,
      ...(result.notice === undefined ? {} : { notice: result.notice })
    };
  } catch {
    return {
      status: 'failed',
      findings: [],
      notice: DIFF_REVIEW_FAILURE_NOTICE
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Bound each file's diff and the combined diff text.
 *
 * Each file is capped to `maxLines` lines (including any truncation marker)
 * and `maxChars` characters. The combined diff text is then capped to
 * `maxChars` characters. A file that contributes no remaining characters is
 * still listed with an empty diff, so its path remains visible to the prompt.
 */
export function boundDiffFiles(
  files: readonly DiffReviewFile[],
  maxLines = DIFF_REVIEW_LINE_LIMIT,
  maxChars = DIFF_REVIEW_CHAR_LIMIT
): DiffReviewFile[] {
  const lineLimit = Math.max(1, Math.floor(maxLines));
  const charLimit = Math.max(1, Math.floor(maxChars));
  const bounded: DiffReviewFile[] = [];
  let usedChars = 0;

  for (const file of files) {
    let diff = truncateChars(truncateLines(file.diff, lineLimit), charLimit);
    const remaining = charLimit - usedChars;

    if (remaining <= 0) {
      bounded.push({ path: file.path, diff: '' });
      continue;
    }
    if (diff.length > remaining) {
      diff =
        remaining <= 1
          ? TRUNCATION_MARKER.slice(0, remaining)
          : `${diff.slice(0, remaining - 1)}${TRUNCATION_MARKER}`;
    }

    usedChars += diff.length;
    bounded.push({ path: file.path, diff });
  }

  return bounded;
}

function resultFromFindings(
  findings: readonly DiffReviewFinding[]
): DiffReviewResult {
  const normalized = normalizeFindings(findings);
  return {
    status: normalized.length === 0 ? 'no-findings' : 'reviewed',
    findings: normalized
  };
}

function normalizeFindings(
  findings: readonly DiffReviewFinding[] | undefined
): DiffReviewFinding[] {
  const normalized: DiffReviewFinding[] = [];
  for (const finding of findings ?? []) {
    const candidate = normalizeFinding(finding);
    if (candidate !== undefined) {
      normalized.push(candidate);
    }
  }
  return sortFindings(normalized).slice(0, DIFF_REVIEW_MAX_FINDINGS);
}

function extractFindingArray(text: string): unknown[] | undefined {
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let match = fence.exec(text); match !== null; match = fence.exec(text)) {
    candidates.push(match[1].trim());
  }

  const trimmed = text.trim();
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(trimmed.slice(firstBracket, lastBracket + 1));
  }
  if (trimmed.length > 0) {
    candidates.push(trimmed);
  }

  for (const candidate of candidates) {
    if (candidate.length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        return parsed;
      }
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { findings?: unknown }).findings)
      ) {
        return (parsed as { findings: unknown[] }).findings;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function normalizeFinding(value: unknown): DiffReviewFinding | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;

  const path = typeof record.path === 'string' ? record.path.trim() : '';
  if (path.length === 0) {
    return undefined;
  }

  const message =
    typeof record.message === 'string' ? record.message.trim() : '';
  if (message.length === 0) {
    return undefined;
  }

  const rawSeverity =
    typeof record.severity === 'string'
      ? record.severity.trim().toLowerCase()
      : '';
  if (!isSeverity(rawSeverity)) {
    return undefined;
  }

  const rawLine =
    typeof record.line === 'number'
      ? record.line
      : typeof record.line === 'string' && record.line.trim().length > 0
        ? Number(record.line)
        : Number.NaN;
  if (!Number.isFinite(rawLine)) {
    return undefined;
  }

  return {
    path,
    line: Math.max(1, Math.floor(rawLine)),
    severity: rawSeverity,
    message
  };
}

function isSeverity(value: string): value is DiffReviewSeverity {
  return value === 'error' || value === 'warning' || value === 'info';
}

function sortFindings(
  findings: readonly DiffReviewFinding[]
): DiffReviewFinding[] {
  const severityRank: Record<DiffReviewSeverity, number> = {
    error: 0,
    warning: 1,
    info: 2
  };
  return [...findings].sort((a, b) => {
    if (a.path !== b.path) {
      return a.path < b.path ? -1 : 1;
    }
    if (a.line !== b.line) {
      return a.line - b.line;
    }
    if (a.severity !== b.severity) {
      return severityRank[a.severity] - severityRank[b.severity];
    }
    if (a.message === b.message) {
      return 0;
    }
    return a.message < b.message ? -1 : 1;
  });
}

function extractMentionedPaths(request: string): string[] {
  const mentions = new Map<string, string>();

  const backtick = /`([^`\n]+)`/g;
  for (let match = backtick.exec(request); match !== null; match = backtick.exec(request)) {
    addMention(mentions, match[1]);
  }

  PATH_TOKEN_PATTERN.lastIndex = 0;
  for (let match = PATH_TOKEN_PATTERN.exec(request); match !== null; match = PATH_TOKEN_PATTERN.exec(request)) {
    const start = match.index;
    const before = start > 0 ? request[start - 1] : '';
    if (before === '/' || before === '\\') {
      continue;
    }
    addMention(mentions, match[0]);
  }

  return [...mentions.values()].filter((path) => path.length > 0).sort();
}

function addMention(mentions: Map<string, string>, raw: string): void {
  const cleaned = cleanCandidate(raw);
  if (!looksLikePath(cleaned)) {
    return;
  }
  const normalized = normalizePath(cleaned);
  const key = normalized.toLowerCase();
  if (!mentions.has(key)) {
    mentions.set(key, normalized);
  }
}

function cleanCandidate(raw: string): string {
  return raw
    .trim()
    .replace(/^[`"'([{<]+/, '')
    .replace(/:\d+(?::\d+)?$/, '')
    .replace(/[.,;`"')\]}>,]+$/, '')
    .trim();
}

function looksLikePath(value: string): boolean {
  if (value.length === 0 || /\s/.test(value) || value.includes('://')) {
    return false;
  }
  if (value.includes('*') || value.includes('?')) {
    return false;
  }
  const dot = value.lastIndexOf('.');
  if (dot <= 0) {
    return false;
  }
  const extension = value.slice(dot + 1).toLowerCase();
  if (!PATH_EXTENSIONS.has(extension)) {
    return false;
  }
  if (/[\\/]/.test(value)) {
    return true;
  }
  return /^[A-Za-z0-9_@+.-]+$/.test(value.slice(0, dot));
}

function normalizePath(value: string): string {
  let path = value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  while (path.startsWith('./')) {
    path = path.slice(2);
  }
  return path;
}

function truncateLines(text: string, maxLines: number): string {
  if (text.length === 0) {
    return text;
  }
  const lines = text.split('\n');
  if (lines.length <= maxLines) {
    return text;
  }
  if (maxLines <= 1) {
    return TRUNCATION_MARKER;
  }
  return `${lines.slice(0, maxLines - 1).join('\n')}\n${TRUNCATION_MARKER}`;
}

function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return TRUNCATION_MARKER.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - 1)}${TRUNCATION_MARKER}`;
}
