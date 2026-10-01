import type {
  ModelCapabilities,
  ModelSettingField,
  ModelSettingOverrides,
  ResolvedModelSettings
} from './types.ts';
import { resolveModelSettings, sanitizeOverrides } from './capabilities.ts';
import type { AppDefaults } from './capabilities.ts';

/**
 * Persists per-model setting overrides and resolves the effective values the UI
 * shows.
 *
 * Overrides live in `globalState`, keyed `providerId:modelId`, so a choice made
 * in one workspace survives a window reload *and* a workspace change. Keys are
 * never nested by workspace on purpose: a model's preferred reasoning effort is
 * a property of the model, not of the folder it happens to be used in.
 *
 * Nothing provider-specific is stored: only the neutral `ModelSettingOverrides`
 * shape. Clamping happens on read, so a value persisted against a model with a
 * wider range cannot leak into a turn after the model's range narrows.
 */

const OVERRIDES_KEY = 'melink.modelSettings.overrides';

type OverrideIndex = Record<string, ModelSettingOverrides>;

/**
 * The narrow slice of `vscode.Memento` this store needs. Taking the interface
 * rather than `ExtensionContext` keeps the store unit-testable without a VS Code
 * host, while the host still hands it `context.globalState` in production.
 */
export interface ModelSettingsMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** Global key for one provider+model. Exported so tests and callers agree on it. */
export function modelSettingsKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

export class ModelSettingsStore {
  private readonly memento: ModelSettingsMemento;
  private overrides?: OverrideIndex;

  constructor(memento: ModelSettingsMemento) {
    this.memento = memento;
  }

  /** The raw persisted overrides for one model, before any clamping. */
  getOverrides(providerId: string, modelId: string): ModelSettingOverrides {
    return this.load()[modelSettingsKey(providerId, modelId)] ?? {};
  }

  /**
   * Effective settings for one model: override > provider default > app default.
   * The stored override is clamped on read against the model's reported range,
   * so a stale value is never surfaced or sent.
   */
  resolve(
    providerId: string,
    modelId: string,
    capabilities?: ModelCapabilities,
    appDefaults?: AppDefaults
  ): ResolvedModelSettings {
    const overrides = sanitizeOverrides(this.getOverrides(providerId, modelId), capabilities);
    return resolveModelSettings({ providerId, modelId, capabilities, overrides, appDefaults });
  }

  /**
   * Merge and persist a patch for one model. `undefined` values are ignored so a
   * caller can send a partial update; the merged result is clamped against the
   * model before it is stored, so an out-of-range value never reaches storage.
   */
  async set(
    providerId: string,
    modelId: string,
    patch: ModelSettingOverrides,
    capabilities?: ModelCapabilities
  ): Promise<ResolvedModelSettings> {
    const key = modelSettingsKey(providerId, modelId);
    const merged: ModelSettingOverrides = { ...this.getOverrides(providerId, modelId), ...defined(patch) };
    const clean = sanitizeOverrides(merged, capabilities);
    const index = { ...this.load() };
    if (Object.keys(clean).length === 0) {
      delete index[key];
    } else {
      index[key] = clean;
    }
    this.overrides = index;
    await this.memento.update(OVERRIDES_KEY, index);
    return this.resolve(providerId, modelId, capabilities);
  }

  /** Remove every override for one model, so it falls back to provider defaults. */
  async clear(providerId: string, modelId: string): Promise<void> {
    const index = { ...this.load() };
    delete index[modelSettingsKey(providerId, modelId)];
    this.overrides = index;
    await this.memento.update(OVERRIDES_KEY, index);
  }

  /**
   * Remove the override for exactly one field, leaving the other field's
   * override intact. The per-control reset affordance uses this so resetting
   * the context window never silently resets the thinking level as well.
   */
  async clearField(providerId: string, modelId: string, field: ModelSettingField): Promise<void> {
    const key = modelSettingsKey(providerId, modelId);
    const current = { ...this.getOverrides(providerId, modelId) };
    delete current[field];
    const index = { ...this.load() };
    if (Object.keys(current).length === 0) {
      delete index[key];
    } else {
      index[key] = current;
    }
    this.overrides = index;
    await this.memento.update(OVERRIDES_KEY, index);
  }

  private load(): OverrideIndex {
    if (!this.overrides) {
      this.overrides = this.memento.get<OverrideIndex>(OVERRIDES_KEY) ?? {};
    }
    return this.overrides;
  }
}

/** Strip `undefined` fields so a partial patch never erases a stored value. */
function defined(patch: ModelSettingOverrides): ModelSettingOverrides {
  const result: ModelSettingOverrides = {};
  if (patch.contextWindow !== undefined) {
    result.contextWindow = patch.contextWindow;
  }
  if (patch.thinking !== undefined) {
    result.thinking = patch.thinking;
  }
  return result;
}
