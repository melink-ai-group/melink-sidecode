import * as vscode from 'vscode';
import { ChangeStore, type ChangeStoreOptions, type ChangeWorkspaceFs } from './changeStore';
import type { JournalStorage } from './journal';

/**
 * The one binding from the real VS Code API to the host-free `ChangeStore`.
 *
 * Decisions are workspace-scoped (`workspaceState`), matching the journal index
 * they annotate: a decision about a turn in this workspace has no meaning in
 * another. File reads and writes go through `vscode.workspace.fs`, so remote and
 * virtual workspaces work and no direct `fs` is ever used; a reject writes a
 * workspace file, which is exactly the one write this feature is allowed to make.
 */
export class VscodeChangeStore extends ChangeStore {
  constructor(context: vscode.ExtensionContext, options: Omit<ChangeStoreOptions, 'storage' | 'fs'>) {
    super({
      storage: new MementoDecisionStorage(context),
      fs: new VscodeWorkspaceFs(),
      ...options
    });
  }
}

/** Adapts `context.workspaceState` to the store's storage seam. */
class MementoDecisionStorage implements JournalStorage {
  constructor(private readonly context: vscode.ExtensionContext) {}

  get<T>(key: string, fallback: T): T {
    return this.context.workspaceState.get<T>(key, fallback);
  }

  update(key: string, value: unknown): Thenable<void> {
    return this.context.workspaceState.update(key, value);
  }
}

/** The workspace file seam, bound to `vscode.workspace.fs`. */
export class VscodeWorkspaceFs implements ChangeWorkspaceFs {
  async readFile(absPath: string): Promise<Uint8Array | undefined> {
    try {
      return await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
    } catch {
      return undefined;
    }
  }

  async writeFile(absPath: string, bytes: Uint8Array): Promise<void> {
    // `workspace.fs.writeFile` creates parent directories as needed, so a
    // recreated delete whose folder was also removed is still restorable.
    await vscode.workspace.fs.writeFile(vscode.Uri.file(absPath), bytes);
  }

  async deleteFile(absPath: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(absPath));
    } catch (error) {
      // A file already gone is the desired end state, not a failure.
      if (isMissing(error)) {
        return;
      }
      throw error;
    }
  }
}

/** True for a VS Code file-not-found failure, which a delete treats as success. */
function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === 'FileNotFound' || code === 'ENOENT';
}
