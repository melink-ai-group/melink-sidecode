import * as vscode from 'vscode';
import type { ChangeStatus } from '../backends/types';
import { filterListedFiles } from './ignore';
import type { JournalFileEntry, JournalTurn } from './journal';
import { sessionChangeSet, type SessionFile } from './sessionFiles';
import {
  MELINK_CHANGES_SCHEME,
  OPEN_CHANGE_DIFF_COMMAND,
  OPEN_TURN_CHANGES_COMMAND,
  REVEAL_CHANGE_IN_SCM_COMMAND,
  changesViewRow,
  diffSides,
  hasBaseline,
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
  listTurns(threadId: string): JournalTurn[];
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
const DEFAULT_SESSION_TITLE = 'Changes this session';

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
   * has an empty right. A modification with no stored pre-turn snapshot is not
   * opened against an empty left (that paints the whole file as added); the
   * working file is opened instead. When the turn is gone, the working file is
   * opened instead.
   */
  async openChangeDiff(input: OpenChangeDiffInput): Promise<NativeDiffResult> {
    const resolved = this.sessionFile(input.turnId, input.relPath);
    const entry = resolved?.entry;
    if (!entry || !resolved) {
      if (input.absPath) {
        await this.openWorkingFile(input.absPath);
        return {
          ok: true,
          message: 'This turn is no longer recorded, so the working file was opened without its pre-turn side.'
        };
      }
      return this.report('That change is no longer recorded, so its diff cannot be opened.');
    }

    const sideInput = { status: entry.status, hasBefore: entry.hasBefore, hasAfter: entry.hasAfter };
    if (!hasBaseline(sideInput)) {
      if (entry.absPath) {
        await this.openWorkingFile(entry.absPath);
      }
      return {
        ok: true,
        message: 'No pre-change snapshot was recorded, so the file was opened instead of a diff that would mark every line as added.'
      };
    }

    const sides = diffSides(sideInput);
    const left = this.sideUri(resolved, sides.left);
    const right = this.sideUri(resolved, sides.right);
    const title = diffTitle(entry.relPath, entry.status, this.sessionScope(input.turnId));
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
    const recorded = this.sessionFiles(input.turnId);
    const files = recorded ? await listedSessionFiles(recorded) : undefined;
    if (!files || files.length === 0) {
      return this.report('That turn has no recorded changes to open.');
    }

    const rows = files
      .filter((file) =>
        hasBaseline({ status: file.entry.status, hasBefore: file.entry.hasBefore, hasAfter: file.entry.hasAfter })
      )
      .map((file) => ({
        input: {
          status: file.entry.status,
          hasBefore: file.entry.hasBefore,
          hasAfter: file.entry.hasAfter
        },
        file
      }));
    if (rows.length === 0) {
      return {
        ok: false,
        message: 'No pre-change snapshot was recorded, so the files were not opened as whole-file additions.'
      };
    }
    const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = rows.map(({ input: sideInput, file }) => {
      const row = changesViewRow(sideInput);
      return [
        this.sideUri(file, row.label),
        this.sideUri(file, row.original),
        this.sideUri(file, row.modified)
      ];
    });

    const title = input.title ?? (this.sessionScope(input.turnId) === 'session' ? DEFAULT_SESSION_TITLE : DEFAULT_TURN_TITLE);
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
        resources: rows.map(({ input: sideInput, file }) => {
          const row = changesViewRow(sideInput);
          return {
            originalUri: this.sideUri(file, row.original),
            modifiedUri: this.sideUri(file, row.modified)
          };
        })
      });
      return { ok: true };
    } catch {
      await this.revealInSourceControl(files[0]?.entry.absPath);
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

  /** The session row for a path, or that turn's own row when it is not the latest. */
  private sessionFile(turnId: string, relPath: string): SessionFile | undefined {
    const target = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
    return this.sessionFiles(turnId)?.find((file) => file.entry.relPath === target);
  }

  /**
   * Files the review should open. The newest observed turn stands for the
   * whole thread, so Review lists every step. An older turn id opens only that
   * turn.
   */
  private sessionFiles(turnId: string): SessionFile[] | undefined {
    const turn = this.artifacts.getTurn(turnId);
    if (!turn) {
      return undefined;
    }
    const session = sessionChangeSet(this.artifacts.listTurns(turn.threadId));
    if (session && session.turnId === turnId) {
      return session.files;
    }
    return turn.files.map((entry) => this.singleTurnFile(turn.turnId, entry));
  }

  private sessionScope(turnId: string): 'turn' | 'session' {
    const turn = this.artifacts.getTurn(turnId);
    if (!turn) {
      return 'turn';
    }
    const observed = this.artifacts.listTurns(turn.threadId).filter((entry) => entry.observed);
    return observed.length > 1 && observed[0]?.turnId === turnId ? 'session' : 'turn';
  }

  private singleTurnFile(turnId: string, entry: JournalFileEntry): SessionFile {
    return {
      entry,
      ...(entry.hasBefore ? { beforeTurnId: turnId, beforeRelPath: entry.relPath } : {})
    };
  }

  /** A diff side URI. The baseline is read from the turn that stored it. */
  private sideUri(file: SessionFile, side: DiffSide): vscode.Uri {
    const before = side.kind === 'virtual' && side.side === 'before';
    return this.toUri(
      before ? file.beforeTurnId ?? '' : '',
      before ? file.beforeRelPath ?? file.entry.relPath : file.entry.relPath,
      side,
      file.entry.absPath
    );
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

/** The same rows the review page shows: no binaries, no gitignored paths. */
async function listedSessionFiles(files: readonly SessionFile[]): Promise<SessionFile[]> {
  const listed = await filterListedFiles(
    files.map((file) => file.entry),
    async (path) => {
      try {
        return await vscode.workspace.fs.readFile(vscode.Uri.file(path));
      } catch {
        return undefined;
      }
    }
  );
  const visible = new Set(listed.map((entry) => entry.relPath));
  return files.filter((file) => visible.has(file.entry.relPath));
}

/** A human title for a diff, honest about the status being shown. */
function diffTitle(relPath: string, status: ChangeStatus, scope: 'turn' | 'session'): string {
  const label = status === 'created' ? 'new' : status === 'deleted' ? 'deleted' : status === 'renamed' ? 'renamed' : 'modified';
  return `${relPath} (${label} this ${scope})`;
}
