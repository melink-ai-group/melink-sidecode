import * as vscode from 'vscode';
import type { PlanArtifact, TodoStep } from './backends/types';
import {
  PLAN_DIRECTORY,
  planArtifactFromMarkdown,
  planRelativePath,
  renderPlanMarkdown
} from './backends/plan';

/**
 * Host-side plan artifact I/O. This is the only place that touches the
 * filesystem for a plan, and it writes exactly one file per thread:
 *
 *     <workspace root>/.melink/plans/<thread-id>.md
 *
 * The pure naming/rendering/parsing lives in `backends/plan.ts`; this module
 * only resolves the workspace root, creates the directory, and writes the file.
 * Creating that file is the one permitted write in Plan mode — every other write
 * is refused by the read-only sandbox in the adapter.
 */
export class PlanStore {
  /** The workspace root, or `undefined` when no folder is open. */
  private get root(): vscode.Uri | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri : undefined;
  }

  /**
   * Write a thread's plan file, creating the directory if needed. A revision
   * writes the same path because the path is derived from the thread id, so a
   * second plan is never created. Returns the artifact (path, title, steps) so
   * the caller can carry it over the protocol.
   */
  async write(input: {
    threadId: string;
    title: string;
    summary?: string;
    body?: string;
    steps: readonly TodoStep[];
  }): Promise<PlanArtifact> {
    const relative = planRelativePath(input.threadId);
    const markdown = renderPlanMarkdown({
      title: input.title,
      summary: input.summary,
      body: input.body,
      steps: input.steps
    });
    const root = this.root;
    if (root) {
      const fileUri = vscode.Uri.joinPath(root, relative);
      const dirUri = vscode.Uri.joinPath(root, PLAN_DIRECTORY);
      await vscode.workspace.fs.createDirectory(dirUri);
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(markdown, 'utf8'));
    }
    return planArtifactFromMarkdown({
      path: relative,
      markdown,
      fallbackTitle: input.title,
      updatedAt: Date.now()
    });
  }

  /**
   * Read a thread's plan file if it exists, parsed into the artifact shape.
   * Returns `undefined` when the file is absent, so a missing plan degrades to
   * "no plan" rather than an error.
   */
  async read(threadId: string): Promise<PlanArtifact | undefined> {
    const root = this.root;
    if (!root) {
      return undefined;
    }
    const relative = planRelativePath(threadId);
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
