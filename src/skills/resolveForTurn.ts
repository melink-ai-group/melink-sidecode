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
import { readAstGrepCliSource, resolveAstGrepExecutable } from '../backends/astGrep/resolve.ts';
import { readZvecGrepCliSource, resolveZvecGrepExecutable } from '../backends/zvecGrep/resolve.ts';
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
}

export async function skillMcpForOpencodeTurn(options: {
  extensionPath: string;
  globalStoragePath: string;
}): Promise<SkillMcpForTurn> {
  const config = vscode.workspace.getConfiguration();
  const roots = {
    extensionPath: options.extensionPath,
    globalStoragePath: options.globalStoragePath
  };

  const zvecEnabled = skillEnabled(config, `${SKILLS_SECTION}.zvecGrep`, LEGACY_ZVEC);
  const astEnabled = config.get<boolean>(`${SKILLS_SECTION}.astGrep`, false) === true;

  let zvecServer: OpencodeLocalMcpServer | undefined;
  let astServer: OpencodeLocalMcpServer | undefined;

  if (zvecEnabled) {
    const source = readZvecGrepCliSource(config.get<unknown>(`${SKILLS_SECTION}.zvecGrep.cliSource`));
    const path = config.get<string>(`${SKILLS_SECTION}.zvecGrep.path`, 'zg') || 'zg';
    const executable = resolveZvecGrepExecutable({ source, path, roots });
    zvecServer = zvecGrepOpencodeServer(executable);
  }

  if (astEnabled) {
    const source = readAstGrepCliSource(config.get<unknown>(`${SKILLS_SECTION}.astGrep.cliSource`));
    const path = config.get<string>(`${SKILLS_SECTION}.astGrep.path`, 'ast-grep') || 'ast-grep';
    const executable = resolveAstGrepExecutable({ source, path, roots });
    const mcpScript = astGrepMcpScriptPath(options.extensionPath);
    if (existsSync(mcpScript)) {
      astServer = astGrepOpencodeServer({
        mcpScriptPath: mcpScript,
        astGrepExecutable: executable
      });
    }
  }

  return {
    mcp: mergeSkillOpencodeMcp(undefined, { zvecGrep: zvecServer, astGrep: astServer }),
    permissions: skillPermissionKeys({
      zvecGrep: Boolean(zvecServer),
      astGrep: Boolean(astServer)
    })
  };
}

function skillEnabled(
  config: vscode.WorkspaceConfiguration,
  key: string,
  legacyKey: string
): boolean {
  const inspected = config.inspect<boolean>(key);
  if (
    inspected?.globalValue !== undefined ||
    inspected?.workspaceValue !== undefined ||
    inspected?.workspaceFolderValue !== undefined
  ) {
    return config.get<boolean>(key, false) === true;
  }
  return config.get<boolean>(legacyKey, false) === true;
}
