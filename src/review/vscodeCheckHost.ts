import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { checkOutputExcerpt, type CheckProcess } from './checks.ts';
import { CHECK_PROCESS_OUTPUT_LIMIT, type CheckManifest, type CheckWorkspaceSource } from './checkHost.ts';
import { CheckStore, type CheckStoreMemento } from './checkStore.ts';

/**
 * The real VS Code bindings for the host-free check lifecycle.
 *
 * Only this file imports `vscode` or `node:child_process` for checks. It reads
 * the first workspace folder's `package.json` through `workspace.fs` (so remote
 * and virtual workspaces work), spawns through the user's shell, and bounds each
 * captured stream before the core ever sees it.
 */

/** The workspace-scoped check-result store backed by `workspaceState`. */
export class VscodeCheckStore extends CheckStore {
  constructor(context: vscode.ExtensionContext) {
    super(memento(context));
  }
}

function memento(context: vscode.ExtensionContext): CheckStoreMemento {
  return {
    get: <T>(key: string): T | undefined => context.workspaceState.get<T>(key),
    update: (key: string, value: unknown): Thenable<void> => context.workspaceState.update(key, value)
  };
}

/** The workspace root and package.json reader used by `CheckHost`. */
export function vscodeCheckWorkspace(): CheckWorkspaceSource {
  return {
    workspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    readManifest: async (root: string): Promise<CheckManifest | undefined> => {
      try {
        const uri = vscode.Uri.joinPath(vscode.Uri.file(root), 'package.json');
        const bytes = await vscode.workspace.fs.readFile(uri);
        return parseManifest(Buffer.from(bytes).toString('utf8'));
      } catch {
        return undefined;
      }
    }
  };
}

/** Parse only the two fields the check planner uses. */
export function parseManifest(text: string): CheckManifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const scripts: Record<string, string> = {};
  const rawScripts = record.scripts;
  if (typeof rawScripts === 'object' && rawScripts !== null && !Array.isArray(rawScripts)) {
    for (const [name, value] of Object.entries(rawScripts as Record<string, unknown>)) {
      if (typeof value === 'string') {
        scripts[name] = value;
      }
    }
  }
  const manifest: CheckManifest = { scripts };
  if (typeof record.packageManager === 'string' && record.packageManager.length > 0) {
    manifest.packageManager = record.packageManager;
  }
  return manifest;
}

/**
 * Spawn one check through the platform shell in the workspace root.
 *
 * Output is capped per stream as it arrives, so a chatty check cannot grow the
 * extension host's memory without bound. The promise always resolves: a spawn
 * failure is reported as an `error` field rather than a rejection.
 */
export function spawnShellCheck(command: string, options: { cwd: string }): CheckProcess {
  const child = spawn(command, {
    cwd: options.cwd,
    shell: true,
    windowsHide: true,
    // A check must never wait on the extension host's stdin: an inherited or
    // piped stdin can block a command that reads it until the timeout fires.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  });
  let stdout = '';
  let stderr = '';
  let settled = false;

  const promise = new Promise<{ code: number | null; stdout: string; stderr: string; error?: string }>(
    (resolve) => {
      const finish = (code: number | null, error?: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({
          code,
          stdout,
          stderr,
          ...(error !== undefined ? { error } : {})
        });
      };
      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr = appendBounded(stderr, chunk);
      });
      child.on('error', (error: Error) => {
        finish(null, error.message || 'The check process failed to start.');
      });
      child.on('close', (code: number | null) => {
        finish(code);
      });
    }
  );

  return {
    promise,
    kill: () => killTree(child)
  };
}

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  if (next.length <= CHECK_PROCESS_OUTPUT_LIMIT) {
    return next;
  }
  return checkOutputExcerpt(next, CHECK_PROCESS_OUTPUT_LIMIT);
}

function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
    killer.on('error', () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    });
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}
