import type { DefaultMode } from './types.ts';

/**
 * Infer a mode only when the wording makes the user's intent unusually clear.
 * Ambiguous requests keep the mode the user selected. This is deliberately
 * provider-neutral and runs before any backend sees the turn.
 */
export function inferRequestedMode(text: string): DefaultMode | undefined {
  const normalized = text.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;

  const action = '(?:fix|change|edit|implement|build|create|write|add|remove|update|refactor|run|execute|install|delete)';
  if (/\b(make|write|create|draft|propose)\s+(me\s+)?(a\s+)?plan\b|\bplan\s+(this|the work|the changes|how to)\b/.test(normalized)) {
    return 'plan';
  }
  if (new RegExp(`^(?:please\\s+)?${action}\\b|\\b(?:can you|could you|please)\\s+${action}\\b`).test(normalized)) {
    return 'agent';
  }
  if (/^(what|why|who|when|where|which|explain|describe|tell me|summari[sz]e|how does|how do|can you explain)\b/.test(normalized)) {
    return 'ask';
  }
  return undefined;
}

/** Agent can modify; the other modes only narrow what a turn can do. */
export function modeIsMoreRestrictive(from: DefaultMode, to: DefaultMode): boolean {
  const rank: Record<DefaultMode, number> = { ask: 0, plan: 1, agent: 2 };
  return rank[to] < rank[from];
}
