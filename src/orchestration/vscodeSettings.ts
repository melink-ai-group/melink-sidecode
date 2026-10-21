import * as vscode from 'vscode';
import {
  LEGACY_REVIEWING_KEY,
  LEGACY_TESTING_KEY,
  ORCHESTRATION_SECTION,
  resolveOrchestrationSettings,
  type ResolvedOrchestrationSettings
} from './settings.ts';

/** The thin VS Code binding for the per-turn orchestration policy. */
export function readOrchestrationSettings(): ResolvedOrchestrationSettings {
  const config = vscode.workspace.getConfiguration();
  const inspect = (key: string): ReturnType<vscode.WorkspaceConfiguration['inspect']> =>
    config.inspect<boolean>(key);
  return resolveOrchestrationSettings({
    testing: inspect(`${ORCHESTRATION_SECTION}.testing`),
    reviewing: inspect(`${ORCHESTRATION_SECTION}.reviewing`),
    doubleCheck: inspect(`${ORCHESTRATION_SECTION}.doubleCheck`),
    quickTask: inspect(`${ORCHESTRATION_SECTION}.quickTask`),
    planning: inspect(`${ORCHESTRATION_SECTION}.planning`),
    legacyTesting: inspect(LEGACY_TESTING_KEY),
    legacyReviewing: inspect(LEGACY_REVIEWING_KEY)
  });
}
