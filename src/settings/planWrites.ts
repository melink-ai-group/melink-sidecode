import type { SettingsPatch } from '../protocol.ts';
import { PERMISSION_LEVELS } from '../backends/types.ts';
import { DEFAULT_MODES } from '../backends/modes.ts';
import { isThinkingLevel } from '../backends/capabilities.ts';
import { skillCliPathError } from '../backends/skillCli.ts';
import { opencodePathError } from '../backends/opencode/status.ts';
import { executablePathError, resolveExecutableCommand } from '../backends/executables.ts';
import { fieldSaveOutcome } from '../config/settingsScope.ts';
import type { SettingsWriteScope } from '../config/trust.ts';
import {
  CONTEXT_SECTION,
  MAX_CONTEXT_BYTES,
  MIN_CONTEXT_BYTES,
  contextPatternError
} from '../context/contextSettings.ts';
import { normalizeOrchestrationChoice } from '../orchestration/settings.ts';

/**
 * Turn a settings patch into the exact list of configuration writes.
 *
 * Host-free: the caller supplies the path-existence check, so this decision
 * can be tested without VS Code. `SettingsService.save` only executes the
 * plan, one `config.update` per entry, and reports any rejection against the
 * field it belongs to. That keeps "every changed control is written" and
 * "a failed write is named" observable instead of implied.
 */

const OLLAMA_SECTION = 'melink.ollama';
const OLLAMA_LOCAL_SECTION = 'melink.ollamaLocal';
const OLLAMA_OPENCODE_SECTION = 'melink.ollama.opencode';
const OPENCODE_SECTION = 'melink.opencode';
const CODEX_SECTION = 'melink.codex';
const DEFAULTS_SECTION = 'melink.defaults';
const ORCHESTRATION_SECTION = 'melink.orchestration';
const SKILLS_SECTION = 'melink.skills';

/** Where a settings patch is written. */
export type SettingsSaveTarget = SettingsWriteScope;

/** One resolved configuration write. */
export interface SettingsWrite {
  /** The `SettingsPatch` field this write came from. */
  field: keyof SettingsPatch;
  /** The VS Code configuration key. */
  key: string;
  /** The already-normalised value. */
  value: unknown;
  /** The scope this value is actually written to. */
  scope: SettingsSaveTarget;
}

/** Outcome of validating and planning one patch. */
export interface SettingsWritePlan {
  writes: SettingsWrite[];
  /** Field-keyed refusal messages; a refused field has no write. */
  errors: Partial<Record<keyof SettingsPatch, string>>;
  /** Field-keyed scope notices for values redirected to the user settings. */
  notices: Partial<Record<keyof SettingsPatch, string>>;
}

/** Outcome of executing a plan. */
export interface SaveResult {
  ok: boolean;
  /** Field-keyed messages; a field with a message is never persisted. */
  errors: Partial<Record<keyof SettingsPatch, string>>;
  /** Field-keyed notices for values redirected to the user settings. */
  notices?: Partial<Record<keyof SettingsPatch, string>>;
}

export interface PlanSettingsWritesOptions {
  /** Path-existence check for the opencode local path. Defaults to "exists". */
  pathExists?: (path: string) => boolean;
  /**
   * Per-key effective scope, when a value is controlled by a nearer override.
   * `SettingsService.save` passes the nearest existing scope so a workspace or
   * folder save lands where the shown value actually comes from.
   */
  scopeFor?: (key: string) => SettingsSaveTarget | undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function codexPathError(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Enter the CLI path or name. This value was not saved.';
  }
  const resolved = resolveExecutableCommand(trimmed, 'codex');
  return resolved.ok ? undefined : executablePathError(resolved.reason, 'Codex CLI');
}

/** The message for a field whose `config.update` rejected. */
export function writeFailureMessage(): string {
  return 'This value was not saved. Your settings could not be written; they may be locked by your organization or the file may be read-only.';
}

/**
 * Resolve every field of a patch into a write, or a per-field refusal.
 *
 * Path fields are planned unconditionally: the stored path is the one the
 * screen shows and compares, so a save must never leave it stale while the
 * draft still reports a change. The source (`local`/`bundled`) decides what is
 * spawned, not which local path is stored.
 */
export function planSettingsWrites(
  patch: SettingsPatch,
  scope: SettingsSaveTarget = 'global',
  options: PlanSettingsWritesOptions = {}
): SettingsWritePlan {
  const writes: SettingsWrite[] = [];
  const errors: Partial<Record<keyof SettingsPatch, string>> = {};
  const notices: Partial<Record<keyof SettingsPatch, string>> = {};
  const pathExists = options.pathExists ?? (() => true);

  const write = (field: keyof SettingsPatch, key: string, value: unknown): void => {
    const requested = options.scopeFor?.(key) ?? scope;
    const outcome = fieldSaveOutcome(key, requested);
    writes.push({ field, key, value, scope: outcome.scope });
    if (outcome.redirected && outcome.notice) {
      notices[field] = outcome.notice;
    }
  };

  if (patch.ollamaEnabled !== undefined) {
    write('ollamaEnabled', `${OLLAMA_SECTION}.enabled`, patch.ollamaEnabled === true);
  }

  if (patch.ollamaLocalEnabled !== undefined) {
    write('ollamaLocalEnabled', `${OLLAMA_LOCAL_SECTION}.enabled`, patch.ollamaLocalEnabled === true);
  }

  if (patch.opencodeEnabled !== undefined) {
    write('opencodeEnabled', `${OPENCODE_SECTION}.enabled`, patch.opencodeEnabled === true);
  }

  if (patch.codexEnabled !== undefined) {
    write('codexEnabled', `${CODEX_SECTION}.enabled`, patch.codexEnabled === true);
  }

  if (patch.ollamaBaseUrl !== undefined) {
    const value = patch.ollamaBaseUrl.trim();
    if (!isHttpUrl(value)) {
      errors.ollamaBaseUrl = 'Enter a full URL, like https://ollama.com. This value was not saved.';
    } else {
      write('ollamaBaseUrl', `${OLLAMA_SECTION}.baseUrl`, value);
    }
  }

  if (patch.ollamaLocalBaseUrl !== undefined) {
    const value = patch.ollamaLocalBaseUrl.trim();
    if (!isHttpUrl(value)) {
      errors.ollamaLocalBaseUrl =
        'Enter a full URL, like http://localhost:11434. This value was not saved.';
    } else {
      write('ollamaLocalBaseUrl', `${OLLAMA_LOCAL_SECTION}.baseUrl`, value);
    }
  }

  if (patch.ollamaDefaultModel !== undefined) {
    write('ollamaDefaultModel', `${OLLAMA_SECTION}.defaultModel`, patch.ollamaDefaultModel.trim());
  }

  if (patch.ollamaLocalDefaultModel !== undefined) {
    write(
      'ollamaLocalDefaultModel',
      `${OLLAMA_LOCAL_SECTION}.defaultModel`,
      patch.ollamaLocalDefaultModel.trim()
    );
  }

  if (patch.opencodeDefaultModel !== undefined) {
    write('opencodeDefaultModel', `${OPENCODE_SECTION}.defaultModel`, patch.opencodeDefaultModel.trim());
  }

  if (patch.codexPath !== undefined) {
    const pathError = codexPathError(patch.codexPath);
    if (pathError) {
      errors.codexPath = pathError;
    } else {
      write('codexPath', `${CODEX_SECTION}.path`, patch.codexPath.trim());
    }
  }

  if (patch.codexDefaultModel !== undefined) {
    write('codexDefaultModel', `${CODEX_SECTION}.defaultModel`, patch.codexDefaultModel.trim());
  }

  if (patch.permissionLevel !== undefined) {
    if (!PERMISSION_LEVELS.includes(patch.permissionLevel)) {
      errors.permissionLevel =
        'Pick one of the listed permission levels. This value was not saved.';
    } else {
      write('permissionLevel', `${DEFAULTS_SECTION}.permissionLevel`, patch.permissionLevel);
    }
  }

  if (patch.mode !== undefined) {
    if (!DEFAULT_MODES.includes(patch.mode)) {
      errors.mode = 'Pick one of the listed modes. This value was not saved.';
    } else {
      write('mode', `${DEFAULTS_SECTION}.mode`, patch.mode);
    }
  }

  if (patch.thinking !== undefined) {
    if (patch.thinking !== '' && !isThinkingLevel(patch.thinking)) {
      errors.thinking = 'Pick one of the listed thinking levels. This value was not saved.';
    } else {
      write('thinking', `${DEFAULTS_SECTION}.thinking`, patch.thinking || undefined);
    }
  }

  if (patch.dictationModel !== undefined) {
    write('dictationModel', `${DEFAULTS_SECTION}.dictationModel`, patch.dictationModel.trim());
  }

  if (patch.opencodeCliSource !== undefined) {
    if (patch.opencodeCliSource !== 'local' && patch.opencodeCliSource !== 'bundled') {
      errors.opencodeCliSource = 'Pick local machine or bundled. This value was not saved.';
    } else {
      write(
        'opencodeCliSource',
        `${OLLAMA_OPENCODE_SECTION}.cliSource`,
        patch.opencodeCliSource
      );
    }
  }

  if (patch.opencodePath !== undefined) {
    const pathError = opencodePathError(patch.opencodePath, pathExists);
    if (pathError) {
      errors.opencodePath = pathError;
    } else {
      write('opencodePath', `${OLLAMA_OPENCODE_SECTION}.path`, patch.opencodePath.trim());
    }
  }

  const orchestration: Array<[keyof SettingsPatch, string, unknown]> = [
    ['orchestrationTesting', `${ORCHESTRATION_SECTION}.testing`, patch.orchestrationTesting],
    ['orchestrationReviewing', `${ORCHESTRATION_SECTION}.reviewing`, patch.orchestrationReviewing],
    ['orchestrationStyling', `${ORCHESTRATION_SECTION}.styling`, patch.orchestrationStyling],
    ['orchestrationDoubleCheck', `${ORCHESTRATION_SECTION}.doubleCheck`, patch.orchestrationDoubleCheck],
    ['orchestrationQuickTask', `${ORCHESTRATION_SECTION}.quickTask`, patch.orchestrationQuickTask],
    ['orchestrationPlanning', `${ORCHESTRATION_SECTION}.planning`, patch.orchestrationPlanning]
  ];
  for (const [field, key, value] of orchestration) {
    if (value === undefined) {
      continue;
    }
    // An older webview (or a hand-edited settings file) may still carry the
    // pre-T121 boolean. Normalise it on save so the stored form is always one
    // of the three choices; an unrecognised value is refused, not coerced.
    const normalized = normalizeOrchestrationChoice(value);
    if (normalized === undefined) {
      errors[field] = 'Pick Auto, On, or Off. This value was not saved.';
    } else {
      write(field, key, normalized);
    }
  }

  if (patch.contextIncludeInstructions !== undefined) {
    write(
      'contextIncludeInstructions',
      `${CONTEXT_SECTION}.includeInstructions`,
      patch.contextIncludeInstructions
    );
  }
  if (patch.contextIncludeShape !== undefined) {
    write('contextIncludeShape', `${CONTEXT_SECTION}.includeShape`, patch.contextIncludeShape);
  }
  if (patch.contextIncludeEditorState !== undefined) {
    write(
      'contextIncludeEditorState',
      `${CONTEXT_SECTION}.includeEditorState`,
      patch.contextIncludeEditorState
    );
  }
  if (patch.contextIncludeSelection !== undefined) {
    write(
      'contextIncludeSelection',
      `${CONTEXT_SECTION}.includeSelection`,
      patch.contextIncludeSelection
    );
  }
  if (patch.contextIncludeChangedFiles !== undefined) {
    write(
      'contextIncludeChangedFiles',
      `${CONTEXT_SECTION}.includeChangedFiles`,
      patch.contextIncludeChangedFiles
    );
  }

  if (patch.contextMaxBytes !== undefined) {
    const value = Math.floor(patch.contextMaxBytes);
    if (!Number.isFinite(value) || value < MIN_CONTEXT_BYTES || value > MAX_CONTEXT_BYTES) {
      errors.contextMaxBytes = `Enter a whole number between ${MIN_CONTEXT_BYTES} and ${MAX_CONTEXT_BYTES}. This value was not saved.`;
    } else {
      write('contextMaxBytes', `${CONTEXT_SECTION}.maxBytes`, value);
    }
  }

  if (patch.contextExclude !== undefined) {
    const bad = patch.contextExclude.find((pattern) => contextPatternError(pattern) !== undefined);
    if (bad !== undefined) {
      errors.contextExclude = contextPatternError(bad);
    } else {
      const cleaned = patch.contextExclude
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern.length > 0);
      write('contextExclude', `${CONTEXT_SECTION}.exclude`, cleaned);
    }
  }

  if (patch.browserCodex !== undefined) {
    write('browserCodex', `${SKILLS_SECTION}.browserCodex`, patch.browserCodex === true);
  }
  if (patch.browserOpencode !== undefined) {
    write('browserOpencode', `${SKILLS_SECTION}.browserOpencode`, patch.browserOpencode === true);
  }

  if (patch.zvecGrepCliSource !== undefined) {
    write(
      'zvecGrepCliSource',
      `${SKILLS_SECTION}.zvecGrep.cliSource`,
      patch.zvecGrepCliSource === 'bundled' ? 'bundled' : 'local'
    );
  }
  if (patch.zvecGrepPath !== undefined) {
    const pathError = skillCliPathError(patch.zvecGrepPath, 'zg', 'zg CLI');
    if (pathError) {
      errors.zvecGrepPath = pathError;
    } else {
      write('zvecGrepPath', `${SKILLS_SECTION}.zvecGrep.path`, patch.zvecGrepPath.trim() || 'zg');
    }
  }

  if (patch.astGrepCliSource !== undefined) {
    write(
      'astGrepCliSource',
      `${SKILLS_SECTION}.astGrep.cliSource`,
      patch.astGrepCliSource === 'bundled' ? 'bundled' : 'local'
    );
  }
  if (patch.astGrepPath !== undefined) {
    const pathError = skillCliPathError(patch.astGrepPath, 'ast-grep', 'ast-grep CLI');
    if (pathError) {
      errors.astGrepPath = pathError;
    } else {
      write('astGrepPath', `${SKILLS_SECTION}.astGrep.path`, patch.astGrepPath.trim() || 'ast-grep');
    }
  }

  return { writes, errors, notices };
}

/**
 * Execute a plan one write at a time.
 *
 * A rejected write is recorded on its field and execution continues, so a
 * locked key does not silently discard the rest of the patch. The caller gets
 * an `ok:false` result naming exactly the fields that were not persisted.
 */
export async function executeSettingsWrites(
  plan: SettingsWritePlan,
  update: (write: SettingsWrite) => Promise<void>
): Promise<SaveResult> {
  const errors: Partial<Record<keyof SettingsPatch, string>> = { ...plan.errors };
  for (const write of plan.writes) {
    try {
      await update(write);
    } catch {
      errors[write.field] = writeFailureMessage();
    }
  }
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    ...(Object.keys(plan.notices).length > 0 ? { notices: plan.notices } : {})
  };
}

