import {
  THINKING_LEVELS,
  type CapabilityState,
  type ModelCapabilities,
  type ModelSettingField,
  type ResolvedModelSettings,
  type ThinkingLevel
} from '../backends/types.ts';
import type { ModelCapabilitySnapshot } from '../protocol.ts';
import { isKnown, supportsThinkingLevel } from '../backends/capabilities.ts';

/**
 * Pure view-model helpers for the inline per-model settings panel.
 *
 * Everything here is deterministic and free of React and of the host bridge, so
 * the panel's availability rules, formatting and warning thresholds are unit
 * testable. The panel is a *view*: the host owns resolution and clamping, and
 * this module only decides what can be shown and how it reads.
 *
 * ## Invariants
 *
 * - **Unknown is not unsupported.** A capability the provider did not report
 *   leaves its control unavailable with an explanation; it never renders a
 *   plausible-but-wrong value.
 * - **A bound is never fabricated.** The context control is capped at the model's
 *   reported maximum; a reported minimum is honoured as the floor, and when no
 *   minimum is reported the floor is only a presentation step, never a claim
 *   that smaller values are invalid.
 * - **The panel never computes what is sent.** Values shown are the resolved
 *   settings the host returned; a change is persisted by the host and echoed
 *   back, so the displayed value is always the one that will be sent.
 */

/** The smallest context floor a slider offers when the model reports no minimum. */
export const CONTEXT_FLOOR_STEP = 1024;

/** A model's context control, ready to render. */
export interface ContextControl {
  /** True when the model reported a maximum, so the control can be bounded. */
  available: boolean;
  /** The reported maximum; present whenever `available`. */
  ceiling?: number;
  /** The reported minimum, when the provider reported one. */
  reportedMin?: number;
  /** The lower bound the slider offers (reported minimum, or a step floor). */
  floor: number;
  /** The slider's granularity, chosen for a compact number of stops. */
  step: number;
  /** The provider's own default, when it reported one. */
  defaultValue?: number;
  /** The effective value the host resolved (override > provider default). */
  value?: number;
  /** True when this field is currently satisfied by a stored override. */
  overridden: boolean;
  /** Short reason the control is unavailable, when it is. */
  unavailableReason?: string;
}

/** A model's thinking control, ready to render. */
export interface ThinkingControl {
  available: boolean;
  /** The model's supported levels, in the fixed vocabulary's order. */
  offered: ThinkingLevel[];
  /** The level the host resolved as effective, when one applies. */
  value?: ThinkingLevel;
  /** The provider's reported default, when it reported a supported one. */
  defaultValue?: ThinkingLevel;
  overridden: boolean;
  /** One-line explanation shown instead of a dead control. */
  unavailableReason?: string;
}

export interface ModelSettingsView {
  providerId: string;
  modelId: string;
  context: ContextControl;
  thinking: ThinkingControl;
  /** True when at least one field is overridden, so the panel can mark itself. */
  isOverridden: boolean;
}

/** A positive, finite integer, or `undefined` when the value is not one. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/** Group a token count with thousands separators, e.g. `131,072`. */
export function formatExactTokens(tokens: number): string {
  return String(tokens).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * A readable context size: `128k`, `32k`, `512`. Values that are a whole number
 * of thousands of tokens read as `Nk`; anything else falls back to the exact
 * grouped count so a rounded label never claims a value the model does not have.
 */
export function formatContextTokens(tokens: number): string {
  if (tokens >= 1024 && tokens % 1024 === 0) {
    return `${tokens / 1024}k`;
  }
  if (tokens >= 1024) {
    return `${(tokens / 1024).toFixed(1)}k`;
  }
  return formatExactTokens(tokens);
}

/** A slider granularity that keeps a wide token range to a manageable number of stops. */
function contextStep(floor: number, ceiling: number): number {
  const span = Math.max(1, ceiling - floor);
  if (span >= 65536) {
    return 1024;
  }
  if (span >= 8192) {
    return 512;
  }
  if (span >= 2048) {
    return 256;
  }
  return 128;
}

/**
 * Build the context control from the model's descriptor and resolved settings.
 *
 * A maximum is the one bound the slider truly needs: without it there is nothing
 * to cap against, so the control is unavailable rather than offering an invented
 * ceiling. A reported minimum becomes the floor; when none is reported the floor
 * is a presentation step only, and the UI still never sends above the maximum.
 */
export function contextControl(
  capabilities: ModelCapabilities | undefined,
  settings: ResolvedModelSettings
): ContextControl {
  const overridden = settings.overridden.contextWindow;
  const max = capabilities ? positiveInt(capabilities.contextWindow.max) : undefined;
  const min = capabilities ? positiveInt(capabilities.contextWindow.min) : undefined;
  const providerDefault = capabilities ? positiveInt(capabilities.contextWindow.default) : undefined;

  if (max === undefined) {
    return {
      available: false,
      floor: CONTEXT_FLOOR_STEP,
      step: 128,
      overridden,
      unavailableReason: 'This model does not report a context window, so it cannot be capped here.'
    };
  }

  const floor = min !== undefined && min <= max ? min : Math.min(CONTEXT_FLOOR_STEP, max);
  const resolved = positiveInt(settings.contextWindow);
  const value =
    resolved !== undefined && resolved >= floor && resolved <= max
      ? resolved
      : providerDefault ?? max;

  return {
    available: true,
    ceiling: max,
    reportedMin: min,
    floor,
    step: contextStep(floor, max),
    defaultValue: providerDefault,
    value,
    overridden
  };
}

/**
 * Build the thinking control from the model's descriptor and resolved settings.
 *
 * Only levels the model actually supports are offered, in the fixed vocabulary's
 * order. A model known not to reason, or one whose reasoning support was never
 * reported, shows an explanation instead of a dead selector.
 */
export function thinkingControl(
  capabilities: ModelCapabilities | undefined,
  settings: ResolvedModelSettings
): ThinkingControl {
  const overridden = settings.overridden.thinking;
  const supported: CapabilityState<ThinkingLevel[]> = capabilities
    ? capabilities.thinking.supported
    : 'unknown';

  if (!isKnown(supported)) {
    return {
      available: false,
      offered: [],
      overridden,
      unavailableReason: 'This model does not report thinking support, so no level is offered.'
    };
  }

  if (supported.length === 0) {
    return {
      available: false,
      offered: [],
      overridden,
      unavailableReason: 'This model is not a reasoning model, so there is no thinking level to set.'
    };
  }

  const offered = THINKING_LEVELS.filter((level) => supportsThinkingLevel(level, supported));
  if (offered.length === 0) {
    return {
      available: false,
      offered: [],
      overridden,
      unavailableReason: 'This model does not report thinking support, so no level is offered.'
    };
  }

  const providerDefault = capabilities ? capabilities.thinking.default : 'unknown';
  const defaultValue =
    isKnown(providerDefault) && offered.includes(providerDefault) ? providerDefault : undefined;
  const resolved = settings.thinking;
  // When no reported value applies, mirror the host's fallback: the lowest
  // active effort, never a silent switch to off.
  const fallback = offered.find((level) => level !== 'off') ?? offered[0];
  const value = isKnown(resolved) && offered.includes(resolved) ? resolved : defaultValue ?? fallback;

  return {
    available: true,
    offered,
    value,
    defaultValue,
    overridden
  };
}

/** Assemble the whole panel view from one capability snapshot. */
export function modelSettingsView(snapshot: ModelCapabilitySnapshot): ModelSettingsView {
  return {
    providerId: snapshot.providerId,
    modelId: snapshot.modelId,
    context: contextControl(snapshot.capabilities, snapshot.settings),
    thinking: thinkingControl(snapshot.capabilities, snapshot.settings),
    isOverridden: snapshot.settings.isOverridden
  };
}

/**
 * A conservative token estimate for the visible conversation, used only to warn
 * before a context cap drops earlier turns.
 *
 * The host tracks no token accounting today, so this is a clearly labelled
 * heuristic (roughly four characters per token) rather than a claim: it is
 * enough to tell a user their cap is below what they have already sent. It reads
 * the transcript, and never writes to it.
 */
export function estimateConversationTokens(items: readonly { text: string }[]): number {
  let chars = 0;
  for (const item of items) {
    chars += item.text.length;
  }
  return Math.ceil(chars / 4);
}

/**
 * Whether the chosen cap sits below the visible conversation, so the panel can
 * warn that earlier turns will be dropped from the next request.
 */
export function dropsEarlierTurns(contextValue: number | undefined, conversationTokens: number): boolean {
  return contextValue !== undefined && conversationTokens > 0 && contextValue < conversationTokens;
}

/** One reset target's label, so the panel and the intent agree on the field. */
export const MODEL_SETTING_LABELS: Record<ModelSettingField, string> = {
  contextWindow: 'Max context size',
  thinking: 'Thinking level'
};
