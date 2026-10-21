import * as vscode from 'vscode';
import { CHECK_SECTION, readCheckSettingsFrom, type ResolvedCheckSettings } from './checkSettings.ts';

/**
 * The one binding from the real VS Code configuration to the host-free
 * `checkSettings` resolver.
 *
 * Trust is read from the workspace, not a setting: an untrusted workspace must
 * never run package scripts, regardless of what `settings.json` says.
 */
export function readWorkspaceCheckSettings(): ResolvedCheckSettings {
  const config = vscode.workspace.getConfiguration(CHECK_SECTION);
  return readCheckSettingsFrom(
    {
      enabled: config.inspect('enabled'),
      commands: config.inspect('commands'),
      timeoutSeconds: config.inspect('timeoutSeconds')
    },
    vscode.workspace.isTrusted
  );
}
