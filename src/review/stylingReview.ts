/**
 * Advisory styling-consistency check for frontend work.
 *
 * A UI change can be functionally correct and still drift from the project's
 * design language: a literal colour where the theme expects a token, an inline
 * style where a shared class owns hover/focus states, a font that ignores the
 * workbench, or a radius off the brand scale. This module is the host-free seam
 * for that check. It stays read-only, deterministic, and bounded.
 *
 * ## Contracts
 *
 * - **Frontend-only.** `hasFrontendWork` decides whether a turn has anything to
 *   check. A backend-only turn is skipped before any prompt or runner is built.
 * - **Brand-kit aware.** The host supplies the project's token/design files. If
 *   none exist, the local pass still checks generic token and state consistency
 *   and says so in its notice.
 * - **Read-only and advisory.** Findings never block Keep/Reject and never edit
 *   a file.
 * - **Local-only in this release.** No model runner is wired, so the pass that
 *   runs is `localStylingReview`; the prompt builder is reserved and is never
 *   sent to a model today.
 * - **Deterministic.** Findings are sorted by path, line, severity, and message.
 */

import {
  DIFF_REVIEW_CHAR_LIMIT,
  DIFF_REVIEW_LINE_LIMIT,
  DIFF_REVIEW_MAX_FINDINGS,
  boundDiffFiles,
  type DiffReviewFile,
  type DiffReviewFinding,
  type DiffReviewResult,
  type DiffReviewSeverity
} from './diffReview.ts';

export const STYLING_REVIEW_TIMEOUT_MS = 15_000;

export const STYLING_REVIEW_FAILURE_NOTICE =
  'The styling check could not complete. Your changes are still ready for review.';

export const STYLING_NO_BRAND_KIT_NOTICE =
  'No brand kit was found; this pass checked generic token and state consistency only.';

/** Extensions treated as frontend work for this pass. */
const FRONTEND_EXTENSIONS: ReadonlySet<string> = new Set([
  'tsx',
  'jsx',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
  'vue',
  'svelte',
  'astro'
]);

/** Style-only files whose literal colours are expected inside a token file. */
const TOKEN_PATHS = /(^|\/)(tokens?\.css|design\.md)$/i;

const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;
const CUSTOM_PROPERTY = /var\(\s*(--[A-Za-z0-9-]+)/g;
const KNOWN_CUSTOM_PROPERTY = /--[A-Za-z0-9-]+/g;

export interface StylingBrandKitFile {
  path: string;
  text: string;
}

export interface StylingReviewFile extends DiffReviewFile {
  /** Workspace-relative path used for the frontend gate. */
  path: string;
}

export interface StylingReviewInput {
  request: string;
  files: readonly StylingReviewFile[];
  brandKit: readonly StylingBrandKitFile[];
}

export type StylingReviewRunner = (
  input: StylingReviewInput,
  prompt: string
) => Promise<readonly DiffReviewFinding[] | DiffReviewResult>;

/** True when a changed path is UI code or styling. */
export function isFrontendPath(path: string): boolean {
  const match = /\.([A-Za-z0-9]+)$/.exec(path.trim());
  return match ? FRONTEND_EXTENSIONS.has(match[1].toLowerCase()) : false;
}

/** True when this turn changed at least one frontend file. */
export function hasFrontendWork(files: readonly { path: string }[]): boolean {
  return files.some((file) => isFrontendPath(file.path));
}

/**
 * The opt-in gate: enabled, and the turn actually changed frontend work. This
 * is kept pure so the host can decide before reading a brand kit or building a
 * prompt.
 */
export function shouldRunStylingCheck(
  enabled: boolean,
  files: readonly { path: string }[]
): boolean {
  return enabled && hasFrontendWork(files);
}

/**
 * Build the read-only styling reviewer prompt, including the brand kit when
 * present.
 *
 * Reserved for a model runner. No model runner is wired in this release, so
 * this prompt is not sent anywhere: the styling check runs
 * {@link localStylingReview}, a deterministic local pass.
 */
export function buildStylingReviewPrompt(input: StylingReviewInput): string {
  const files = boundDiffFiles(
    input.files.map((file) => ({ path: file.path, diff: file.diff })),
    DIFF_REVIEW_LINE_LIMIT,
    DIFF_REVIEW_CHAR_LIMIT
  );
  const diffText =
    files.length === 0
      ? '(no frontend files changed in this turn)'
      : files
          .map((file) => `--- ${file.path} ---\n${file.diff.length > 0 ? file.diff : '(empty diff)'}`)
          .join('\n\n');
  const kitText =
    input.brandKit.length === 0
      ? '(no brand kit found; compare against the existing components and theme tokens in the workspace)'
      : input.brandKit
          .map((file) => `--- ${file.path} ---\n${boundText(file.text, 8_000)}`)
          .join('\n\n');

  return [
    'You are a read-only styling-consistency reviewer for an autonomous coding agent.',
    '',
    'This review is advisory only. Do not edit files, do not run commands, and do not change the workspace in any way. Another agent already made these changes; you never modify them.',
    '',
    'Original request:',
    '"""',
    input.request,
    '"""',
    '',
    'Project brand kit and design tokens:',
    kitText,
    '',
    'Changed frontend files in this turn (bounded diff):',
    diffText,
    '',
    'Review rules:',
    '- Compare buttons, inputs, checkboxes, textareas, selects, and other repeated controls against comparable controls on other existing pages and shared components, using the supplied evidence. Check typography, colours, spacing, sizing, borders, radii, and hover/focus/disabled/error states. If reference pages are unavailable, do not claim they were checked or invent cross-page findings.',
    '- If the user explicitly requests a specific style, redesign, or other departure, respect it for its stated scope and check consistency elsewhere. Do not report a user-requested style departure as an inconsistency.',
    '- Compare the new UI with the brand kit, the design tokens, and the existing components in this project.',
    '- Report only real visual inconsistencies introduced or left by this turn: hardcoded colours or fonts, inline styles that bypass shared state treatments, spacing/radius values off the project scale, missing hover/focus/disabled/error states, and misuse of a colour the kit reserves for a specific role.',
    '- If the brand kit reserves a colour or token for a specific role, respect that reservation; when the kit defines no such reservation, do not invent one.',
    '- Use the kit’s own token names, scales, and state conventions; never assume a brand name or a token prefix.',
    '- Ignore formatting, import order, naming preferences, and subjective taste.',
    '- Use the changed file path exactly as shown above.',
    '- Line numbers are 1-based in the new file.',
    '- Return ONLY a JSON array of findings. No prose, no markdown fences, no explanations.',
    '- Each finding must be {"path":"<changed file>","line":1,"severity":"error"|"warning"|"info","message":"<one sentence>"}.',
    '- If there are no findings, return exactly [].'
  ].join('\n');
}

/**
 * Run one styling check through an injected model runner, with a hard deadline.
 * With no runner, the deterministic local pass runs and no prompt is built:
 * there is no model call to make. A future model reviewer can replace the
 * local pass without changing the host or the persisted result shape.
 */
export async function runStylingReview(
  input: StylingReviewInput,
  runner?: StylingReviewRunner,
  timeoutMs = STYLING_REVIEW_TIMEOUT_MS
): Promise<DiffReviewResult> {
  if (!runner) {
    return localStylingReview(input);
  }
  const prompt = buildStylingReviewPrompt(input);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('styling review timed out')),
      Math.max(0, timeoutMs)
    );
  });

  try {
    const raw = await Promise.race([
      Promise.resolve().then(() => runner(input, prompt)),
      timeout
    ]);
    if (Array.isArray(raw)) {
      return resultFromFindings(raw, brandingNotice(input));
    }
    const result = raw as DiffReviewResult;
    if (result.status === 'failed') {
      return {
        status: 'failed',
        findings: normalizeFindings(result.findings),
        notice: result.notice ?? STYLING_REVIEW_FAILURE_NOTICE
      };
    }
    return resultFromFindings(result.findings, result.notice);
  } catch {
    return {
      status: 'failed',
      findings: [],
      notice: STYLING_REVIEW_FAILURE_NOTICE
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * The local fallback: check the added lines of each changed frontend file for
 * the token and state rules the project already enforces elsewhere.
 */
export function localStylingReview(input: StylingReviewInput): DiffReviewResult {
  const knownTokens = new Set<string>();
  for (const file of input.brandKit) {
    for (const token of file.text.match(KNOWN_CUSTOM_PROPERTY) ?? []) {
      knownTokens.add(token);
    }
  }
  const hasBrandKit = input.brandKit.length > 0;
  // A project chooses its own token prefix, so the local pass learns the
  // prefixes the kit actually declares and never assumes one brand's names.
  const families = tokenFamilies(input.brandKit);
  const findings: DiffReviewFinding[] = [];

  for (const file of input.files) {
    if (!isFrontendPath(file.path)) {
      continue;
    }
    const tokenFile = TOKEN_PATHS.test(file.path);
    const componentFile = /\.(tsx|jsx|vue|svelte|astro)$/i.test(file.path);
    for (const line of addedLines(file.diff)) {
      const text = line.text.trim();
      if (!text || isComment(text)) {
        continue;
      }
      if (!tokenFile && HEX_COLOR.test(text)) {
        findings.push(finding(file.path, line.line, 'warning',
          'Hardcoded hex color; use a theme or brand token so the UI follows the host and the brand kit.'));
      }
      if (componentFile && (/\bstyle=\{\{/.test(text) || /\bstyle="/.test(text))) {
        findings.push(finding(file.path, line.line, 'info',
          'Inline style; prefer a shared class so tokens and hover/focus states stay consistent.'));
      }
      if (/\bfont-family\s*:/.test(text) && !/var\(/.test(text)) {
        findings.push(finding(file.path, line.line, 'warning',
          'Hardcoded font family; inherit the project’s font token or the host default instead.'));
      }
      if (hasBrandKit) {
        for (const match of text.matchAll(CUSTOM_PROPERTY)) {
          const token = match[1];
          if (!knownTokens.has(token) && families.some((family) => token.startsWith(family))) {
            findings.push(finding(file.path, line.line, 'warning',
              `Custom property ${token} is not defined in the brand kit.`));
          }
        }
      }
      if (/!important\b/.test(text)) {
        findings.push(finding(file.path, line.line, 'info',
          'Avoid !important; use a scoped selector or a shared class instead.'));
      }
    }
  }

  return resultFromFindings(findings, brandingNotice(input));
}

function brandingNotice(input: StylingReviewInput): string | undefined {
  return input.brandKit.length === 0 ? STYLING_NO_BRAND_KIT_NOTICE : undefined;
}

/**
 * The token prefixes a brand kit declares (`--acme-`, `--brand-`, ...).
 * Derived from the kit so an unknown-token finding is scoped to the project's
 * own design tokens instead of one repository's naming.
 */
function tokenFamilies(brandKit: readonly StylingBrandKitFile[]): string[] {
  const families = new Set<string>();
  for (const file of brandKit) {
    for (const token of file.text.match(KNOWN_CUSTOM_PROPERTY) ?? []) {
      // `--acme-surface` declares the family `--acme-`. A one-segment token
      // (`--brand`) declares only its own prefix.
      const lastDash = token.lastIndexOf('-');
      families.add(lastDash > 1 ? token.slice(0, lastDash + 1) : `${token}-`);
    }
  }
  return [...families];
}

function addedLines(diff: string): Array<{ line: number; text: string }> {
  const lines: Array<{ line: number; text: string }> = [];
  let newLine = 0;
  for (const raw of diff.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      lines.push({ line: Math.max(1, newLine), text: raw.slice(1) });
      newLine += 1;
      continue;
    }
    if (raw.startsWith('-') && !raw.startsWith('---')) {
      continue;
    }
    newLine += 1;
  }
  return lines;
}

function isComment(text: string): boolean {
  return /^(?:\/\/|\/\*|<!--)/.test(text);
}

function finding(
  path: string,
  line: number,
  severity: DiffReviewSeverity,
  message: string
): DiffReviewFinding {
  return { path, line, severity, message };
}

function resultFromFindings(
  findings: readonly DiffReviewFinding[] | undefined,
  notice: string | undefined
): DiffReviewResult {
  const normalized = normalizeFindings(findings);
  return {
    status: normalized.length > 0 ? 'reviewed' : 'no-findings',
    findings: normalized,
    ...(notice === undefined ? {} : { notice })
  };
}

function normalizeFindings(findings: readonly DiffReviewFinding[] | undefined): DiffReviewFinding[] {
  const seen = new Set<string>();
  const normalized: DiffReviewFinding[] = [];
  for (const finding of findings ?? []) {
    if (!finding || typeof finding.path !== 'string' || typeof finding.message !== 'string') {
      continue;
    }
    const severity =
      finding.severity === 'error' || finding.severity === 'warning' || finding.severity === 'info'
        ? finding.severity
        : 'info';
    const line = Number.isFinite(finding.line) ? Math.max(1, Math.floor(finding.line)) : 1;
    const key = `${finding.path}\0${line}\0${severity}\0${finding.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({ path: finding.path, line, severity, message: finding.message });
  }
  return normalized.sort(compareFindings).slice(0, DIFF_REVIEW_MAX_FINDINGS);
}

function compareFindings(left: DiffReviewFinding, right: DiffReviewFinding): number {
  if (left.path !== right.path) {
    return left.path < right.path ? -1 : 1;
  }
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  const order = severityOrder(left.severity) - severityOrder(right.severity);
  if (order !== 0) {
    return order;
  }
  return left.message < right.message ? -1 : left.message > right.message ? 1 : 0;
}

function severityOrder(severity: DiffReviewSeverity): number {
  return severity === 'error' ? 0 : severity === 'warning' ? 1 : 2;
}

function boundText(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}
