import * as vscode from 'vscode';
import type { ChangeStatus } from '../backends/types';
import type { JournalTurn } from './journal';
import {
  MELINK_CHANGES_SCHEME,
  OPEN_CHANGE_DIFF_COMMAND,
  OPEN_TURN_CHANGES_COMMAND,
  REVEAL_CHANGE_IN_SCM_COMMAND,
  changesViewRow,
  diffSides,
  parseVirtualDocument,
  resolveVirtualContent,
  virtualUriParts,
  type DiffSide
} from './nativeDiff';

/**
 * The one binding from the real VS Code API to the host-free `nativeDiff` core.
 *
 * The sidebar renders a summary and a decision; reading a whole diff is handed
 * to the workbench, which already ships the multi-file changes editor and the
 * single-file diff view. This service is the host-owned half:
 *
 * - a `TextDocumentContentProvider` on `melink-changes:` serves the journal's
 *   pre-turn content read-only, so the diff has a real left-hand side without
 *   writing a single temp file to the workspace;
 * - `vscode.diff` opens one file against the working tree;
 * - `vscode.changes` opens the whole turn as a navigable multi-file view, with
 *   `workbench.openMultiDiffEditor` as a secondary route and a Source Control
 *   reveal as the final fallback;
 * - the three command ids are registered here, so t5's `Open in editor`
 *   affordance has a real target. Every path degrades to a no-op with an
 *   explanatory message instead of throwing.
 *
 * The provider is disposed with this service on deactivate, so no content
 * provider leaks across a window reload.
 */

/** The recorded-artifact read seam, satisfied by `ChangeJournal`. */
export interface DiffArtifacts {
  getTurn(turnId: string): JournalTurn | undefined;
  getBefore(turnId: string, relPath: string): Promise<Uint8Array | undefined>;
}

/** Open one changed file's pre-turn vs working diff. */
export interface OpenChangeDiffInput {
  turnId: string;
  /** Workspace-relative, POSIX-separated path. */
  relPath: string;
  /** Absolute working path, used only when the turn is no longer recorded. */
  absPath?: string;
}

/** Open the whole turn in the multi-file changes editor. */
export interface OpenTurnChangesInput {
  turnId: string;
  title?: string;
}

/** A host-side outcome, so the caller can decide whether to explain a failure. */
export interface NativeDiffResult {
  ok: boolean;
  /** Plain-language reason a path degraded, when it did. */
  message?: string;
}

const DEFAULT_TURN_TITLE = 'Changes this turn';

/**
 * Serves `melink-changes:` documents from the journal. A `before` side is the
 * stored pre-turn content (empty when it was never stored, so a diff still
 * opens); an `empty` side is the empty document. A malformed URI serves empty
 * rather than throwing.
 */
class ChangesContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly artifacts: DiffArtifacts) {}

  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const document = parseVirtualDocument({ path: uri.path, query: uri.query });
    if (!document) {
      return Promise.resolve('');
    }
    // The provider is read-only by construction: VS Code has no write route to
    // this scheme, so a virtual document cannot be saved back to the workspace.
    return resolveVirtualContent(document, (turnId, relPath) => this.artifacts.getBefore(turnId, relPath));
  }
}

export class NativeDiffService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly artifacts: DiffArtifacts) {
    const provider = new ChangesContentProvider(artifacts);
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(MELINK_CHANGES_SCHEME, provider),
      vscode.commands.registerCommand(OPEN_CHANGE_DIFF_COMMAND, (input: OpenChangeDiffInput) =>
        this.openChangeDiff(input)
      ),
      vscode.commands.registerCommand(OPEN_TURN_CHANGES_COMMAND, (input: OpenTurnChangesInput) =>
        this.openTurnChanges(input)
      ),
      vscode.commands.registerCommand(REVEAL_CHANGE_IN_SCM_COMMAND, (absPath?: string) =>
        this.revealInSourceControl(absPath)
      )
    );
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  /**
   * Open one file's diff: the journal's pre-turn content on the left and the
   * working file on the right. A created file has an empty left; a deleted file
   * has an empty right; a file whose before content was not stored falls back to
   * an empty left. When the turn is gone, the working file is opened instead.
   */
  async openChangeDiff(input: OpenChangeDiffInput): Promise<NativeDiffResult> {
    const entry = this.entryFor(input.turnId, input.relPath);
    if (!entry) {
      if (input.absPath) {
        await this.openWorkingFile(input.absPath);
        return {
          ok: true,
          message: 'This turn is no longer recorded, so the working file was opened without its pre-turn side.'
        };
      }
      return this.report('That change is no longer recorded, so its diff cannot be opened.');
    }

    const sides = diffSides(entry);
    const left = this.toUri(input.turnId, entry.relPath, sides.left, entry.absPath);
    const right = this.toUri(input.turnId, entry.relPath, sides.right, entry.absPath);
    const title = diffTitle(entry.relPath, entry.status);
    try {
      await vscode.commands.executeCommand('vscode.diff', left, right, title);
      return { ok: true };
    } catch {
      return this.report('The built-in diff view is unavailable, so the change could not be opened here.');
    }
  }

  /**
   * Open the whole turn as a multi-file changes view, listing every changed
   * path so the user can walk file to file the way Source Control does.
   */
  async openTurnChanges(input: OpenTurnChangesInput): Promise<NativeDiffResult> {
    const turn = this.artifacts.getTurn(input.turnId);
    if (!turn || turn.files.length === 0) {
      return this.report('That turn has no recorded changes to open.');
    }

    const rows = turn.files.map((entry) => ({
      input: {
        status: entry.status,
        hasBefore: entry.hasBefore,
        hasAfter: entry.hasAfter
      },
      entry
    }));
    const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = rows.map(({ input: sideInput, entry }) => {
      const row = changesViewRow(sideInput);
      return [
        this.toUri(turn.turnId, entry.relPath, row.label, entry.absPath),
        this.toUri(turn.turnId, entry.relPath, row.original, entry.absPath),
        this.toUri(turn.turnId, entry.relPath, row.modified, entry.absPath)
      ];
    });

    const title = input.title ?? DEFAULT_TURN_TITLE;
    // `vscode.changes` is the documented multi-file entry point. The internal
    // `_workbench.openMultiDiffEditor` is a secondary route on hosts that do not
    // register it; when neither resolves, focus Source Control and explain.
    try {
      await vscode.commands.executeCommand('vscode.changes', title, resources);
      return { ok: true };
    } catch {
      // Fall through to the internal command.
    }
    try {
      await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
        title,
        resources: rows.map(({ input: sideInput, entry }) => {
          const row = changesViewRow(sideInput);
          return {
            originalUri: this.toUri(turn.turnId, entry.relPath, row.original, entry.absPath),
            modifiedUri: this.toUri(turn.turnId, entry.relPath, row.modified, entry.absPath)
          };
        })
      });
      return { ok: true };
    } catch {
      await this.revealInSourceControl(turn.files[0]?.absPath);
      return {
        ok: false,
        message: 'The multi-file changes view is unavailable, so Source Control was opened instead.'
      };
    }
  }

  /**
   * The fallback affordance: focus the built-in Source Control view. The turn's
   * changes are not a source-control provider, so no row is added; the message
   * says so rather than pretending. A known path is named so the explanation is
   * specific, and a host without the SCM view still degrades to a message.
   */
  async revealInSourceControl(absPath?: string): Promise<NativeDiffResult> {
    await this.tryExecute('workbench.view.scm');
    const message = absPath
      ? `Opened Source Control. ${absPath} is from this turn, not a source-control provider, so it is not listed there.`
      : 'Opened Source Control. A turn\u2019s changes are not a source-control provider, so they are not listed there.';
    return { ok: true, message };
  }

  /** The recorded entry for a turn and path, or `undefined`. */
  private entryFor(turnId: string, relPath: string) {
    const turn = this.artifacts.getTurn(turnId);
    const target = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
    return turn?.files.find((file) => file.relPath === target);
  }

  /**
   * The real URI for a diff side: the working file, the journal's pre-turn
   * virtual document, or the empty virtual document. A deleted file has no
   * working path, and `absPath` is still its pre-turn path; a `file` side that
   * does not exist opens as a missing file rather than failing the command.
   */
  private toUri(
    turnId: string,
    relPath: string,
    side: DiffSide,
    absPath: string
  ): vscode.Uri {
    if (side.kind === 'file') {
      return vscode.Uri.file(absPath);
    }
    return vscode.Uri.from({ scheme: MELINK_CHANGES_SCHEME, ...virtualUriParts({ turnId, relPath, side: side.side }) });
  }

  private async openWorkingFile(absPath: string): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
      await vscode.window.showTextDocument(document, { preview: true });
    } catch {
      // A path that no longer exists is a no-op; the message already names it.
    }
  }

  /** Show an explanatory message and report the degradation, never throw. */
  private async report(message: string): Promise<NativeDiffResult> {
    await vscode.window.showWarningMessage(message);
    return { ok: false, message };
  }

  private async tryExecute(command: string, ...args: unknown[]): Promise<void> {
    try {
      await vscode.commands.executeCommand(command, ...args);
    } catch {
      // A host that does not register the command degrades to a no-op.
    }
  }
}

/** A human title for a diff, honest about the status being shown. */
function diffTitle(relPath: string, status: ChangeStatus): string {
  const label = status === 'created' ? 'new' : status === 'deleted' ? 'deleted' : status === 'renamed' ? 'renamed' : 'modified';
  return `${relPath} (${label} this turn)`;
}
