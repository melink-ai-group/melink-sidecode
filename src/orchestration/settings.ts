/**
 * Host-free resolution of the six orchestration choices.
 *
 * Values come from an injected `inspect()`-shaped object: the nearest explicit
 * scope wins (folder > workspace > global) and a schema default is not explicit.
 * Every key is tri-state: `auto` (run only when the turn is relevant), `on`
 * (run whenever the role's hard mode applies), or `off` (never run). Saved
 * booleans are migrated on read: `true` becomes `on` and `false` becomes `off`.
 * The two post-turn settings that existed before T106 remain fallbacks, and the
 * returned legacy flags say when a fallback supplied the value.
 */

export const ORCHESTRATION_SECTION = 'melink.orchestration';

export const LEGACY_TESTING_KEY = 'melink.review.checks.enabled';
export const LEGACY_REVIEWING_KEY = 'melink.review.diffReview';

/** The three states a role can be in. */
export type OrchestrationChoice = 'auto' | 'on' | 'off';

export const ORCHESTRATION_CHOICES: readonly OrchestrationChoice[] = ['auto', 'on', 'off'];

export const ORCHESTRATION_DEFAULTS = {
  testing: 'on',
  reviewing: 'auto',
  styling: 'auto',
  doubleCheck: 'auto',
  quickTask: 'off',
  planning: 'auto'
} as const;

export type OrchestrationKey = keyof typeof ORCHESTRATION_DEFAULTS;
export type OrchestrationChoices = Record<OrchestrationKey, OrchestrationChoice>;

/** Kept as an alias so older imports keep meaning "one value per role". */
export type OrchestrationToggles = OrchestrationChoices;

export const ORCHESTRATION_KEYS: readonly OrchestrationKey[] = [
  'testing',
  'reviewing',
  'styling',
  'doubleCheck',
  'quickTask',
  'planning'
];

/** One `inspect()` scope, narrowed to the fields resolution needs. */
export interface SettingScope<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

export interface OrchestrationInspect {
  testing?: SettingScope<unknown>;
  reviewing?: SettingScope<unknown>;
  styling?: SettingScope<unknown>;
  doubleCheck?: SettingScope<unknown>;
  quickTask?: SettingScope<unknown>;
  planning?: SettingScope<unknown>;
  legacyTesting?: SettingScope<unknown>;
  legacyReviewing?: SettingScope<unknown>;
}

export interface ResolvedOrchestrationSettings extends OrchestrationChoices {
  legacyTesting: boolean;
  legacyReviewing: boolean;
}

export function resolveOrchestrationSettings(
  inspect: OrchestrationInspect
): ResolvedOrchestrationSettings {
  const testing = explicitChoice(inspect.testing);
  const reviewing = explicitChoice(inspect.reviewing);
  const legacyTesting = explicitChoice(inspect.legacyTesting);
  const legacyReviewing = explicitChoice(inspect.legacyReviewing);

  return {
    testing: testing ?? legacyTesting ?? ORCHESTRATION_DEFAULTS.testing,
    reviewing: reviewing ?? legacyReviewing ?? ORCHESTRATION_DEFAULTS.reviewing,
    styling: explicitChoice(inspect.styling) ?? ORCHESTRATION_DEFAULTS.styling,
    doubleCheck: explicitChoice(inspect.doubleCheck) ?? ORCHESTRATION_DEFAULTS.doubleCheck,
    quickTask: explicitChoice(inspect.quickTask) ?? ORCHESTRATION_DEFAULTS.quickTask,
    planning: explicitChoice(inspect.planning) ?? ORCHESTRATION_DEFAULTS.planning,
    legacyTesting: testing === undefined && legacyTesting !== undefined,
    legacyReviewing: reviewing === undefined && legacyReviewing !== undefined
  };
}

/**
 * Normalise one saved value. Booleans are the pre-T121 storage form, so they
 * keep their exact meaning (`true` = On, `false` = Off). An unknown value is
 * ignored rather than coerced; the caller then falls back to the default.
 */
export function normalizeOrchestrationChoice(value: unknown): OrchestrationChoice | undefined {
  if (value === true) {
    return 'on';
  }
  if (value === false) {
    return 'off';
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return isOrchestrationChoice(normalized) ? normalized : undefined;
}

export function isOrchestrationChoice(value: unknown): value is OrchestrationChoice {
  return value === 'auto' || value === 'on' || value === 'off';
}

/** The nearest explicit scope's choice, or `undefined` when none is set. */
function explicitChoice(scope: SettingScope<unknown> | undefined): OrchestrationChoice | undefined {
  if (!scope) {
    return undefined;
  }
  return normalizeOrchestrationChoice(
    firstDefined(scope.workspaceFolderValue, scope.workspaceValue, scope.globalValue)
  );
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}
