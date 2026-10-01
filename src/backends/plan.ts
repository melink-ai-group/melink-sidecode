import type { PlanArtifact, TodoStep, TodoStepStatus } from './types';

/**
 * The plan artifact: one markdown file per thread, at a predictable location.
 *
 * Location (documented, workspace-relative):
 *
 *     .melink/plans/<thread-id>.md
 *
 * The name is derived from the **thread id**, never the raw prompt, so a second
 * turn in the same thread updates the same file instead of creating a second
 * plan. The directory is stable and ignored by default (the extension's
 * `.gitignore` covers `.melink/`).
 *
 * This module is host-free: it renders and parses markdown and computes paths,
 * and takes the filesystem write as a caller-provided function. That keeps the
 * per-thread naming and the bullet-list contract under unit test without a VS
 * Code host.
 */

/** Directory the plan files live in, workspace-relative. */
export const PLAN_DIRECTORY = '.melink/plans';

/** Heading the parser and renderer share. */
export const PLAN_STEPS_HEADING = '## Steps';

/** The one permitted write in Plan mode is this plan file. */
export function planRelativePath(threadId: string): string {
  return `${PLAN_DIRECTORY}/${planFileName(threadId)}`;
}

/**
 * A filesystem-safe file name for a thread id. Thread ids are provider-assigned
 * and may contain characters that are invalid on Windows (`:` `/` etc.), so they
 * are replaced rather than trusted. Deterministic: the same thread id always
 * yields the same file. The stem is bounded so an exotic id cannot produce an
 * unusable name.
 */
export function planFileName(threadId: string): string {
  const safe = sanitizeThreadId(threadId);
  return `${safe}.md`;
}

/** The sanitized, bounded file stem for a thread id (no extension). */
export function sanitizeThreadId(threadId: string): string {
  const safe = threadId
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 96);
  return safe.length > 0 ? safe : 'thread';
}

/**
 * Render a plan to markdown. The document body comes first and the checkbox
 * todo list is always last, under `## Steps`. `body` is the full prose; when
 * it is absent, `summary` is written in its place so a short plan still has
 * an opening paragraph.
 */
export function renderPlanMarkdown(input: {
  title: string;
  /** Free-form "what it will do" paragraph, used when `body` is absent. */
  summary?: string;
  /** Markdown between the title and the steps list. */
  body?: string;
  steps: readonly TodoStep[];
}): string {
  const lines: string[] = [`# ${input.title}`, ''];
  const prose = input.body?.trim() || input.summary?.trim() || '';
  if (prose.length > 0) {
    lines.push(prose, '');
  }
  lines.push(PLAN_STEPS_HEADING, '');
  for (const step of input.steps) {
    lines.push(`- [${stepMarker(step.status)}] ${step.text}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** The markdown checkbox for a step status. */
export function stepMarker(status: TodoStepStatus): string {
  switch (status) {
    case 'completed':
      return 'x';
    case 'inProgress':
      return '~';
    case 'denied':
      return '-';
    case 'pending':
    default:
      return ' ';
  }
}

/** Inverse of `stepMarker`. */
export function statusForMarker(marker: string): TodoStepStatus {
  switch (marker.trim().toLowerCase()) {
    case 'x':
      return 'completed';
    case '~':
      return 'inProgress';
    case '-':
      return 'denied';
    default:
      return 'pending';
  }
}

/**
 * Parse the bullet list of a plan markdown file into tracked steps. Only the
 * steps under the `## Steps` heading count, so a plan that quotes a bullet list
 * in its prose does not leak extra steps. A step with no checkbox is treated as
 * `pending`, so a hand-edited plan degrades sensibly rather than dropping steps.
 */
export function parsePlanSteps(markdown: string): TodoStep[] {
  const lines = markdown.split(/\r?\n/);
  const steps: TodoStep[] = [];
  let inSteps = false;
  for (const line of lines) {
    const heading = line.trim();
    if (heading.startsWith('#')) {
      // Any heading at or above `## Steps` ends the section; a deeper heading
      // inside a step does not.
      inSteps = heading === PLAN_STEPS_HEADING || heading.toLowerCase() === PLAN_STEPS_HEADING.toLowerCase();
      continue;
    }
    if (!inSteps) {
      continue;
    }
    const match = /^\s*[-*]\s+(?:\[(.)\]\s*)?(.*\S)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const rawMarker = match[1];
    const text = match[2].trim();
    if (text.length === 0) {
      continue;
    }
    steps.push({
      text,
      status: rawMarker === undefined ? 'pending' : statusForMarker(rawMarker)
    });
  }
  return steps;
}

/** Parse the title (`# ...`) of a plan file, for display. */
export function parsePlanTitle(markdown: string, fallback: string): string {
  const match = /^\s*#\s+(.+?)\s*$/m.exec(markdown);
  return match ? match[1].trim() : fallback;
}

/**
 * Parse the "what it will do" paragraph: the prose between the title and the
 * `## Steps` heading. Only the first paragraph is returned; a plan with no
 * prose yields `undefined` rather than an empty string.
 */
export function parsePlanSummary(markdown: string): string | undefined {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const body: string[] = [];
  let sawTitle = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!sawTitle) {
      if (/^#\s+/.test(trimmed)) {
        sawTitle = true;
      }
      continue;
    }
    if (trimmed.startsWith('#')) {
      break;
    }
    if (trimmed.length === 0) {
      // The first paragraph ends at the first blank line once it has content.
      if (body.length > 0) {
        break;
      }
      continue;
    }
    body.push(line);
  }
  const paragraph = body.join('\n').trim();
  return paragraph.length > 0 ? paragraph : undefined;
}

/**
 * The plan document between the title and `## Steps`: every paragraph, not
 * only the first. A plan with no prose yields `undefined`.
 */
export function parsePlanBody(markdown: string): string | undefined {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const body: string[] = [];
  let sawTitle = false;
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!sawTitle) {
      if (/^#\s+/.test(trimmed) && !trimmed.startsWith('##')) {
        sawTitle = true;
      }
      continue;
    }
    if (trimmed === PLAN_STEPS_HEADING || trimmed.toLowerCase() === PLAN_STEPS_HEADING.toLowerCase()) {
      break;
    }
    if (!started) {
      if (trimmed.length === 0) {
        continue;
      }
      started = true;
    }
    body.push(line);
  }
  while (body.length > 0 && body[body.length - 1].trim().length === 0) {
    body.pop();
  }
  const text = body.join('\n').trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Build a plan artifact view from raw markdown plus the metadata the host knows.
 * The steps are the source of truth for the todo list.
 */
export function planArtifactFromMarkdown(input: {
  path: string;
  markdown: string;
  fallbackTitle: string;
  updatedAt: number;
}): PlanArtifact {
  return {
    path: input.path,
    title: parsePlanTitle(input.markdown, input.fallbackTitle),
    summary: parsePlanSummary(input.markdown),
    body: parsePlanBody(input.markdown),
    steps: parsePlanSteps(input.markdown),
    updatedAt: input.updatedAt
  };
}

/**
 * The steps from a native `turn/plan/updated` notification, normalized to the
 * shared todo shape. The native status vocabulary is already the shared one, so
 * this is a direct mapping.
 */
export function todoStepsFromNative(
  steps: readonly { step: string; status: TodoStepStatus }[]
): TodoStep[] {
  return steps.map((entry) => ({ text: entry.step, status: entry.status }));
}

/**
 * Derive a plan from the agent's own reply, used when a Plan-mode turn finishes
 * without a native `turn/plan/updated`. Takes the **first** markdown bullet list
 * as the steps, since the plan prompt asks for exactly that; a reply with no
 * bullet list yields no steps rather than a fabricated plan.
 */
export function planStepsFromReply(reply: string): TodoStep[] {
  const lines = reply.split(/\r?\n/);
  const steps: TodoStep[] = [];
  let started = false;
  for (const line of lines) {
    const bullet = /^\s*[-*+]\s+(?:\[([^\]])\]\s*)?(.*\S)\s*$/.exec(line);
    if (!bullet) {
      // A blank line before the first bullet is fine; anything else after the
      // list has started ends it, so only the first contiguous list counts.
      if (started && line.trim().length > 0) {
        break;
      }
      continue;
    }
    const text = bullet[2].trim();
    if (text.length > 0) {
      started = true;
      steps.push({ text, status: bullet[1] ? statusForMarker(bullet[1]) : 'pending' });
    }
  }
  return steps;
}

/**
 * Derive the plan's "what it will do" prose from the agent's reply: the first
 * paragraph before the first bullet list. Used when a reply-derived plan has no
 * native plan summary, so the review card still shows its what-it-will-do
 * section. Returns `undefined` when there is no prose ahead of the steps.
 */
export function planSummaryFromReply(reply: string): string | undefined {
  const lines = reply.replace(/\r\n?/g, '\n').split('\n');
  const body: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || /^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      // A heading or the first list item ends the leading paragraph.
      break;
    }
    if (trimmed.length === 0) {
      if (body.length > 0) {
        break;
      }
      continue;
    }
    body.push(line);
  }
  const paragraph = body.join('\n').trim();
  return paragraph.length > 0 ? paragraph : undefined;
}

/** A plan lifted from an assistant reply: prose first, checkbox steps last. */
export interface PlanDocumentDraft {
  title?: string;
  body?: string;
  summary?: string;
  steps: TodoStep[];
}

function hasStepsHeading(markdown: string): boolean {
  return markdown.split(/\r?\n/).some((line) => {
    const heading = line.trim();
    return heading === PLAN_STEPS_HEADING || heading.toLowerCase() === PLAN_STEPS_HEADING.toLowerCase();
  });
}

function replyHasTitle(markdown: string): boolean {
  return /^\s*#(?!#)\s+\S/m.test(markdown);
}

/** Prose ahead of the first list, including later paragraphs. Skips a leading title. */
function proseBeforeList(reply: string): string | undefined {
  const lines = reply.replace(/\r\n?/g, '\n').split('\n');
  const body: string[] = [];
  let skippedTitle = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!skippedTitle && /^#(?!#)\s+\S/.test(trimmed)) {
      skippedTitle = true;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line) || trimmed.startsWith('#')) {
      break;
    }
    body.push(line);
  }
  while (body.length > 0 && body[body.length - 1].trim().length === 0) {
    body.pop();
  }
  const text = body.join('\n').trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Derive a plan document from an assistant reply. A `## Steps` section is the
 * todo list and everything above it is the body. Without that heading, the
 * first contiguous bullet list is the todo list and the prose before it is
 * the body. A reply with no steps yields an empty step list.
 */
export function planDocumentFromReply(reply: string): PlanDocumentDraft {
  if (hasStepsHeading(reply)) {
    const titled = replyHasTitle(reply);
    const title = titled ? parsePlanTitle(reply, '') : '';
    return {
      title: title.length > 0 ? title : undefined,
      body: parsePlanBody(reply),
      summary: parsePlanSummary(reply),
      steps: parsePlanSteps(reply)
    };
  }
  const titled = replyHasTitle(reply);
  const title = titled ? parsePlanTitle(reply, '') : '';
  return {
    title: title.length > 0 ? title : undefined,
    body: proseBeforeList(reply),
    summary: planSummaryFromReply(reply),
    steps: planStepsFromReply(reply)
  };
}

/**
 * True when the user asked to change an existing plan, rather than to start
 * work or ask a question about it. Used so a later Plan-mode turn leaves the
 * file in place unless the wording asks for a revision.
 */
export function userAsksToRevisePlan(text: string): boolean {
  const normalized = text.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return false;
  }
  if (/\b(?:update|revise|rewrite|change|edit|adjust|modify)\b(?:\s+\w+){0,6}\s+\b(?:the\s+|this\s+|my\s+|our\s+)?plan\b/.test(normalized)) {
    return true;
  }
  return /\b(?:the\s+|this\s+)?plan\b(?:\s+\w+){0,4}\s+\b(?:update|revision|revise|rewrite)\b/.test(normalized);
}

/**
 * Apply checkbox lines from a reply onto an existing todo list. Matching is by
 * step text, in order, so a duplicate step takes the next matching line.
 * Unmatched steps keep their status. A reply with no checkbox lines leaves
 * the list unchanged.
 */
export function mergeCheckboxStatuses(steps: readonly TodoStep[], reply: string): TodoStep[] {
  const updates = new Map<string, TodoStepStatus[]>();
  for (const line of reply.split(/\r?\n/)) {
    const match = /^\s*[-*+]\s+\[([^\]])\]\s*(.*\S)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const text = match[2].trim();
    const list = updates.get(text) ?? [];
    list.push(statusForMarker(match[1]));
    updates.set(text, list);
  }
  if (updates.size === 0) {
    return [...steps];
  }
  const used = new Map<string, number>();
  return steps.map((step) => {
    const list = updates.get(step.text);
    if (!list) {
      return step;
    }
    const index = used.get(step.text) ?? 0;
    if (index >= list.length) {
      return step;
    }
    used.set(step.text, index + 1);
    return { ...step, status: list[index] };
  });
}

/**
 * Apply a status update to one step of a plan, returning fresh steps. Matching is
 * by index so two identical step texts stay distinct. Out-of-range indices are a
 * no-op.
 */
export function updateStepStatus(
  steps: readonly TodoStep[],
  index: number,
  status: TodoStepStatus
): TodoStep[] {
  if (index < 0 || index >= steps.length) {
    return [...steps];
  }
  return steps.map((step, i) => (i === index ? { ...step, status } : step));
}
