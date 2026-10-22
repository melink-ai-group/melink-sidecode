import type { TodoStepStatus } from './backends/types';
import { stepStatusHtml } from './planStepIcon.ts';

/**
 * A markdown-it token, only the fields this rewrite touches. The preview's
 * own task-list plugin may already have turned `[ ]` / `[x]` into a checkbox
 * input; `[~]` and `[-]` stay as text. Both shapes become a status icon.
 */
export interface StepToken {
  type: string;
  content: string;
  children: StepToken[] | null;
  attrs: [string, string][] | null;
}

const LEADING_MARKER = /^\[([ xX~-])\]\s*/;
const EXTENDED_MARKER = /^\[(~|-)\]/;
const CHECKBOX = /<input\b[^>]*\btype\s*=\s*["']?checkbox\b/i;

/** True when a workspace path is a sideCode plan document. */
export function isPlanMarkdownPath(filePath: string | undefined): boolean {
  if (!filePath) {
    return false;
  }
  return filePath.replace(/\\/g, '/').includes('/.melink/plans/');
}

/**
 * A plan file opens in Markdown Preview the first time it is shown. A later
 * focus of the same open document stays where the user left it.
 */
export function shouldAutoShowPlanPreview(filePath: string | undefined, alreadyShown: boolean): boolean {
  return isPlanMarkdownPath(filePath) && !alreadyShown;
}

/** Pull a path out of the env object VS Code passes to markdown-it. */
export function planPathFromEnv(env: unknown): string | undefined {
  if (!env || typeof env !== 'object') {
    return undefined;
  }
  const file = (env as { containingFile?: unknown }).containingFile;
  if (typeof file === 'string') {
    return file;
  }
  if (file && typeof file === 'object') {
    const uri = file as { fsPath?: unknown; path?: unknown };
    if (typeof uri.fsPath === 'string') {
      return uri.fsPath;
    }
    if (typeof uri.path === 'string') {
      return uri.path;
    }
  }
  return undefined;
}

/**
 * Replace plan checkbox markers in a markdown-it token stream with status
 * icons. Standard `[ ]` / `[x]` checkboxes in other documents are left as the
 * preview rendered them. A plan file, or any document that uses `[~]` / `[-]`,
 * gets icons for every step marker.
 */
export function applyPlanStepIcons(tokens: StepToken[], planFile: boolean): void {
  const convertStandard = planFile || hasExtendedStepMarker(tokens);
  if (!convertStandard) {
    return;
  }
  let listItem: StepToken | undefined;
  for (const token of tokens) {
    if (token.type === 'list_item_open') {
      listItem = token;
      continue;
    }
    if (token.type === 'list_item_close') {
      listItem = undefined;
      continue;
    }
    if (token.type === 'inline' && token.children && decorateInline(token.children)) {
      if (listItem) {
        addClass(listItem, 'melink-step-item');
      }
    }
  }
}

/** markdown-it plugin. Installed from `extendMarkdownIt` so the built-in preview uses it. */
export function planStepMarkdownPlugin(md: {
  core: { ruler: { push: (name: string, fn: (state: { tokens: StepToken[]; env?: unknown }) => void) => void } };
  use?: (plugin: (md: unknown) => void) => unknown;
}): void {
  md.core.ruler.push('melink_plan_steps', (state) => {
    applyPlanStepIcons(state.tokens, isPlanMarkdownPath(planPathFromEnv(state.env)));
  });
}

function hasExtendedStepMarker(tokens: StepToken[]): boolean {
  for (const token of tokens) {
    if (token.type !== 'inline' || !token.children) {
      continue;
    }
    for (const child of token.children) {
      if (child.type === 'text' && EXTENDED_MARKER.test(child.content.trimStart())) {
        return true;
      }
    }
  }
  return false;
}

function decorateInline(children: StepToken[]): boolean {
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child.type === 'text' && child.content.trim() === '') {
      continue;
    }
    if (child.type === 'softbreak') {
      continue;
    }
    if (child.type === 'html_inline' && CHECKBOX.test(child.content)) {
      const status: TodoStepStatus = /checked/i.test(child.content) ? 'completed' : 'pending';
      child.content = stepStatusHtml(status);
      return true;
    }
    if (child.type === 'text') {
      const parsed = parseLeadingStepMarker(child.content);
      if (!parsed) {
        return false;
      }
      children.splice(index, 0, {
        type: 'html_inline',
        content: stepStatusHtml(parsed.status),
        children: null,
        attrs: null
      });
      child.content = parsed.text;
      return true;
    }
    return false;
  }
  return false;
}

function parseLeadingStepMarker(text: string): { status: TodoStepStatus; text: string } | undefined {
  const match = LEADING_MARKER.exec(text);
  if (!match) {
    return undefined;
  }
  return { status: statusForMarker(match[1]), text: text.slice(match[0].length) };
}

function statusForMarker(marker: string): TodoStepStatus {
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

function addClass(token: StepToken, className: string): void {
  const attrs = token.attrs ?? [];
  const existing = attrs.find((pair) => pair[0] === 'class');
  if (existing) {
    const names = existing[1].split(/\s+/);
    if (!names.includes(className)) {
      existing[1] = `${existing[1]} ${className}`;
    }
  } else {
    attrs.push(['class', className]);
  }
  token.attrs = attrs;
}
