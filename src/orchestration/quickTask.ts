/**
 * Deterministic quick-task detector. Quick only marks the post-turn passes as
 * unnecessary; it never changes the reply, tools, permissions, or selected mode.
 *
 * Detection always runs. The `quickTask` orchestration choice controls only
 * whether the Quick role/notice is surfaced; it can never disable the bypass.
 */

export const QUICK_TASK_MAX_CHARS = 120;
export const QUICK_TASK_MAX_WORDS = 20;

export type QuickTaskReason =
  | 'user-requested'
  | 'quick'
  | 'mode-not-agent'
  | 'origin-not-user'
  | 'attachments'
  | 'active-plan'
  | 'too-long'
  | 'too-many-words'
  | 'multiline'
  | 'list'
  | 'multi-step'
  | 'action-verb'
  | 'not-question';

export interface QuickTaskInput {
  text: string;
  mode: string;
  origin: string;
  hasAttachments: boolean;
  hasActivePlan: boolean;
}

export interface QuickTaskDecision {
  quick: boolean;
  reason: QuickTaskReason;
}

const LIST_MARKER = /^(?:\d+[.)]|[-*])\s+/;
const MULTI_STEP =
  /\b(?:and then|then also|after that|finally|step \d+)\b|(?:^|\s)(?:first|second),/i;
const ACTION_VERB =
  /\b(?:add|create|implement|build|write|edit|change|modify|update|refactor|fix|remove|delete|rename|move|replace|install|upgrade|uninstall|generate|scaffold|migrate|patch|revert|merge|commit|push|run|execute|apply|configure|wire|integrate|test)\b/i;
const QUESTION_OPENING =
  /^(?:what|why|how|who|when|where|which|is|are|does|do|can|could|should|would|explain|describe|summarise|summarize|show|list|tell)\b/i;

export function detectQuickTask(input: QuickTaskInput): QuickTaskDecision {
  if (input.mode !== 'agent') {
    return veto('mode-not-agent');
  }
  if (input.origin !== 'user') {
    return veto('origin-not-user');
  }
  if (input.hasAttachments) {
    return veto('attachments');
  }
  if (input.hasActivePlan) {
    return veto('active-plan');
  }

  const trimmed = input.text.trim();
  if (trimmed.length > QUICK_TASK_MAX_CHARS) {
    return veto('too-long');
  }
  const words = trimmed ? trimmed.split(/\s+/) : [];
  if (words.length > QUICK_TASK_MAX_WORDS) {
    return veto('too-many-words');
  }
  if (trimmed.includes('\n') || trimmed.includes('\r')) {
    return veto('multiline');
  }
  if (LIST_MARKER.test(trimmed)) {
    return veto('list');
  }
  if (MULTI_STEP.test(trimmed)) {
    return veto('multi-step');
  }
  if (ACTION_VERB.test(trimmed)) {
    return veto('action-verb');
  }
  if (!QUESTION_OPENING.test(trimmed) && !trimmed.endsWith('?')) {
    return veto('not-question');
  }
  return { quick: true, reason: 'quick' };
}

function veto(reason: Exclude<QuickTaskReason, 'quick'>): QuickTaskDecision {
  return { quick: false, reason };
}
