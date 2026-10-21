import type { SettingsSnapshot } from '../../protocol';
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
