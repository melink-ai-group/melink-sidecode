/**
 * Host-free resolution of the six orchestration toggles.
 *
 * Values come from an injected `inspect()`-shaped object: the nearest explicit
 * scope wins (folder > workspace > global) and a schema default is not explicit.
 * The two post-turn settings that existed before T106 remain fallbacks, and the
 * returned legacy flags say when a fallback supplied the value.
 */

export const ORCHESTRATION_SECTION = 'melink.orchestration';

export const LEGACY_TESTING_KEY = 'melink.review.checks.enabled';
export const LEGACY_REVIEWING_KEY = 'melink.review.diffReview';

export const ORCHESTRATION_DEFAULTS = {
  testing: false,
  reviewing: false,
  styling: true,
  doubleCheck: true,
  quickTask: true,
  planning: true
} as const;

export type OrchestrationKey = keyof typeof ORCHESTRATION_DEFAULTS;
export type OrchestrationToggles = Record<OrchestrationKey, boolean>;

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

export interface ResolvedOrchestrationSettings extends OrchestrationToggles {
  legacyTesting: boolean;
  legacyReviewing: boolean;
}

export function resolveOrchestrationSettings(
  inspect: OrchestrationInspect
): ResolvedOrchestrationSettings {
  const testing = explicitBoolean(inspect.testing);
  const reviewing = explicitBoolean(inspect.reviewing);
  const legacyTesting = explicitBoolean(inspect.legacyTesting);
  const legacyReviewing = explicitBoolean(inspect.legacyReviewing);

  return {
    testing: testing ?? legacyTesting ?? ORCHESTRATION_DEFAULTS.testing,
    reviewing: reviewing ?? legacyReviewing ?? ORCHESTRATION_DEFAULTS.reviewing,
    styling: explicitBoolean(inspect.styling) ?? ORCHESTRATION_DEFAULTS.styling,
    doubleCheck: explicitBoolean(inspect.doubleCheck) ?? ORCHESTRATION_DEFAULTS.doubleCheck,
    quickTask: explicitBoolean(inspect.quickTask) ?? ORCHESTRATION_DEFAULTS.quickTask,
    planning: explicitBoolean(inspect.planning) ?? ORCHESTRATION_DEFAULTS.planning,
    legacyTesting: testing === undefined && legacyTesting !== undefined,
    legacyReviewing: reviewing === undefined && legacyReviewing !== undefined
  };
}

function explicitBoolean(scope: SettingScope<unknown> | undefined): boolean | undefined {
  if (!scope) {
    return undefined;
  }
  const nearest = firstDefined(
    scope.workspaceFolderValue,
    scope.workspaceValue,
    scope.globalValue
  );
  return typeof nearest === 'boolean' ? nearest : undefined;
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}
