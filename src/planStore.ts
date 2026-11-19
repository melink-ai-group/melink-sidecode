import * as vscode from 'vscode';
import { writeFile } from 'node:fs/promises';
import type { PlanArtifact, TodoStep } from './backends/types';
import {
  PLAN_DIRECTORY,
  canonicalPlanPath,
  createPlanAtAvailablePath,
  planArtifactFromMarkdown,
  planRelativePath,
  renderPlanMarkdown,
  replacePlanStepStatuses
} from './backends/plan';

/**
 * Host-side plan artifact I/O. This is the only place that touches the
 * filesystem for a plan, and it writes exactly one file per thread:
 *
 *     <workspace root>/.melink/plans/<friendly-name>.md
 *
 * The pure naming/rendering/parsing lives in `backends/plan.ts`; this module
 * only resolves the workspace root, creates the directory, and writes the file.
 * Creating that file is the one permitted write in Plan mode — every other write
 * is refused by the read-only sandbox in the adapter. A legacy thread-id file
 * is deleted when the friendly file replaces it.
 */
export class PlanStore {
  private readonly creatingVirtualPlans = new Set<string>();

  /** The workspace root, or `undefined` when no folder is open. */
  private get root(): vscode.Uri | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri : undefined;
  }

  /**
   * Write a thread's plan file, creating the directory if needed. The file
   * name is the plan title. A path the chat already has is reused, so a
   * revision does not create a second plan. A legacy thread-id file is removed
   * when the friendly file replaces it. Returns the artifact so the caller
   * can carry it over the protocol.
   */
  async write(input: {
    threadId: string;
    title: string;
    summary?: string;
    body?: string;
    steps: readonly TodoStep[];
    /** Workspace-relative path already stored for this chat, when it has one. */
    path?: string;
    migratePlaceholder?: boolean;
  }): Promise<PlanArtifact> {
    const chosen = canonicalPlanPath({
      threadId: input.threadId,
      title: input.title,
      existingPath: input.path,
      migratePlaceholder: input.migratePlaceholder ?? false
    });
    const markdown = renderPlanMarkdown({
      title: input.title,
      summary: input.summary,
      body: input.body,
      steps: input.steps
    });
    const root = this.root;
    let path = chosen.path;
    if (root) {
      const dirUri = vscode.Uri.joinPath(root, PLAN_DIRECTORY);
      await vscode.workspace.fs.createDirectory(dirUri);
      const bytes = Buffer.from(markdown, 'utf8');
      if (path !== input.path?.replace(/\\/g, '/')) {
        path = await createPlanAtAvailablePath(path, (candidate) =>
          this.tryCreatePlan(vscode.Uri.joinPath(root, candidate), bytes)
        );
      } else {
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, path), bytes);
      }
      if (chosen.retire && chosen.retire !== path) {
        try {
          await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, chosen.retire));
        } catch {
          // The duplicate was already gone.
        }
      }
    }
    return planArtifactFromMarkdown({
      path,
      markdown,
      fallbackTitle: input.title,
      updatedAt: Date.now()
    });
  }

  private async tryCreatePlan(uri: vscode.Uri, contents: Uint8Array): Promise<boolean> {
    if (uri.scheme === 'file') {
      try {
        await writeFile(uri.fsPath, contents, { flag: 'wx' });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          return false;
        }
        throw error;
      }
    }
    const key = uri.toString();
    if (this.creatingVirtualPlans.has(key)) {
      return false;
    }
    this.creatingVirtualPlans.add(key);
    try {
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(uri, { contents, overwrite: false });
      if (await vscode.workspace.applyEdit(edit)) {
        return true;
      }
      // A rejected edit is a collision only when the candidate exists.
      await vscode.workspace.fs.stat(uri);
      return false;
    } finally {
      this.creatingVirtualPlans.delete(key);
    }
  }

  /**
   * Remove a thread's plan file, including a legacy thread-id copy. A missing
   * file is not an error. Pass `path` when the chat's file is the friendly name.
   */
  async remove(threadId: string, path?: string): Promise<void> {
    const root = this.root;
    if (!root) {
      return;
    }
    const paths = new Set<string>([planRelativePath(threadId)]);
    if (path) {
      paths.add(path.replace(/\\/g, '/'));
    }
    for (const relative of paths) {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, relative));
      } catch {
        // Already gone.
      }
    }
  }

  async writeStepStatuses(path: string, previous: readonly TodoStep[], steps: readonly TodoStep[]): Promise<string | undefined> {
    const uri = this.planUri(path);
    if (!uri) {
      return undefined;
    }
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      return undefined;
    }
    const version = document.version;
    const markdown = document.getText();
    const saved = await this.readMarkdown(path);
    if (document.isDirty || document.version !== version || saved?.replace(/^\uFEFF/, '') !== markdown) {
      return undefined;
    }
    const updated = replacePlanStepStatuses(markdown, previous, steps);
    if (updated === undefined || updated === markdown) {
      return updated;
    }
    const edit = new vscode.WorkspaceEdit();
    const lines = updated.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const original = document.lineAt(index);
      if (original.text !== lines[index]) {
        edit.replace(uri, original.range, lines[index]);
      }
    }
    // VS Code attaches the open document version to the workspace edit.
    // Saving through that same document also honors disk save conflicts.
    if (!await vscode.workspace.applyEdit(edit) || await this.readMarkdown(path) !== saved ||
        document.version !== version + 1 || document.getText() !== updated || !await document.save()) {
      return undefined;
    }
    const persisted = await this.readMarkdown(path);
    return persisted?.replace(/^\uFEFF/, '') === updated ? persisted : undefined;
  }

  async readMarkdown(relative: string): Promise<string | undefined> {
    const uri = this.planUri(relative);
    if (!uri) {
      return undefined;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return undefined;
    }
  }

  private planUri(relative: string): vscode.Uri | undefined {
    const root = this.root;
    relative = relative.replace(/\\/g, '/');
    if (!root || !relative.startsWith(PLAN_DIRECTORY + '/') ||
        !/^[^/]+\.md$/i.test(relative.slice(PLAN_DIRECTORY.length + 1))) {
      return undefined;
    }
    return vscode.Uri.joinPath(root, relative);
  }
}
