import * as vscode from 'vscode';
import type { ChangeStatus } from '../backends/types';
import { ChangeWatchSession } from './watchSession';
import type { ChangeTracker } from './tracker';

/**
 * The one binding from the real VS Code filesystem watcher to the host-free
 * `ChangeTracker`.
 *
 * An agent can change files without emitting a structured edit event (a
 * formatter, `git apply`, or codegen invoked through the shell). This watcher is
 * the fallback that still sees those writes. It is:
 *
 * - **Workspace-scoped** — only paths inside an open workspace folder are
 *   reported (enforced in the host-free `ChangeWatchSession`); a path the agent
 *   writes elsewhere is ignored.
 * - **Debounced** — a burst of writes (a formatter touching many files) is
 *   coalesced before it reaches the tracker, so the journal is not hammered once
 *   per filesystem event.
 * - **Turn-scoped** — started when a turn begins and disposed when it ends, so
 *   no watcher outlives the turn, and disposed again on extension deactivate.
 *
 * All the decisions live in `ChangeWatchSession`; this class only creates the
 * real watcher and wires its events into that session.
 */
export class WorkspaceChangeWatcher {
  private watcher?: vscode.FileSystemWatcher;
  private session?: ChangeWatchSession;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly tracker: ChangeTracker,
    private readonly debounceMs?: number
  ) {}

  /**
   * Begin watching for the active turn. Idempotent: a second call while already
   * watching is a no-op, so a duplicate turn/started cannot create a second
   * watcher or a second session.
   */
  start(): void {
    if (this.watcher) {
      return;
    }
    const session = new ChangeWatchSession({
      workspaceRoots: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      onObserve: (absPath, status) => this.tracker.watch(absPath, status),
      ...(this.debounceMs !== undefined ? { debounceMs: this.debounceMs } : {})
    });
    this.session = session;
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.watcher = watcher;
    this.disposables.push(
      // A non-file scheme has no workspace path to diff; the session drops it.
      watcher.onDidCreate((uri) => this.observe(uri, 'created')),
      watcher.onDidChange((uri) => this.observe(uri, 'modified')),
      watcher.onDidDelete((uri) => this.observe(uri, 'deleted')),
      watcher
    );
  }

  /**
   * Stop watching and flush anything debounced but not yet recorded, so a change
   * observed just before the turn ended is not lost. Safe to call when not
   * watching, and safe to call twice.
   */
  stop(): void {
    this.session?.stop();
    this.session = undefined;
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.watcher = undefined;
  }

  /** Alias so the host can register this with `context.subscriptions`. */
  dispose(): void {
    this.stop();
  }

  private observe(uri: vscode.Uri, status: ChangeStatus): void {
    if (uri.scheme !== 'file') {
      return;
    }
    this.session?.observe(uri.fsPath, status);
  }
}
