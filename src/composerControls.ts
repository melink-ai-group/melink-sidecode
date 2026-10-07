import { modelSettingsKey } from './backends/modelSettings.ts';
import type {
  DefaultMode,
  ModelSettingField,
  ModelSettingOverrides,
  PermissionLevel
} from './backends/types.ts';

const MODES = new Set<DefaultMode>(['agent', 'plan', 'ask']);
const PERMISSIONS = new Set<PermissionLevel>(['read-only', 'default', 'unrestricted']);
const THINKING = new Set<ModelSettingOverrides['thinking']>(['off', 'low', 'medium', 'high', 'extra high']);

/** Composer choices saved with one open chat tab. */
export interface StoredComposer {
  mode?: DefaultMode;
  permissionLevel?: PermissionLevel;
  composerBackendId?: string;
  composerModelId?: string;
  /**
   * Per-model overrides this chat has pinned. A present key belongs to this
   * chat, including `{}` after a reset. A missing key has not been pinned yet.
   */
  modelSettings?: Record<string, ModelSettingOverrides>;
}

export function copyModelSettings(
  settings: Readonly<Record<string, ModelSettingOverrides>> | undefined
): Record<string, ModelSettingOverrides> {
  const copy: Record<string, ModelSettingOverrides> = {};
  if (!settings) {
    return copy;
  }
  for (const [key, value] of Object.entries(settings)) {
    copy[key] = { ...value };
  }
  return copy;
}

/**
 * Overrides this chat has already pinned for one model.
 * `undefined` means the chat is still following the shared model default.
 */
export function pinnedModelSettings(
  settings: Readonly<Record<string, ModelSettingOverrides>>,
  providerId: string,
  modelId: string
): ModelSettingOverrides | undefined {
  const key = modelSettingsKey(providerId, modelId);
  if (!Object.prototype.hasOwnProperty.call(settings, key)) {
    return undefined;
  }
  return settings[key] ?? {};
}

/** Pin the shared model default the first time this chat reads it. */
export function withPinnedDefaults(
  settings: Readonly<Record<string, ModelSettingOverrides>>,
  providerId: string,
  modelId: string,
  modelDefault: ModelSettingOverrides
): Record<string, ModelSettingOverrides> {
  const key = modelSettingsKey(providerId, modelId);
  if (Object.prototype.hasOwnProperty.call(settings, key)) {
    return copyModelSettings(settings);
  }
  return { ...copyModelSettings(settings), [key]: { ...modelDefault } };
}

/**
 * Remember a settings change on this chat.
 * The first change copies the shared model default, then applies the patch,
 * so another chat's later edit does not leak in.
 */
export function pinModelSettings(
  settings: Readonly<Record<string, ModelSettingOverrides>>,
  providerId: string,
  modelId: string,
  patch: ModelSettingOverrides,
  modelDefault: ModelSettingOverrides
): Record<string, ModelSettingOverrides> {
  const key = modelSettingsKey(providerId, modelId);
  const base = Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] ?? {} : modelDefault;
  return { ...copyModelSettings(settings), [key]: mergeOverrides(base, patch) };
}

/** This chat returns to the model default. The pin stays, so it does not pick up another chat's values. */
export function clearPinnedModelSettings(
  settings: Readonly<Record<string, ModelSettingOverrides>>,
  providerId: string,
  modelId: string
): Record<string, ModelSettingOverrides> {
  const key = modelSettingsKey(providerId, modelId);
  return { ...copyModelSettings(settings), [key]: {} };
}

/** Clear one field on this chat and keep the other field's override. */
export function clearPinnedModelSettingField(
  settings: Readonly<Record<string, ModelSettingOverrides>>,
  providerId: string,
  modelId: string,
  field: ModelSettingField,
  modelDefault: ModelSettingOverrides
): Record<string, ModelSettingOverrides> {
  const key = modelSettingsKey(providerId, modelId);
  const base = Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] ?? {} : modelDefault;
  const next = { ...base };
  delete next[field];
  return { ...copyModelSettings(settings), [key]: next };
}

function mergeOverrides(base: ModelSettingOverrides, patch: ModelSettingOverrides): ModelSettingOverrides {
  const result: ModelSettingOverrides = { ...base };
  if (patch.contextWindow !== undefined) {
    result.contextWindow = patch.contextWindow;
  }
  if (patch.thinking !== undefined) {
    result.thinking = patch.thinking;
  }
  return result;
}

/** Read composer choices out of a saved tab. Malformed fields are dropped. */
export function parseStoredComposer(record: Record<string, unknown>): StoredComposer {
  const mode = typeof record.mode === 'string' && MODES.has(record.mode as DefaultMode) ? (record.mode as DefaultMode) : undefined;
  const permissionLevel =
    typeof record.permissionLevel === 'string' && PERMISSIONS.has(record.permissionLevel as PermissionLevel)
      ? (record.permissionLevel as PermissionLevel)
      : undefined;
  const composerBackendId = nonEmpty(record.composerBackendId);
  const composerModelId = nonEmpty(record.composerModelId);
  const modelSettings = parseModelSettings(record.modelSettings);
  return {
    ...(mode ? { mode } : {}),
    ...(permissionLevel ? { permissionLevel } : {}),
    ...(composerBackendId ? { composerBackendId } : {}),
    ...(composerModelId ? { composerModelId } : {}),
    ...(modelSettings ? { modelSettings } : {})
  };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseModelSettings(value: unknown): Record<string, ModelSettingOverrides> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const settings: Record<string, ModelSettingOverrides> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key || key.length > 400 || !entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const overrides: ModelSettingOverrides = {};
    if (typeof record.contextWindow === 'number' && Number.isFinite(record.contextWindow)) {
      overrides.contextWindow = record.contextWindow;
    }
    if (typeof record.thinking === 'string' && THINKING.has(record.thinking as ModelSettingOverrides['thinking'])) {
      overrides.thinking = record.thinking as ModelSettingOverrides['thinking'];
    }
    settings[key] = overrides;
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}
