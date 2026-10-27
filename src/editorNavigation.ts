import * as path from 'node:path';
import * as vscode from 'vscode';

/** One file the chat points at, with an optional 1-based position. */
export interface FileTarget {
  path: string;
  line?: number;
  column?: number;
}

const HTTP_URL = /^https?:\/\//i;

/** True only for an absolute http(s) address with a host. */
export function isHttpUrl(value: string): boolean {
  if (!HTTP_URL.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host.length > 0;
  } catch {
    return false;
  }
}

/**
 * Open one file in the editor. A workspace-relative path is resolved inside the
 * workspace folders; an absolute path is used as written. A file that no longer
 * exists is a no-op, so a stale reference never opens an empty editor.
 */
export async function openFileInEditor(target: FileTarget): Promise<boolean> {
  const uri = await locateFile(target.path);
  if (!uri) {
    return false;
  }
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    const options: vscode.TextDocumentShowOptions = { preview: true };
    if (target.line !== undefined) {
      const line = clamp(target.line - 1, 0, Math.max(document.lineCount - 1, 0));
      const textLine = document.lineAt(line);
      const column = clamp((target.column ?? 1) - 1, 0, textLine.text.length);
      const position = new vscode.Position(line, column);
      options.selection = new vscode.Range(position, position);
    }
    await vscode.window.showTextDocument(document, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open one http(s) page in the editor's internal browser (Simple Browser).
 * A host without that command falls back to the user's default browser.
 */
export async function openUrlInInternalBrowser(url: string): Promise<boolean> {
  if (!isHttpUrl(url)) {
    return false;
  }
  try {
    await vscode.commands.executeCommand('simpleBrowser.show', url);
    return true;
  } catch {
    try {
      return await vscode.env.openExternal(vscode.Uri.parse(url, true));
    } catch {
      return false;
    }
  }
}

async function locateFile(value: string): Promise<vscode.Uri | undefined> {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (path.isAbsolute(trimmed)) {
    const uri = vscode.Uri.file(trimmed);
    return (await exists(uri)) ? uri : undefined;
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const candidate = path.join(folder.uri.fsPath, trimmed);
    const relative = path.relative(folder.uri.fsPath, candidate);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      continue;
    }
    const uri = vscode.Uri.file(candidate);
    if (await exists(uri)) {
      return uri;
    }
  }
  return undefined;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}
