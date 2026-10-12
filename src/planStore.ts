import * as vscode from 'vscode';
import type { PlanArtifact, TodoStep } from './backends/types';
import {
  PLAN_DIRECTORY,
  canonicalPlanPath,
  planArtifactFromMarkdown,
  planRelativePath,
  renderPlanMarkdown
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
  }): Promise<PlanArtifact> {
    const chosen = canonicalPlanPath({
      threadId: input.threadId,
      title: input.title,
      existingPath: input.path
    });
    const markdown = renderPlanMarkdown({
      title: input.title,
      summary: input.summary,
      body: input.body,
      steps: input.steps
    });
    const root = this.root;
    if (root) {
      const fileUri = vscode.Uri.joinPath(root, chosen.path);
      const dirUri = vscode.Uri.joinPath(root, PLAN_DIRECTORY);
      await vscode.workspace.fs.createDirectory(dirUri);
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(markdown, 'utf8'));
      const extras = new Set<string>();
      if (chosen.retire && chosen.retire !== chosen.path) {
        extras.add(chosen.retire);
      }
      const threadPath = planRelativePath(input.threadId);
      if (threadPath !== chosen.path) {
        extras.add(threadPath);
      }
      for (const extra of extras) {
        try {
          await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, extra));
        } catch {
          // The duplicate was already gone.
        }
      }
    }
    return planArtifactFromMarkdown({
      path: chosen.path,
      markdown,
      fallbackTitle: input.title,
      updatedAt: Date.now()
    });
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

  /**
   * Read a thread's plan file if it exists, parsed into the artifact shape.
   * Returns `undefined` when the file is absent, so a missing plan degrades to
   * "no plan" rather than an error. `path` is the friendly file when the chat
   * has one; otherwise the legacy thread-id path is read.
   */
  async read(threadId: string, path?: string): Promise<PlanArtifact | undefined> {
    const root = this.root;
    if (!root) {
      return undefined;
    }
    const relative = path?.replace(/\\/g, '/') || planRelativePath(threadId);
    const fileUri = vscode.Uri.joinPath(root, relative);
    try {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      const markdown = Buffer.from(bytes).toString('utf8');
      return planArtifactFromMarkdown({
        path: relative,
        markdown,
        fallbackTitle: 'Plan',
        updatedAt: Date.now()
      });
    } catch {
      return undefined;
    }
  }
}
