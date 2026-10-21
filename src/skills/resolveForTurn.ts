import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import {
  astGrepMcpScriptPath,
  astGrepOpencodeServer,
  mergeSkillOpencodeMcp,
  skillPermissionKeys,
  zvecGrepOpencodeServer,
  type OpencodeLocalMcpServer
} from './opencodeMcp.ts';
import { resolveAstGrepExecutable } from '../backends/astGrep/resolve.ts';
import { resolveZvecGrepExecutable } from '../backends/zvecGrep/resolve.ts';
import {
  readTrustedAstGrepCliSource,
  readTrustedAstGrepPath,
  readTrustedZvecGrepCliSource,
  readTrustedZvecGrepPath
} from '../config/settings.ts';
import { trustedBoolean } from '../config/trust.ts';
import { SKILLS_SECTION } from '../settingsKeys';

const LEGACY_ZVEC = 'melink.ollama.opencode.zvecGrep';

/**
 * Skill MCP servers and permission keys for one OpenCode turn.
 *
 * Injected into OPENCODE_CONFIG_CONTENT when the skill is enabled in settings,
 * using absolute paths for bundled CLIs so PATH is not required.
 */

export interface SkillMcpForTurn {
  mcp?: Record<string, unknown>;
  permissions: Record<string, 'allow'>;
  /** True when the ast-grep server is injected; its eplace is level-gated. */
  astGrep: boolean;
}

export async function skillMcpForOpencodeTurn(options: {
  extensionPath: string;
  globalStoragePath: string;
  /** Defaults to the first workspace folder; the shim confines paths to it. */
  workspaceRoot?: string;
}): Promise<SkillMcpForTurn> {
  const config = vscode.workspace.getConfiguration();
  const roots = {
    extensionPath: options.extensionPath,
    globalStoragePath: options.globalStoragePath
  };
  const workspaceRoot =
    options.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const zvecEnabled = skillEnabled(config, `${SKILLS_SECTION}.zvecGrep`, LEGACY_ZVEC);
  const astEnabled = trustedBoolean(config.inspect<boolean>(`${SKILLS_SECTION}.astGrep`), false);

  let zvecServer: OpencodeLocalMcpServer | undefined;
  let astServer: OpencodeLocalMcpServer | undefined;

  if (zvecEnabled) {
    // The source and the path come from the user's own settings only, so a
    // workspace cannot choose the binary the skill runs.
    const source = readTrustedZvecGrepCliSource();
    const path = readTrustedZvecGrepPath();
    const executable = resolveZvecGrepExecutable({ source, path, roots });
    zvecServer = zvecGrepOpencodeServer(executable);
  }

  if (astEnabled) {
    const source = readTrustedAstGrepCliSource();
    const path = readTrustedAstGrepPath();
    const executable = resolveAstGrepExecutable({ source, path, roots });
    const mcpScript = astGrepMcpScriptPath(options.extensionPath);
    if (existsSync(mcpScript)) {
      astServer = astGrepOpencodeServer({
        mcpScriptPath: mcpScript,
        astGrepExecutable: executable,
        ...(workspaceRoot ? { workspaceRoot } : {})
      });
    }
  }

  return {
    mcp: mergeSkillOpencodeMcp(undefined, { zvecGrep: zvecServer, astGrep: astServer }),
    permissions: skillPermissionKeys({
      zvecGrep: Boolean(zvecServer),
      astGrep: Boolean(astServer)
    }),
    astGrep: Boolean(astServer)
  };
}

function skillEnabled(
  config: vscode.WorkspaceConfiguration,
  key: string,
  legacyKey: string
): boolean {
  const inspected = config.inspect<boolean>(key);
  if (inspected?.globalValue !== undefined) {
    return trustedBoolean(inspected, false);
  }
  return trustedBoolean(config.inspect<boolean>(legacyKey), false);
}
