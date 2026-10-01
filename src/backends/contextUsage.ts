/**
 * Context-window fill, shared by the adapters and the composer ring.
 *
 * The percentage is used tokens over the effective max context setting (the
 * value the host resolved for the model). A provider-reported window is only
 * a fallback when that setting was never reported. Nothing here invents a
 * maximum.
 */

/** Compaction is offered only once the window is above this percent. */
export const COMPACT_MIN_PERCENT = 25;

/** A non-negative finite token count, or `undefined` when the value is not one. */
export function finiteTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

/**
 * Whole-number percent of `maxTokens` occupied by `usedTokens`, capped at 100.
 * `undefined` when there is no real maximum to divide by.
 */
export function contextUsagePercent(usedTokens: number, maxTokens: number | undefined): number | undefined {
  const max = finiteTokenCount(maxTokens);
  const used = finiteTokenCount(usedTokens);
  if (max === undefined || max <= 0 || used === undefined) {
    return undefined;
  }
  return Math.min(100, Math.round((used / max) * 100));
}

/**
 * The ring is a compact control only while the agent is idle and the displayed
 * percent is above {@link COMPACT_MIN_PERCENT}. The displayed percent is what
 * the user sees, so the click and the number agree.
 */
export function canCompactContext(percent: number | undefined, busy: boolean): boolean {
  return !busy && percent !== undefined && percent > COMPACT_MIN_PERCENT;
}

export interface ContextMaxInput {
  /** Effective max the host resolved (override, otherwise the provider default). */
  settingsWindow?: number | 'unknown';
  /** The model's reported ceiling, when the provider named one. */
  capabilityMax?: number | 'unknown';
  /** The model's reported default, when the provider named one. */
  capabilityDefault?: number | 'unknown';
  /** A window the live provider reported for this thread, when it named one. */
  reportedWindow?: number;
}

function knownWindow(value: number | 'unknown' | undefined): number | undefined {
  return typeof value === 'number' ? finiteTokenCount(value) : undefined;
}

/**
 * The denominator for the ring.
 *
 * The resolved max-context setting wins: that is the window the next turn is
 * sent with. A reported model ceiling, then its default, then a live
 * provider window, are fallbacks when the setting itself is unknown.
 */
export function resolveContextMax(input: ContextMaxInput): number | undefined {
  const settings = knownWindow(input.settingsWindow);
  if (settings !== undefined && settings > 0) {
    return settings;
  }
  const ceiling = knownWindow(input.capabilityMax);
  if (ceiling !== undefined && ceiling > 0) {
    return ceiling;
  }
  const fallback = knownWindow(input.capabilityDefault);
  if (fallback !== undefined && fallback > 0) {
    return fallback;
  }
  const reported = finiteTokenCount(input.reportedWindow);
  return reported !== undefined && reported > 0 ? reported : undefined;
}

/**
 * Tokens occupying the window after the latest Codex sampling call.
 *
 * `last.totalTokens` is that call's input plus output. The thread-lifetime
 * `total` is cumulative across calls and is not the fill of the window.
 */
export function codexContextUsed(usage: { last?: { totalTokens?: number } } | undefined): number | undefined {
  return finiteTokenCount(usage?.last?.totalTokens);
}

/**
 * Tokens occupying an Ollama context: the prompt that was evaluated plus the
 * tokens generated so far. Either count may arrive alone while a stream is
 * still running.
 */
export function ollamaContextUsed(promptEvalCount?: number, evalCount?: number): number | undefined {
  const prompt = finiteTokenCount(promptEvalCount);
  const generated = finiteTokenCount(evalCount);
  if (prompt === undefined && generated === undefined) {
    return undefined;
  }
  const used = (prompt ?? 0) + (generated ?? 0);
  return used > 0 ? used : undefined;
}

/** Rough token count for text that has not been counted by a provider yet. */
export function tokensFromText(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}
