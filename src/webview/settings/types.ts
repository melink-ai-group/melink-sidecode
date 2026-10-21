import type { ConnectionTestResult, SettingsPatch, SettingsSnapshot } from '../../protocol';

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
  /** Set when the protocol warning opened settings, so the Codex page is selected. */
  settingsProvider?: 'codex';
  codexVersionCheck?: { pending: boolean; ok?: boolean; message?: string };
  onValidateCodexVersion: () => void;
  opencodeUpgrade?: { pending: boolean; ok?: boolean; message?: string };
  onUpgradeOpencode: (draft: { cliSource: 'local' | 'bundled'; path: string }) => void;
  opencodeInstall?: { pending: boolean; ok?: boolean; message?: string; path?: string };
  onInstallOpencode: (draft: { cliSource: 'local' | 'bundled'; path: string }) => void;
  zvecGrep?: { pending: boolean; requested?: boolean; ok?: boolean; message?: string };
  onSetZvecGrep: (enabled: boolean, draft?: { cliSource: 'local' | 'bundled'; path: string }) => void;
  astGrep?: { pending: boolean; requested?: boolean; ok?: boolean; message?: string };
  onSetAstGrep: (enabled: boolean, draft?: { cliSource: 'local' | 'bundled'; path: string }) => void;
  astGrepInstall?: { pending: boolean; ok?: boolean; message?: string; path?: string };
  onInstallAstGrep: (draft: { cliSource: 'local' | 'bundled'; path: string }) => void;
  onUpgradeAstGrep: (draft: { cliSource: 'local' | 'bundled'; path: string }) => void;
  zvecGrepInstall?: { pending: boolean; ok?: boolean; message?: string; path?: string };
  onInstallZvecGrep: (draft: { cliSource: 'local' | 'bundled'; path: string }) => void;
}
