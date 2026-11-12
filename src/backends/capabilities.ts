import {
  THINKING_LEVELS,
  type CapabilityState,
  type ContextWindowCapability,
  type DefaultMode,
  type ModelCapabilities,
  type ModelSettingOverrides,
  type ResolvedModelSettings,
  type ThinkingLevel
} from './types.ts';

/**
 * The one provider-agnostic, pure home for model capability data.
 *
 * Everything here is deterministic and side-effect free, so it is unit-testable
 * without a provider, a `vscode` host, or a network call. Adapters supply raw
 * native metadata; this module normalizes it into the shared descriptor and
 * maps the fixed UI vocabulary onto each provider's own values.
 *
 * ## Invariants
 *
 * - **Unknown is not unsupported.** A missing field normalizes to `'unknown'`,
 *   never a plausible default. A reported-but-empty value (for example an empty
 *   thinking list) stays a concrete empty value.
 * - **A maximum is never fabricated.** `contextWindow.max` is `'unknown'` unless
 *   the provider actually reported a bound.
 * - **Clamping is on read.** A persisted value outside the model's range is
 *   clamped before it is ever sent, so a model change or a provider-side update
 *   cannot leave a stale out-of-range value in flight.
 */

/** The app-level defaults a resolved setting falls back to, in the UI vocabulary. */
export interface AppDefaults {
  thinking?: ThinkingLevel;
}

/** A model's capability data as `'unknown'` everywhere, for a backend that cannot report. */
export const UNKNOWN_CAPABILITIES: ModelCapabilities = {
  contextWindow: { min: 'unknown', max: 'unknown', default: 'unknown' },
  thinking: { supported: 'unknown', default: 'unknown' },
  tools: 'unknown',
  modes: 'unknown'
};

/**
 * Whether a capability value is actually known. The single predicate every
 * consumer uses so `'unknown'` is never accidentally treated as a real value.
 */
export function isKnown<T>(value: CapabilityState<T>): value is T {
  return value !== 'unknown';
}

/**
 * Normalize a raw context-window range into the descriptor.
 *
 * A non-finite or non-positive bound is dropped to `'unknown'`: a bad number is
 * not a real bound, and reporting it would let the UI offer a value the model
 * cannot accept. The default is only kept when it falls inside a known range.
 */
export function normalizeContextWindow(raw: {
  min?: unknown;
  max?: unknown;
  default?: unknown;
}): ContextWindowCapability {
  const min = toPositiveInt(raw.min);
  const max = toPositiveInt(raw.max);
  const candidate = toPositiveInt(raw.default);

  // Only report a default when it is consistent with whatever bounds are known;
  // a default above the maximum would otherwise be clamped to a value the
  // provider never reported as its own.
  let defaultValue: CapabilityState<number> = 'unknown';
  if (candidate !== undefined) {
    const withinMin = min === undefined || candidate >= min;
    const withinMax = max === undefined || candidate <= max;
    if (withinMin && withinMax) {
      defaultValue = candidate;
    }
  }

  return {
    min: min ?? 'unknown',
    max: max ?? 'unknown',
    default: defaultValue
  };
}

/** A positive, finite integer, or `undefined` when the value is not one. */
function toPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

/**
 * Clamp a requested context window to the model's reported range.
 *
 * Returns `undefined` only when the request is not a usable number, or when the
 * model reported no bound at all — in which case any clamp would require
 * fabricating a range, so the setting is dropped. When only a `min` is known the
 * value is clamped upward only, and when only a `max` is known (the usual case)
 * it is clamped downward only; a maximum is never invented.
 */
export function clampContextWindow(
  requested: unknown,
  contextWindow: ContextWindowCapability
): number | undefined {
  const value = toPositiveInt(requested);
  if (value === undefined) {
    return undefined;
  }
  const min = isKnown(contextWindow.min) ? contextWindow.min : undefined;
  const max = isKnown(contextWindow.max) ? contextWindow.max : undefined;
  if (min === undefined && max === undefined) {
    // Nothing reported to clamp against: sending the raw value would be guessing.
    return undefined;
  }
  if (max === undefined) {
    return Math.max(value, min as number);
  }
  if (min === undefined) {
    return Math.min(value, max);
  }
  return Math.min(Math.max(value, min), max);
}

/**
 * Whether a value is one of the fixed UI thinking levels. Used so persisted
 * values that predate a vocabulary change are rejected rather than sent.
 */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Order index of a thinking level, or `-1` when the value is not a known level.
 * The index drives the comparison used to clamp a value to a supported set.
 */
export function thinkingLevelRank(value: unknown): number {
  return isThinkingLevel(value) ? THINKING_LEVELS.indexOf(value) : -1;
}

/**
 * Clamp a thinking level to the ones a model supports, preserving the closest
 * supported level at or below the request where possible (so an unsupported
 * `extra high` degrades to the highest level the model does support, rather
 * than being silently dropped).
 *
 * Returns `undefined` when nothing supported can be chosen, so the caller omits
 * the setting rather than sending an unsupported value.
 */
export function clampThinkingLevel(
  requested: unknown,
  supported: CapabilityState<readonly ThinkingLevel[]>
): ThinkingLevel | undefined {
  if (!isThinkingLevel(requested)) {
    return undefined;
  }
  if (!isKnown(supported) || supported.length === 0) {
    return undefined;
  }
  if (supported.includes(requested)) {
    return requested;
  }
  const requestRank = thinkingLevelRank(requested);
  // Prefer the nearest supported level at or below the request; if the request
  // is below everything supported, fall back to the lowest supported level.
  let best: ThinkingLevel | undefined;
  for (const level of supported) {
    if (thinkingLevelRank(level) <= requestRank) {
      if (best === undefined || thinkingLevelRank(level) > thinkingLevelRank(best)) {
        best = level;
      }
    }
  }
  return best ?? supported[0];
}

/**
 * Whether a thinking level is meaningful for a model: the model lists it.
 * There is no implicit level: a provider that offers a boolean toggle reports
 * `on`/`off` explicitly, and a provider that omits `off` cannot be switched off.
 */
export function supportsThinkingLevel(
  level: ThinkingLevel,
  supported: CapabilityState<readonly ThinkingLevel[]>
): boolean {
  if (!isKnown(supported)) {
    return false;
  }
  return supported.includes(level);
}

/** Resolve the effective thinking level: override > provider default > app default. */
function resolveThinking(
  override: ModelSettingOverrides,
  capabilities: ModelCapabilities,
  appDefault: ThinkingLevel | undefined
): { value: CapabilityState<ThinkingLevel>; overridden: boolean } {
  const { supported } = capabilities.thinking;
  if (!isKnown(supported)) {
    // Reasoning support was not reported: nothing may be shown or sent.
    return { value: 'unknown', overridden: false };
  }
  if (supported.length === 0) {
    // Reported as not reasoning: no level applies, so nothing may be shown or
    // sent. `off` is not implied because the model never advertised a control.
    return { value: 'unknown', overridden: false };
  }
  if (isThinkingLevel(override.thinking)) {
    // A stored override is honored, but clamped to the model's supported levels:
    // an unsupported `extra high` degrades to the nearest supported level rather
    // than being sent raw or silently discarded.
    const clamped = clampThinkingLevel(override.thinking, supported);
    if (clamped !== undefined) {
      return { value: clamped, overridden: true };
    }
  }
  const providerDefault = capabilities.thinking.default;
  if (isKnown(providerDefault) && supportsThinkingLevel(providerDefault, supported)) {
    return { value: providerDefault, overridden: false };
  }
  if (isThinkingLevel(appDefault) && supportsThinkingLevel(appDefault, supported)) {
    return { value: appDefault, overridden: false };
  }
  // A reasoning model with no reported default: the lowest active effort, so a
  // missing provider default never silently turns reasoning off.
  const firstActive = supported.find((level) => level !== 'off') ?? supported[0];
  return { value: firstActive, overridden: false };
}

/**
 * Resolve the effective context window: override > provider default > unknown.
 *
 * The maximum is never used as a fallback default: a model's full window is a
 * bound, not the provider's own choice, so treating it as the default would
 * silently override the provider with a number it never reported. When nothing
 * is reported, the value stays `unknown` and the caller omits it.
 */
function resolveContextWindow(
  override: ModelSettingOverrides,
  capabilities: ModelCapabilities
): { value: CapabilityState<number>; overridden: boolean } {
  const { contextWindow } = capabilities;
  const clampedOverride = clampContextWindow(override.contextWindow, contextWindow);
  if (clampedOverride !== undefined) {
    return { value: clampedOverride, overridden: true };
  }
  if (isKnown(contextWindow.default)) {
    return { value: contextWindow.default, overridden: false };
  }
  return { value: 'unknown', overridden: false };
}

/**
 * Resolve the effective per-model settings the UI should show.
 *
 * Precedence is override > provider default > app default. A persisted override
 * is clamped to the model's reported range here, on read, so an out-of-range
 * value left over from a previous model is never surfaced or sent.
 */
export function resolveModelSettings(input: {
  providerId: string;
  modelId: string;
  capabilities?: ModelCapabilities;
  overrides?: ModelSettingOverrides;
  appDefaults?: AppDefaults;
}): ResolvedModelSettings {
  const { providerId, modelId } = input;
  const capabilities = input.capabilities ?? UNKNOWN_CAPABILITIES;
  const overrides = input.overrides ?? {};
  const appDefaults = input.appDefaults ?? {};

  const thinking = resolveThinking(overrides, capabilities, appDefaults.thinking);
  const contextWindow = resolveContextWindow(overrides, capabilities);

  return {
    providerId,
    modelId,
    contextWindow: contextWindow.value,
    thinking: thinking.value,
    isOverridden: thinking.overridden || contextWindow.overridden,
    overridden: {
      thinking: thinking.overridden,
      contextWindow: contextWindow.overridden
    }
  };
}

/**
 * Drop a persisted override down to what the model can actually accept. Applied
 * on read so a stale value (kept from a model with a wider range) is never sent
 * to the provider. Fields that are not sendable are removed entirely rather
 * than left in place.
 */
export function sanitizeOverrides(
  overrides: ModelSettingOverrides,
  capabilities?: ModelCapabilities
): ModelSettingOverrides {
  const caps = capabilities ?? UNKNOWN_CAPABILITIES;
  const clean: ModelSettingOverrides = {};

  const contextWindow = clampContextWindow(overrides.contextWindow, caps.contextWindow);
  if (contextWindow !== undefined) {
    clean.contextWindow = contextWindow;
  }

  if (isKnown(caps.thinking.supported) && supportsThinkingLevel(overrides.thinking as ThinkingLevel, caps.thinking.supported)) {
    clean.thinking = overrides.thinking;
  }

  return clean;
}

/*
 * ---------------------------------------------------------------------------
 * Native vocabulary mapping
 * ---------------------------------------------------------------------------
 *
 * The UI ladder names every tier the supported providers report. Each adapter
 * needs its own provider's spelling, so the mapping lives here as pure
 * functions rather than in the UI or inline in an adapter. `extra high` is
 * OpenAI's `xhigh`; `max` and `ultra` are higher tiers some Codex models report;
 * `minimal` is OpenAI's lowest effort; `on` is a provider's boolean toggle.
 */

/**
 * Reduce resolved settings to the fields the adapter should actually send.
 *
 * A resolved value of `'unknown'` is dropped: it means the provider reported
 * nothing, so the adapter must leave that native field alone rather than send a
 * value that was never reported. Clamping already happened at resolve time, so
 * a value that survives here is known to be inside the model's range.
 */
export function overridesFromResolved(resolved: ResolvedModelSettings): ModelSettingOverrides {
  const overrides: ModelSettingOverrides = {};
  if (isKnown(resolved.contextWindow)) {
    overrides.contextWindow = resolved.contextWindow;
  }
  if (isKnown(resolved.thinking)) {
    overrides.thinking = resolved.thinking;
  }
  return overrides;
}

/**
 * The UI level for a native reasoning tier, shared by every provider that spells
 * efforts in OpenAI's vocabulary. `true`/`false` are a provider's boolean
 * toggle. An unknown spelling returns `undefined` so a provider update is hidden
 * rather than guessed.
 */
export function thinkingLevelFromEffort(value: unknown): ThinkingLevel | undefined {
  switch (value) {
    case false:
    case 'off':
    case 'none':
      return 'off';
    case true:
    case 'on':
      return 'on';
    case 'minimal':
      return 'minimal';
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
    case 'extra_high':
    case 'extraHigh':
      return 'extra high';
    case 'max':
      return 'max';
    case 'ultra':
      return 'ultra';
    default:
      return isThinkingLevel(value) ? value : undefined;
  }
}

/** The value Ollama's `think` field accepts for a UI level. */
export function ollamaThinkValue(level: ThinkingLevel): false | true | string {
  switch (level) {
    case 'off':
      return false;
    case 'on':
      return true;
    // Ollama's own levels end at `max`; the two higher Codex tiers alias onto it
    // so a value from a previous model still degrades to a valid Ollama tier.
    case 'extra high':
    case 'max':
    case 'ultra':
      return 'max';
    default:
      return level;
  }
}

/**
 * The native `/api/chat` fields for resolved per-model settings. Only fields the
 * host actually resolved are emitted, so an unset setting leaves Ollama's own
 * default intact.
 */
export function ollamaNativeRequest(settings?: ModelSettingOverrides): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!settings) {
    return result;
  }
  if (settings.thinking !== undefined) {
    result.think = ollamaThinkValue(settings.thinking);
  }
  if (settings.contextWindow !== undefined) {
    result.options = { num_ctx: settings.contextWindow };
  }
  return result;
}

/**
 * The UI level for an Ollama native `think` value, or `undefined` when it is not
 * one. `false` is Ollama's "do not reason" spelling and `true` its toggle-on.
 */
export function thinkingLevelFromOllama(value: unknown): ThinkingLevel | undefined {
  return thinkingLevelFromEffort(value);
}

/**
 * The Codex reasoning tier the UI's `extra high` maps onto. Named once so the
 * `xhigh` alias is a single edit rather than a scattered literal.
 */
export const TOP_CODEX_REASONING_TIER = 'xhigh';

/**
 * The Codex reasoning tier for a UI level.
 *
 * Codex's generated `ReasoningEffort` is an open string using its own tiers.
 * `off` maps to `none` because it is only offered when the model's own
 * `supportedReasoningEfforts` lists `none`; a model that does not list it never
 * renders the control. `extra high` maps to `xhigh`, and the newer `max`/`ultra`
 * tiers pass through unchanged.
 */
export function codexReasoningEffort(level: ThinkingLevel): string | undefined {
  switch (level) {
    case 'off':
      return 'none';
    case 'on':
      // A boolean toggle has no effort spelling; omitting the tier leaves the
      // model's own default in place.
      return undefined;
    case 'minimal':
      return 'minimal';
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'extra high':
      return TOP_CODEX_REASONING_TIER;
    case 'max':
      return 'max';
    case 'ultra':
      return 'ultra';
    default:
      return undefined;
  }
}

/** The UI level for a Codex native tier, or `undefined` when it is not one. */
export function thinkingLevelFromCodex(value: unknown): ThinkingLevel | undefined {
  return thinkingLevelFromEffort(value);
}

/**
 * The native Codex turn fields for resolved per-model settings.
 *
 * `effort` is omitted only when no tier applies (`on`, an unresolved setting).
 * `off` sends `none`, which the host only resolves when the model advertised it.
 */
export function codexNativeRequest(settings?: ModelSettingOverrides): { effort?: string; summary: 'auto' } {
  const effort = settings?.thinking === undefined ? undefined : codexReasoningEffort(settings.thinking);
  // Reasoning summaries are a separate opt-in from reasoning effort. Without
  // `summary`, Codex may stream an empty reasoning item even when the model is
  // reasoning normally. `auto` requests the readable summary, never raw tokens.
  return { ...(effort === undefined ? {} : { effort }), summary: 'auto' };
}

/*
 * ---------------------------------------------------------------------------
 * Provider capability parsing
 * ---------------------------------------------------------------------------
 *
 * Adapters read their provider's response and hand the raw shape here. Parsing
 * is separated from the network so it is unit-testable, and so a provider that
 * adds or changes a field is reflected without a code change beyond this file.
 */

/**
 * Pull the model's context length out of an Ollama `/api/show` `model_info`.
 *
 * Ollama namespaces it per architecture (`llama.context_length`,
 * `qwen2.context_length`, ...), so the value is found by suffix rather than by a
 * hardcoded architecture key. Absent or malformed data yields `undefined` and
 * never a fabricated maximum.
 */
export function parseOllamaContextLength(modelInfo: unknown): number | undefined {
  if (typeof modelInfo !== 'object' || modelInfo === null) {
    return undefined;
  }
  for (const [key, value] of Object.entries(modelInfo as Record<string, unknown>)) {
    if (key === 'context_length' || key.endsWith('.context_length')) {
      const parsed = toPositiveInt(value);
      if (parsed !== undefined) {
        return parsed;
      }
    }
  }
  return undefined;
}

/** The `capabilities` string array from an Ollama `/api/show` body, if present. */
export function parseOllamaCapabilities(show: unknown): readonly string[] | undefined {
  if (typeof show !== 'object' || show === null) {
    return undefined;
  }
  const value = (show as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Thinking levels a model supports from an Ollama capabilities list.
 *
 * `thinking` present means the model reasons. A reported list without it means
 * the model is known not to reason (an empty list), which is distinct from a
 * missing list (`'unknown'`), where the provider said nothing at all.
 *
 * When Ollama reports the model's own controls (`thinking.values`), exactly
 * those levels are offered. `off` is always expressible with `think: false`,
 * and a model that reports no controls at all is a boolean toggle, so the
 * honest baseline is `off`/`on` rather than the full effort ladder.
 */
export function ollamaThinkingLevels(
  capabilities: readonly string[] | undefined,
  controls?: unknown
): CapabilityState<ThinkingLevel[]> {
  if (capabilities === undefined) {
    return 'unknown';
  }
  if (!capabilities.includes('thinking')) {
    return [];
  }
  const values =
    typeof controls === 'object' && controls !== null
      ? (controls as { values?: unknown }).values
      : undefined;
  const mapped = new Set<ThinkingLevel>(['off']);
  let recognised = 0;
  if (Array.isArray(values)) {
    for (const value of values) {
      const level = thinkingLevelFromOllama(value);
      if (level) {
        mapped.add(level);
        recognised += 1;
      }
    }
    // A non-empty list we cannot place at all is a provider change, not a
    // boolean toggle: stay unknown so the UI explains instead of guessing.
    if (values.length > 0 && recognised === 0) {
      return 'unknown';
    }
  } else {
    // No control list: `think: true` is still a valid toggle for a reasoning
    // model, so off/on is the honest baseline.
    mapped.add('on');
  }
  return THINKING_LEVELS.filter((level) => mapped.has(level));
}

/** The model's own reported thinking default, when Ollama named one. */
export function ollamaDefaultThinkingLevel(controls?: unknown): CapabilityState<ThinkingLevel> {
  const raw =
    typeof controls === 'object' && controls !== null
      ? (controls as { default?: unknown }).default
      : undefined;
  return thinkingLevelFromOllama(raw) ?? 'unknown';
}

/** Tool support from an Ollama capabilities list, or `'unknown'` when absent. */
export function ollamaToolSupport(
  capabilities: readonly string[] | undefined
): CapabilityState<boolean> {
  if (capabilities === undefined) {
    return 'unknown';
  }
  return capabilities.includes('tools');
}

/**
 * Build the provider-neutral descriptor for one Ollama model from its
 * `/api/show` body. `modes` is supplied by the adapter (Ollama serves Agent,
 * Plan, and Ask), so the descriptor names no provider field itself.
 */
export function ollamaCapabilities(show: unknown, modes: readonly DefaultMode[]): ModelCapabilities {
  const capabilities = parseOllamaCapabilities(show);
  const controls =
    typeof show === 'object' && show !== null ? (show as { thinking?: unknown }).thinking : undefined;
  const modelInfo =
    typeof show === 'object' && show !== null ? (show as { model_info?: unknown }).model_info : undefined;
  const contextLength = parseOllamaContextLength(modelInfo);

  // A reported context length is a real bound the model accepts. It is exposed
  // as both the maximum and the reported default, because Ollama runs at the
  // model's trained window unless told otherwise; the minimum is not reported
  // and stays unknown. When nothing is reported, both stay unknown.
  const contextWindow: ContextWindowCapability =
    contextLength !== undefined
      ? { min: 'unknown', max: contextLength, default: contextLength }
      : { min: 'unknown', max: 'unknown', default: 'unknown' };

  return {
    contextWindow,
    thinking: {
      supported: ollamaThinkingLevels(capabilities, controls),
      default: ollamaDefaultThinkingLevel(controls)
    },
    ...(capabilities ? { inputModalities: capabilities.includes('vision') ? ['text', 'image'] : ['text'] } : {}),
    tools: ollamaToolSupport(capabilities),
    modes: [...modes]
  };
}

/**
 * Thinking levels a Codex model supports, from the generated model's
 * `supportedReasoningEfforts`. A reported empty list means the model does not
 * reason; a missing list stays `'unknown'` so the UI hides the control rather
 * than guessing.
 *
 * The tiers come from the provider: each reported native effort is mapped onto
 * the UI ladder, so a model that reports only some tiers offers only those. An
 * unrecognized native tier is not forced onto the ladder; it is dropped rather
 * than guessed. `off` is offered only when the provider lists `none`; a model
 * that never reports it cannot be switched off through this control.
 */
export function codexThinkingLevels(
  supportedReasoningEfforts: readonly { reasoningEffort: string }[] | undefined
): CapabilityState<ThinkingLevel[]> {
  if (supportedReasoningEfforts === undefined) {
    return 'unknown';
  }
  if (supportedReasoningEfforts.length === 0) {
    return [];
  }
  const mapped = new Set<ThinkingLevel>();
  for (const option of supportedReasoningEfforts) {
    const level = thinkingLevelFromCodex(option.reasoningEffort);
    if (level) {
      mapped.add(level);
    }
  }
  if (mapped.size === 0) {
    // A non-empty list of tiers we cannot place: stay unknown rather than
    // fabricating a supported set, so the UI hides the control.
    return 'unknown';
  }
  return THINKING_LEVELS.filter((level) => mapped.has(level));
}

/** The UI default level for a Codex model, mapped from its native default tier. */
export function codexDefaultThinkingLevel(native: string | undefined): CapabilityState<ThinkingLevel> {
  if (native === undefined) {
    return 'unknown';
  }
  return thinkingLevelFromCodex(native) ?? 'unknown';
}

/**
 * Build the provider-neutral descriptor for one Codex model from the generated
 * `Model` fields. Codex models drive tool execution, so `tools` is a reported
 * `true`; `modes` is supplied by the adapter.
 *
 * Codex reports no per-model context window in `model/list`, and `turn/start`
 * has no context-window field, so no maximum is invented here. The CLI's global
 * `model_context_window` setting is not per-model, and
 * `thread/tokenUsage/updated.modelContextWindow` is a live usage denominator,
 * not a setting the sidebar can send. The context control therefore stays
 * unavailable instead of offering a value the provider would ignore.
 */
export function codexCapabilities(
  model: {
    supportedReasoningEfforts?: readonly { reasoningEffort: string }[];
    defaultReasoningEffort?: string;
  },
  modes: readonly DefaultMode[]
): ModelCapabilities {
  return {
    contextWindow: { min: 'unknown', max: 'unknown', default: 'unknown' },
    thinking: {
      supported: codexThinkingLevels(model.supportedReasoningEfforts),
      default: codexDefaultThinkingLevel(model.defaultReasoningEffort)
    },
    tools: true,
    modes: [...modes]
  };
}
