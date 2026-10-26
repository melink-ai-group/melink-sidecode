/** Optional read-only work requested by the main agent, independent of review policy. */
export interface SubagentRequest {
  task: string;
  reason: string;
}

export interface SubagentRequests {
  requests: SubagentRequest[];
  error?: string;
}

export const MAX_SUBAGENT_TASKS = 3;
export const MAX_SUBAGENT_PAYLOAD_CHARS = 10_000;
export const MAX_SUBAGENT_TASK_CHARS = 2_000;
export const MAX_SUBAGENT_REASON_CHARS = 300;

/** Only Agent mode receives this capability; workers never delegate recursively. */
export const DELEGATION_INSTRUCTIONS =
  'Optional subagents: when independent investigation or parallel analysis would materially help, you may request one or more read-only subagents. Keep ownership of decisions and edits. Give each worker a bounded task and a short reason, with at most three workers per request. End your turn with one fenced sidecode-subagents block containing JSON of the form {"tasks":[{"task":"Inspect the affected callers and report concrete risks","reason":"Independent review of the changed interface"}]}, then stop and wait. Do not declare the task complete before receiving their results. The host shows each worker\u2019s activity and returns findings to you in a continuation; use the evidence to continue the user\u2019s task. Workers cannot edit files, answer user decisions, or spawn other workers. Do not delegate from a subagent, do not request recursive delegation, and do not emit a delegation block together with a sidecode-question block.';

const OPEN_FENCE = /^[ \t]*```sidecode-subagents[ \t]*\r?\n/gm;
const CLOSED_FENCE = /^[ \t]*```sidecode-subagents[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*(?:\r?\n|$)/gm;

/** Parse only a completed, final fence. Invalid requests never partially launch. */
export function parseSubagentRequests(text: string): SubagentRequests {
  const openings = [...text.matchAll(OPEN_FENCE)];
  if (openings.length === 0) {
    return { requests: [] };
  }
  const invalid = (message: string): SubagentRequests => ({ requests: [], error: message });
  if (openings.length !== 1) {
    return invalid('Use one subagent request block per turn.');
  }
  const closed = [...text.matchAll(CLOSED_FENCE)];
  const match = closed[0];
  if (closed.length !== 1 || !match || text.slice(match.index! + match[0].length).trim()) {
    return invalid('The subagent request must be a completed block at the end of the reply.');
  }
  if (/```sidecode-question\b/.test(text)) {
    return invalid('Resolve the user question before requesting subagents.');
  }
  if (match[1].length > MAX_SUBAGENT_PAYLOAD_CHARS) {
    return invalid('The subagent request is too large.');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    return invalid('The subagent request is not valid JSON.');
  }
  if (!isObject(payload) || !Array.isArray(payload.tasks) || payload.tasks.length === 0 || payload.tasks.length > MAX_SUBAGENT_TASKS) {
    return invalid('Request between one and three subagent tasks.');
  }
  const requests: SubagentRequest[] = [];
  for (const value of payload.tasks) {
    if (!isObject(value) || typeof value.task !== 'string' || typeof value.reason !== 'string') {
      return invalid('Each subagent task needs task and reason text.');
    }
    const task = value.task.trim();
    const reason = value.reason.trim();
    if (!task || !reason || task.length > MAX_SUBAGENT_TASK_CHARS || reason.length > MAX_SUBAGENT_REASON_CHARS) {
      return invalid('Subagent tasks and reasons must be nonempty and bounded.');
    }
    if (/sidecode-subagents/i.test(task) || /sidecode-subagents/i.test(reason)) {
      return invalid('Subagents cannot request nested delegation.');
    }
    requests.push({ task, reason });
  }
  return { requests };
}

/** Hide machine payloads while streaming as well as after the closing fence. */
export function hideSubagentFence(text: string): string {
  return text
    .replace(CLOSED_FENCE, '')
    .replace(/^[ \t]*```sidecode-subagents\b[^\r\n]*(?:\r?\n[\s\S]*)?$/m, '')
    .trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
