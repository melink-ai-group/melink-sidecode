import type { ConnectionTestResult, SettingsPatch, SettingsSection, SettingsSnapshot } from '../../protocol';
import type { SettingsSaveState } from './SaveFooter';

export type ProviderTab = 'provider-ollama' | 'provider-local' | 'provider-opencode' | 'provider-codex';

/** Map the section a failure action asked for to the Providers nested tab. */
export function providerTabForSection(section: SettingsSection | undefined): ProviderTab {
  if (section === 'codex') {
    return 'provider-codex';
  }
  if (section === 'ollama-local') {
    return 'provider-local';
  }
  return 'provider-ollama';
}

export interface SettingsScreenProps {
  settings?: SettingsSnapshot;
  connectionTest?: { backendId: string; pending: boolean; result?: ConnectionTestResult };
  /** Busy/result state of the settings save, owned by the host and App state. */
  settingsSave?: SettingsSaveState;
  onBack: () => void;
  onSave: (patch: SettingsPatch, target?: 'global' | 'workspace' | 'folder') => void;
  onSaveToken: (value: string) => void;
  onClearToken: () => void;
  onSaveZenToken: (value: string) => void;
  onClearZenToken: () => void;
  onTestConnection: (
    backendId: string,
    draft?: { cliSource: 'local' | 'bundled' | 'bundled-v2'; path: string }
  ) => void;
  /** Set when a failure action opened settings, so that provider page is selected. */
  settingsProvider?: SettingsSection;
  codexVersionCheck?: { pending: boolean; ok?: boolean; message?: string };
  onValidateCodexVersion: () => void;
  opencodeUpgrade?: { pending: boolean; ok?: boolean; message?: string };
  onUpgradeOpencode: (draft: { cliSource: 'local' | 'bundled' | 'bundled-v2'; path: string }) => void;
  opencodeInstall?: { pending: boolean; ok?: boolean; message?: string; path?: string };
  onInstallOpencode: (draft: { cliSource: 'local' | 'bundled' | 'bundled-v2'; path: string }) => void;
  zvecGrep?: {
    pending: boolean;
    requested?: boolean;
    ok?: boolean;
    message?: string;
    /** The field a refused path belongs to, when the host refused one. */
    field?: 'zvecGrepPath' | 'astGrepPath';
    fieldMessage?: string;
  };
  onSetZvecGrep: (enabled: boolean, draft?: { cliSource: 'local' | 'bundled'; path: string }) => void;
  astGrep?: {
    pending: boolean;
    requested?: boolean;
    ok?: boolean;
    message?: string;
    /** The field a refused path belongs to, when the host refused one. */
    field?: 'zvecGrepPath' | 'astGrepPath';
    fieldMessage?: string;
  };
  onSetAstGrep: (enabled: boolean, draft?: { cliSource: 'local' | 'bundled'; path: string }) => void;
  astGrepInstall?: { pending: boolean; ok?: boolean; message?: string; path?: string };
  onInstallAstGrep: (draft: { cliSource: 'local' | 'bundled'; path: string }) => void;
  onUpgradeAstGrep: (draft: { cliSource: 'local' | 'bundled'; path: string }) => void;
  zvecGrepInstall?: { pending: boolean; ok?: boolean; message?: string; path?: string };
  onInstallZvecGrep: (draft: { cliSource: 'local' | 'bundled'; path: string }) => void;
  skillAction?: {
    skill: 'zvecGrep' | 'astGrep';
    action: 'test' | 'index';
    pending: boolean;
    ok?: boolean;
    message?: string;
  };
  onSkillAction: (
    skill: 'zvecGrep' | 'astGrep',
    action: 'test' | 'index',
    draft?: { cliSource: 'local' | 'bundled'; path: string }
  ) => void;
}
