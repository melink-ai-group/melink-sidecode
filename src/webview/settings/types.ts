import type { ConnectionTestResult, SettingsPatch, SettingsSection, SettingsSnapshot } from '../../protocol';

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
  onBack: () => void;
  onSave: (patch: SettingsPatch, target?: 'global' | 'workspace') => void;
  onSaveToken: (value: string) => void;
  onClearToken: () => void;
  onSaveZenToken: (value: string) => void;
  onClearZenToken: () => void;
  onTestConnection: (
    backendId: string,
    draft?: { cliSource: 'local' | 'bundled'; path: string }
  ) => void;
  /** Set when a failure action opened settings, so that provider page is selected. */
  settingsProvider?: SettingsSection;
  codexVersionCheck?: { pending: boolean; ok?: boolean; message?: string };
  onValidateCodexVersion: () => void;
  opencodeUpgrade?: { pending: boolean; ok?: boolean; message?: string };
  onUpgradeOpencode: (draft: { cliSource: 'local' | 'bundled'; path: string }) => void;
  opencodeInstall?: { pending: boolean; ok?: boolean; message?: string; path?: string };
  onInstallOpencode: (draft: { cliSource: 'local' | 'bundled'; path: string }) => void;
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
}
