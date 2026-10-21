import type { SettingsPatch, SettingsSnapshot } from '../../protocol';
import { formatDictationTarget } from '../../dictation/target.ts';
import { quickTaskApplies } from '../../orchestration/quickTask.ts';

/** Local draft state; the host snapshot is the source of truth on save. */
export interface Draft {
  ollamaBaseUrl: string;
  ollamaDefaultModel: string;
  ollamaLocalBaseUrl: string;
  ollamaLocalDefaultModel: string;
  opencodeDefaultModel: string;
  codexPath: string;
  codexDefaultModel: string;
  permissionLevel: SettingsSnapshot['defaults']['permissionLevel'];
  mode: SettingsSnapshot['defaults']['mode'];
  thinking: SettingsSnapshot['defaults']['thinking'] | '';
  dictationModel: string;
  orchestrationTesting: boolean;
  orchestrationReviewing: boolean;
  orchestrationDoubleCheck: boolean;
  orchestrationQuickTask: boolean;
  orchestrationPlanning: boolean;
  opencodeCliSource: 'local' | 'bundled';
  opencodePath: string;
  browserCodex: boolean;
  browserOpencode: boolean;
  zvecGrepCliSource: 'local' | 'bundled';
  zvecGrepPath: string;
  astGrepCliSource: 'local' | 'bundled';
  astGrepPath: string;
  contextIncludeInstructions: boolean;
  contextIncludeShape: boolean;
  contextIncludeEditorState: boolean;
  contextIncludeSelection: boolean;
  contextIncludeChangedFiles: boolean;
  /** The overall cap, held as a string so a half-typed value is not coerced. */
  contextMaxKb: string;
  contextExclude: string[];
}

/** The value the draft displays/saves: with every pass off there is nothing to skip. */
export function normalizedQuickTask(
  orchestration: Pick<SettingsSnapshot['orchestration'], 'quickTask' | 'testing' | 'reviewing' | 'doubleCheck'>
): boolean {
  return quickTaskApplies(orchestration.quickTask, orchestration);
}

/** Seed the draft from a host snapshot; used on load, echo, and reset. */
export function draftFrom(settings: SettingsSnapshot): Draft {
  const orchestrationQuickTask = normalizedQuickTask(settings.orchestration);
  return {
    ollamaBaseUrl: settings.ollama.baseUrl,
    ollamaDefaultModel: settings.ollama.defaultModel,
    ollamaLocalBaseUrl: settings.ollamaLocal.baseUrl,
    ollamaLocalDefaultModel: settings.ollamaLocal.defaultModel,
    opencodeDefaultModel: settings.opencodeZen.defaultModel,
    codexPath: settings.codex.path,
    codexDefaultModel: settings.codex.defaultModel,
    permissionLevel: settings.defaults.permissionLevel,
    mode: settings.defaults.mode,
    thinking: settings.defaults.thinking ?? '',
    dictationModel: formatDictationTarget(settings.defaults.dictationModel),
    orchestrationTesting: settings.orchestration.testing,
    orchestrationReviewing: settings.orchestration.reviewing,
    orchestrationDoubleCheck: settings.orchestration.doubleCheck,
    orchestrationQuickTask,
    orchestrationPlanning: settings.orchestration.planning,
    opencodeCliSource: settings.opencode.cliSource,
    opencodePath: settings.opencode.local.path,
    browserCodex: settings.skills.browserCodex,
    browserOpencode: settings.skills.browserOpencode,
    zvecGrepCliSource: settings.skills.zvecGrep.cliSource,
    zvecGrepPath: settings.skills.zvecGrep.local.path,
    astGrepCliSource: settings.skills.astGrep.cliSource,
    astGrepPath: settings.skills.astGrep.local.path,
    contextIncludeInstructions: settings.context.includeInstructions,
    contextIncludeShape: settings.context.includeShape,
    contextIncludeEditorState: settings.context.includeEditorState,
    contextIncludeSelection: settings.context.includeSelection,
    contextIncludeChangedFiles: settings.context.includeChangedFiles,
    contextMaxKb: String(Math.round(settings.context.maxBytes / 1024)),
    contextExclude: [...settings.context.exclude]
  };
}


/** The patch the draft would save: every field, paths included. */
export function patchFrom(draft: Draft): Required<SettingsPatch> {
  const maxKb = Number(draft.contextMaxKb.trim());
  return {
    ollamaBaseUrl: draft.ollamaBaseUrl.trim(),
    ollamaDefaultModel: draft.ollamaDefaultModel.trim(),
    ollamaLocalBaseUrl: draft.ollamaLocalBaseUrl.trim(),
    ollamaLocalDefaultModel: draft.ollamaLocalDefaultModel.trim(),
    opencodeDefaultModel: draft.opencodeDefaultModel.trim(),
    codexPath: draft.codexPath.trim(),
    codexDefaultModel: draft.codexDefaultModel.trim(),
    permissionLevel: draft.permissionLevel,
    mode: draft.mode,
    thinking: draft.thinking ?? '',
    dictationModel: draft.dictationModel.trim(),
    orchestrationTesting: draft.orchestrationTesting,
    orchestrationReviewing: draft.orchestrationReviewing,
    orchestrationDoubleCheck: draft.orchestrationDoubleCheck,
    orchestrationQuickTask: draft.orchestrationQuickTask,
    orchestrationPlanning: draft.orchestrationPlanning,
    opencodeCliSource: draft.opencodeCliSource,
    // Always included: the saved path is what this screen shows and compares,
    // so bundling must not leave a typed path silently unwritten.
    opencodePath: draft.opencodePath.trim(),
    browserCodex: draft.browserCodex,
    browserOpencode: draft.browserOpencode,
    zvecGrepCliSource: draft.zvecGrepCliSource,
    zvecGrepPath: draft.zvecGrepPath.trim(),
    astGrepCliSource: draft.astGrepCliSource,
    astGrepPath: draft.astGrepPath.trim(),
    contextIncludeInstructions: draft.contextIncludeInstructions,
    contextIncludeShape: draft.contextIncludeShape,
    contextIncludeEditorState: draft.contextIncludeEditorState,
    contextIncludeSelection: draft.contextIncludeSelection,
    contextIncludeChangedFiles: draft.contextIncludeChangedFiles,
    contextMaxBytes: Number.isFinite(maxKb) ? Math.round(maxKb * 1024) : Number.NaN,
    contextExclude: draft.contextExclude.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0)
  };
}

/**
 * The stored values the draft is compared against.
 *
 * The comparison reads the same normalised patch the save would write. That is
 * the point: if the patch would change a value, the key is dirty; once the echo
 * stores it, the same comparison clears. No field can be dirty but never sent.
 */
function storedPatch(settings: SettingsSnapshot): Required<SettingsPatch> {
  return {
    ollamaBaseUrl: settings.ollama.baseUrl,
    ollamaDefaultModel: settings.ollama.defaultModel,
    ollamaLocalBaseUrl: settings.ollamaLocal.baseUrl,
    ollamaLocalDefaultModel: settings.ollamaLocal.defaultModel,
    opencodeDefaultModel: settings.opencodeZen.defaultModel,
    codexPath: settings.codex.path,
    codexDefaultModel: settings.codex.defaultModel,
    permissionLevel: settings.defaults.permissionLevel,
    mode: settings.defaults.mode,
    thinking: settings.defaults.thinking ?? '',
    dictationModel: formatDictationTarget(settings.defaults.dictationModel),
    orchestrationTesting: settings.orchestration.testing,
    orchestrationReviewing: settings.orchestration.reviewing,
    orchestrationDoubleCheck: settings.orchestration.doubleCheck,
    orchestrationQuickTask: normalizedQuickTask(settings.orchestration),
    orchestrationPlanning: settings.orchestration.planning,
    opencodeCliSource: settings.opencode.cliSource,
    opencodePath: settings.opencode.local.path,
    browserCodex: settings.skills.browserCodex,
    browserOpencode: settings.skills.browserOpencode,
    zvecGrepCliSource: settings.skills.zvecGrep.cliSource,
    zvecGrepPath: settings.skills.zvecGrep.local.path,
    astGrepCliSource: settings.skills.astGrep.cliSource,
    astGrepPath: settings.skills.astGrep.local.path,
    contextIncludeInstructions: settings.context.includeInstructions,
    contextIncludeShape: settings.context.includeShape,
    contextIncludeEditorState: settings.context.includeEditorState,
    contextIncludeSelection: settings.context.includeSelection,
    contextIncludeChangedFiles: settings.context.includeChangedFiles,
    contextMaxBytes: settings.context.maxBytes,
    contextExclude: [...settings.context.exclude]
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return Object.is(a, b);
}

/** Every field whose normalised draft value differs from the stored value. */
export function dirtyKeys(draft: Draft, settings: SettingsSnapshot): Array<keyof SettingsPatch> {
  const wanted = patchFrom(draft);
  const stored = storedPatch(settings);
  return (Object.keys(wanted) as Array<keyof SettingsPatch>).filter(
    (key) => !sameValue(wanted[key], stored[key])
  );
}

export function isDraftDirty(draft: Draft | undefined, settings: SettingsSnapshot | undefined): boolean {
  return Boolean(draft && settings && dirtyKeys(draft, settings).length > 0);
}

