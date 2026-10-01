import * as vscode from 'vscode';
import {
  ChangeJournal,
  type ChangeJournalOptions,
  type JournalFs,
  type JournalStorage
} from './journal';

/**
 * The one binding from the real VS Code API to the host-free `ChangeJournal`.
 *
 * All reads and writes go through `vscode.workspace.fs`, so remote and virtual
 * workspaces work and the journal never touches the filesystem directly. Blob
 * content is written under `context.storageUri` (workspace-scoped); the turn
 * index is written to `workspaceState` under `melink.changeJournal`. No file
 * content ever reaches `workspaceState` or `globalState`.
 */
export class VscodeChangeJournal extends ChangeJournal {
  constructor(context: vscode.ExtensionContext, options: Partial<ChangeJournalOptions> = {}) {
    super({
      storage: new MementoJournalStorage(context),
      fs: new VscodeJournalFs(context),
      ...options
    });
  }
}

/** Adapts `context.workspaceState` to the `JournalStorage` seam. */
class MementoJournalStorage implements JournalStorage {
  constructor(private readonly context: vscode.ExtensionContext) {}

  get<T>(key: string, fallback: T): T {
    return this.context.workspaceState.get<T>(key, fallback);
  }

  update(key: string, value: unknown): Thenable<void> {
    return this.context.workspaceState.update(key, value);
  }
}

/**
 * Adapts `vscode.workspace.fs` and `context.storageUri` to the `JournalFs`
 * seam. Blob reads and writes are relative to the workspace-scoped storage
 * root; a read of a missing blob yields `undefined`, never an error.
 */
class VscodeJournalFs implements JournalFs {
  constructor(private readonly context: vscode.ExtensionContext) {}

  workspaceRoots(): readonly string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  }

  async readFile(absPath: string): Promise<Uint8Array | undefined> {
    try {
      return await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
    } catch {
      return undefined;
    }
  }

  async writeBlob(key: string, bytes: Uint8Array): Promise<void> {
    const root = this.storageRoot();
    if (!root) {
      return;
    }
    const uri = vscode.Uri.joinPath(root, ...key.split('/'));
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, bytes);
  }

  async readBlob(key: string): Promise<Uint8Array | undefined> {
    const root = this.storageRoot();
    if (!root) {
      return undefined;
    }
    try {
      return await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, ...key.split('/')));
    } catch {
      return undefined;
    }
  }

  async deleteBlob(key: string): Promise<void> {
    const root = this.storageRoot();
    if (!root) {
      return;
    }
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, ...key.split('/')));
    } catch {
      // A blob that is already gone is not an error.
    }
  }

  /**
   * The storage root for blobs. `storageUri` is workspace-scoped and always set
   * for workspace extensions; a window with none open has no journal to keep.
   */
  private storageRoot(): vscode.Uri | undefined {
    return this.context.storageUri;
  }
}
