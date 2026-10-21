import type { SettingsSnapshot } from '../../protocol';
import { formatDictationTarget } from '../../dictation/target';

/** Local draft state; the host snapshot is the source of truth on save. */
export interface Draft {
  ollamaBaseUrl: string;
  ollamaDefaultModel: string;
  opencodeDefaultModel: string;
  codexPath: string;
  codexDefaultModel: string;
  permissionLevel: SettingsSnapshot['defaults']['permissionLevel'];
  mode: SettingsSnapshot['defaults']['mode'];
  thinking: SettingsSnapshot['defaults']['thinking'] | '';
  dictationModel: string;
  opencodeEnabled: boolean;
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

/** Seed the draft from a host snapshot; used on load, echo, and reset. */
export function draftFrom(settings: SettingsSnapshot): Draft {
  return {
    ollamaBaseUrl: settings.ollama.baseUrl,
    ollamaDefaultModel: settings.ollama.defaultModel,
    opencodeDefaultModel: settings.opencodeZen.defaultModel,
    codexPath: settings.codex.path,
    codexDefaultModel: settings.codex.defaultModel,
    permissionLevel: settings.defaults.permissionLevel,
    mode: settings.defaults.mode,
    thinking: settings.defaults.thinking ?? '',
    dictationModel: formatDictationTarget(settings.defaults.dictationModel),
    opencodeEnabled: settings.opencode.enabled,
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
