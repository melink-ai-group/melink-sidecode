import type { PlanArtifact, TodoStep, TodoStepStatus, TranscriptItem } from './types';

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

/**
 * A plan document opens itself in the rendered preview once: the first time it
 * exists, still has steps, and has not been built. Later revisions and step
 * updates refresh an open preview without taking focus again.
 */
export function shouldAutoOpenPlanDocument(input: {
  built?: boolean;
  stepCount: number;
  alreadyOpened: boolean;
}): boolean {
  return input.built !== true && input.stepCount > 0 && !input.alreadyOpened;
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

/** True when a reply contains the plan's `## Steps` section. */
export function hasPlanStepsHeading(markdown: string): boolean {
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
 * A plan file under `.melink/plans/` that is not already a chat's own plan file.
 * Thread-id files stay with the chat that owns them. A file moved in by hand
 * (any other name) can be recovered.
 */
export function isLoosePlanFile(relativePath: string, ownedPaths: ReadonlySet<string>): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  if (!normalized.startsWith(`${PLAN_DIRECTORY}/`) || !normalized.toLowerCase().endsWith('.md')) {
    return false;
  }
  return !ownedPaths.has(normalized);
}

/** A readable title from a plan file name, used when the document has no `#` heading. */
export function planTitleFromFileName(name: string): string {
  const stem = name.replace(/^.*[\\/]/, '').replace(/\.md$/i, '');
  const words = stem.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words.length > 0 ? words : 'Plan';
}

/**
 * Read a plan that was saved outside the host's thread file and then moved
 * into `.melink/plans/`. A `## Steps` list or the first bullet list is used.
 * A numbered list is used when the document has no bullets. No steps means
 * the file is not a plan the host can build.
 */
export function recoverPlanDraft(markdown: string, fallbackTitle: string): PlanDocumentDraft | undefined {
  const draft = planDocumentFromReply(markdown);
  const steps = draft.steps.length > 0 ? draft.steps : numberedPlanSteps(markdown);
  if (steps.length === 0) {
    return undefined;
  }
  const title = draft.title?.trim() || fallbackTitle.trim() || 'Plan';
  return {
    title,
    body: draft.body,
    summary: draft.summary,
    steps
  };
}

/** The first contiguous numbered list, as pending steps. */
function numberedPlanSteps(markdown: string): TodoStep[] {
  const steps: TodoStep[] = [];
  let started = false;
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^\s*\d+[.)]\s+(?:\[([^\]])\]\s*)?(.*\S)\s*$/.exec(line);
    if (!match) {
      if (started && line.trim().length > 0) {
        break;
      }
      continue;
    }
    const text = match[2].trim();
    if (text.length === 0) {
      continue;
    }
    started = true;
    steps.push({ text, status: match[1] ? statusForMarker(match[1]) : 'pending' });
  }
  return steps;
}

/**
 * Derive a plan document from an assistant reply. A `## Steps` section is the
 * todo list and everything above it is the body. Without that heading, the
 * first contiguous bullet list is the todo list and the prose before it is
 * the body. A reply with no steps yields an empty step list.
 */
export function planDocumentFromReply(reply: string): PlanDocumentDraft {
  if (hasPlanStepsHeading(reply)) {
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
 * Put answered questions into the plan body. A later `## Decisions` section is
 * replaced, so each new round of answers is what the document shows.
 */
export function applyPlanDecisions(body: string | undefined, lines: readonly string[]): string | undefined {
  if (lines.length === 0) {
    return body;
  }
  const section = ['## Decisions', '', ...lines.map((line) => `- ${line}`)].join('\n');
  const prose = (body ?? '').replace(/\r\n?/g, '\n').trim();
  if (prose.length === 0) {
    return section;
  }
  const match = /^## Decisions\s*$/im.exec(prose);
  if (!match) {
    return `${prose}\n\n${section}`;
  }
  const afterHeading = prose.slice(match.index + match[0].length);
  const nextHeading = /\n##\s+/.exec(afterHeading);
  const tail = nextHeading ? afterHeading.slice(nextHeading.index + 1).trim() : '';
  const head = prose.slice(0, match.index).trim();
  return [head, section, tail].filter((part) => part.length > 0).join('\n\n');
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

/** Collapse whitespace so a wrapped checkbox line still matches its step. */
function stepTextKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const STEP_STATUS_RANK: Record<TodoStepStatus, number> = {
  pending: 0,
  inProgress: 1,
  completed: 2,
  denied: 3
};

/**
 * Keep the further-along status. A later "- [ ]" does not clear a step that
 * was already started or finished, and a denied step stays denied.
 */
export function preferStepStatus(current: TodoStepStatus, incoming: TodoStepStatus): TodoStepStatus {
  if (current === 'denied') {
    return current;
  }
  if (incoming === 'denied') {
    return incoming;
  }
  return STEP_STATUS_RANK[incoming] >= STEP_STATUS_RANK[current] ? incoming : current;
}

/**
 * Apply reported statuses onto an existing todo list. Matching is by step text.
 * A step that is reported more than once keeps the further-along status, so a
 * later empty box does not clear one that already started or finished.
 * Duplicate step texts take the latest reports in order, one each. Steps with
 * no report keep their status.
 */
export function assignStepStatuses(
  steps: readonly TodoStep[],
  updates: ReadonlyMap<string, readonly TodoStepStatus[]>
): TodoStep[] {
  if (updates.size === 0) {
    return [...steps];
  }
  const counts = new Map<string, number>();
  for (const step of steps) {
    const key = stepTextKey(step.text);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const windows = new Map<string, readonly TodoStepStatus[]>();
  for (const [text, list] of updates) {
    const key = stepTextKey(text);
    const count = counts.get(key) ?? 0;
    if (count === 0 || list.length === 0) {
      continue;
    }
    const latest = list.length > count ? list.slice(list.length - count) : [...list];
    if (list.length > count) {
      const prefix = list.slice(0, list.length - count).reduce((current, next) => preferStepStatus(current, next));
      latest[0] = preferStepStatus(prefix, latest[0]);
    }
    windows.set(key, latest);
  }
  const used = new Map<string, number>();
  return steps.map((step) => {
    const key = stepTextKey(step.text);
    const list = windows.get(key);
    if (!list) {
      return step;
    }
    const index = used.get(key) ?? 0;
    if (index >= list.length) {
      return step;
    }
    used.set(key, index + 1);
    const status = preferStepStatus(step.status, list[index]);
    return status === step.status ? step : { ...step, status };
  });
}

/**
 * Apply checkbox lines from a reply onto an existing todo list. Matching is by
 * step text. The latest line for a step wins, so a later "- [x]" replaces an
 * earlier "- [~]" for that same step. Duplicate step texts take the latest
 * lines in order. Unmatched steps keep their status. A reply with no checkbox
 * lines leaves the list unchanged.
 */
export function mergeCheckboxStatuses(steps: readonly TodoStep[], reply: string): TodoStep[] {
  const updates = new Map<string, TodoStepStatus[]>();
  for (const line of reply.split(/\r?\n/)) {
    const match = /^\s*[-*+]\s+\[([^\]])\]\s*(.*\S)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const text = stepTextKey(match[2]);
    const list = updates.get(text) ?? [];
    list.push(statusForMarker(match[1]));
    updates.set(text, list);
  }
  return assignStepStatuses(steps, updates);
}

/**
 * Steps run in order. Once a later step is started or finished, earlier open
 * steps are complete. A denied step stays denied. The running step itself is
 * left running.
 */
export function completeStepsBeforeFrontier(steps: readonly TodoStep[]): TodoStep[] {
  let frontier = -1;
  for (let index = 0; index < steps.length; index += 1) {
    const status = steps[index]?.status;
    if (status === 'inProgress' || status === 'completed') {
      frontier = index;
    }
  }
  if (frontier < 0) {
    return [...steps];
  }
  return steps.map((step, index) => {
    if (index < frontier && (step.status === 'pending' || step.status === 'inProgress')) {
      return { ...step, status: 'completed' };
    }
    return step;
  });
}

/**
 * Fold a native todo update onto an approved plan. Matching steps take the
 * reported status. A report that shares no step text did not update this plan.
 */
export function mergeReportedStepStatuses(
  existing: readonly TodoStep[],
  incoming: readonly TodoStep[]
): { steps: TodoStep[]; matched: boolean } {
  const known = new Set(existing.map((step) => stepTextKey(step.text)));
  const updates = new Map<string, TodoStepStatus[]>();
  let matched = false;
  for (const step of incoming) {
    const key = stepTextKey(step.text);
    if (!known.has(key)) {
      continue;
    }
    matched = true;
    const list = updates.get(key) ?? [];
    list.push(step.status);
    updates.set(key, list);
  }
  if (!matched) {
    return { steps: existing.map((step) => ({ ...step })), matched: false };
  }
  return { steps: assignStepStatuses(existing, updates), matched: true };
}

/**
 * Statuses to take from the plan file when an edit checked steps off in place.
 * The step texts have to be the same list. A file that rewrote the steps is
 * ignored so an unrelated edit cannot replace the approved todo list. Returns
 * `undefined` when nothing changed.
 */
export function adoptedPlanSteps(
  existing: readonly TodoStep[],
  fileSteps: readonly TodoStep[]
): TodoStep[] | undefined {
  if (existing.length === 0 || fileSteps.length !== existing.length) {
    return undefined;
  }
  if (!fileSteps.every((step, index) => stepTextKey(step.text) === stepTextKey(existing[index]?.text ?? ''))) {
    return undefined;
  }
  if (fileSteps.every((step, index) => step.status === existing[index]?.status)) {
    return undefined;
  }
  return fileSteps.map((step, index) => ({ text: existing[index]?.text ?? step.text, status: step.status }));
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

/**
 * Whether a built plan should start the next turn by itself.
 *
 * A plan that still has work left continues without a click. The one pause is
 * a loop: an automatic turn whose steps and tool activity match the turn
 * before it. That pause is the Resume control. A question or a refused
 * approval is also a pause, because the user already has to answer.
 */
export type PlanAutopilotDecision = 'continue' | 'hold';

export function planHasRemainingSteps(steps: readonly TodoStep[]): boolean {
  return steps.some((step) => step.status === 'pending' || step.status === 'inProgress');
}

/** Every step finished. An empty list is not a completed plan. */
export function planFullyComplete(steps: readonly TodoStep[]): boolean {
  return steps.length > 0 && steps.every((step) => step.status === 'completed');
}

/**
 * A finished plan's status row stays until the user sends another message.
 * Automatic continuations are still the plan itself, so they leave the row up.
 */
export function shouldDismissCompletedPlan(
  plan: { built?: boolean; steps: readonly TodoStep[]; completedDismissed?: boolean } | undefined,
  automatic: boolean
): boolean {
  if (automatic || !plan?.built || plan.completedDismissed === true) {
    return false;
  }
  return planFullyComplete(plan.steps);
}

/**
 * A dismissal applies only while the plan is still fully complete. New or
 * unfinished steps bring the progress row back.
 */
export function carriedPlanDismissal(
  steps: readonly TodoStep[],
  dismissed: boolean | undefined
): true | undefined {
  return planFullyComplete(steps) && dismissed === true ? true : undefined;
}

/** The built-plan dock. Hidden once a completed plan has been followed by another message. */
export function showBuiltPlanDock<T extends { built?: boolean; steps: readonly TodoStep[]; completedDismissed?: boolean }>(
  plan: T | undefined
): plan is T {
  if (!plan?.built) {
    return false;
  }
  return !(plan.completedDismissed === true && planFullyComplete(plan.steps));
}

/**
 * Assistant prose since the latest user message. Checkbox progress is read
 * from every message in the turn, so a line written before a tool call still
 * counts when a later message arrives.
 */
export function assistantProgressText(items: readonly TranscriptItem[]): string {
  let start = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === 'message' && item.role === 'user') {
      start = index + 1;
      break;
    }
  }
  const parts: string[] = [];
  for (const item of items.slice(start)) {
    if (item.kind === 'message' && item.role === 'assistant' && item.text) {
      parts.push(item.text);
    }
  }
  return parts.join('\n');
}

/** Tools and files from the latest turn, ignoring the prose around them. */
export function planTurnWork(items: readonly TranscriptItem[]): string[] {
  let start = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === 'message' && item.role === 'user') {
      start = index + 1;
      break;
    }
  }
  const work: string[] = [];
  for (const item of items.slice(start)) {
    if (item.kind === 'tool') {
      const name = item.tool ?? item.title ?? 'tool';
      const detail = item.command ?? item.detail ?? '';
      work.push(`tool:${name}:${detail}`);
    } else if (item.kind === 'file-change') {
      for (const file of item.files ?? []) {
        if (file.path) {
          work.push(`file:${file.path}:${file.additions ?? ''}:${file.deletions ?? ''}`);
        }
      }
    }
  }
  return work;
}

/**
 * Steps plus the work that actually happened. Two turns with the same
 * signature did not change the plan or the workspace.
 */
export function planWorkSignature(steps: readonly TodoStep[], work: readonly string[]): string {
  const statuses = steps.map((step) => `${step.status}:${step.text}`).join('\n');
  const evidence = [...new Set(work.map((item) => item.trim()).filter((item) => item.length > 0))].sort();
  return `${statuses}\n${evidence.join('\n')}`;
}

export function decidePlanAutopilot(input: {
  built: boolean;
  steps: readonly TodoStep[];
  /** True when this turn was started by autopilot rather than the user. */
  automatic: boolean;
  /** Signature of the previous turn, when one was stored. */
  previousSignature?: string;
  work: readonly string[];
  /** A question or a refused approval is waiting on the user. */
  blocked: boolean;
}): { decision: PlanAutopilotDecision; signature: string } {
  const signature = planWorkSignature(input.steps, input.work);
  const remaining = input.built && planHasRemainingSteps(input.steps);
  if (!remaining || input.blocked) {
    return { decision: 'hold', signature };
  }
  // A turn that did not touch the workspace, or that repeated the previous
  // result, does not get another automatic turn. A refusal otherwise shows up
  // twice: once for the user, then again for the continuation.
  if (input.work.length === 0 || input.previousSignature === signature) {
    return { decision: 'hold', signature };
  }
  return { decision: 'continue', signature };
}

/** The turn that keeps a built plan moving. Remaining steps are listed once. */
export function continuePlanInstruction(steps: readonly TodoStep[]): string {
  const remaining = steps.filter((step) => step.status === 'pending' || step.status === 'inProgress');
  const list = remaining.map((step) => `- [ ] ${step.text}`).join('\n');
  return [
    'Continue the remaining steps of this plan. Do not stop to ask whether to continue. Execute the remaining steps in order. As soon as you start a step, write a checkbox line on its own line that repeats the step text exactly: "- [~] ...". As soon as you finish it, write "- [x] ...". The plan document and the todo list update from those lines while you work. Leave the plan document prose unchanged.',
    '',
    list
  ].join('\n');
}
