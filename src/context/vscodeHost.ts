import * as vscode from 'vscode';
import {
  ProjectContext,
  ownerRepo,
  remoteUrl,
  type ContextInvalidation,
  type DirectoryEntry,
  type ProjectContextHost
} from './projectContext';
import {
  DEFAULT_CONTEXT_SETTINGS,
  MAX_CONTEXT_BYTES,
  MIN_CONTEXT_BYTES,
  CONTEXT_SECTION,
  type ContextSettings
} from './contextSettings';
import { DEFAULT_REPO_MAP_CAPS } from './repoMap';

/**
 * The one binding from the real VS Code API to the host-free
 * `ProjectContextHost` surface used by `projectContext.ts`.
 *
 * Everything here is a mechanical read; the picture itself lives in the
 * host-free module so it stays unit-testable. This file is the only part of the
 * context module that imports `vscode`, and it must never write, log, or echo
 * project-derived content: a read that fails is a read that yields nothing.
 *
 * `VscodeProjectContext.watch()` registers the invalidation listeners the
 * snapshot's cache depends on. Branch changes need no listener because the git
 * identity is re-read on every snapshot and never cached; the listener is
 * registered anyway when the built-in git extension is present, so an explicit
 * `gitBranch` invalidation is available to hosts that want it.
 */
export class VscodeProjectContextHost implements ProjectContextHost {
  /**
   * The last real file editor. Focusing the sidebar clears
   * `activeTextEditor`, and a non-file editor (output, debug) must not replace
   * the file the user was just looking at.
   */
  private lastFileEditor: vscode.TextEditor | undefined;

  /** Remember a file editor. A non-file editor leaves the last file in place. */
  noteActiveEditor(editor: vscode.TextEditor | undefined): void {
    if (editor && editor.document.uri.scheme === 'file') {
      this.lastFileEditor = editor;
    }
  }

  /** Subscribe to editor focus and seed the file that is already open. */
  watchEditors(): vscode.Disposable {
    this.noteActiveEditor(vscode.window.activeTextEditor);
    return vscode.window.onDidChangeActiveTextEditor((editor) => this.noteActiveEditor(editor));
  }

  /**
   * The file the user is viewing. A focused file editor wins; otherwise the
   * last file editor, so clicking the chat does not swap in a different file.
   */
  private fileEditor(): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    if (active && active.document.uri.scheme === 'file') {
      this.lastFileEditor = active;
      return active;
    }
    const last = this.lastFileEditor;
    if (last && last.document.uri.scheme === 'file' && !last.document.isClosed) {
      return last;
    }
    this.lastFileEditor = undefined;
    return undefined;
  }

  workspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  }

  async readFile(path: string): Promise<string | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
      return Buffer.from(bytes).toString('utf8');
    } catch {
      // Snapshot reads tolerate a per-file failure: one unreadable ancillary
      // file contributes nothing and must not fail the whole picture.
      return undefined;
    }
  }

  async readFileStrict(path: string): Promise<string | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
      return Buffer.from(bytes).toString('utf8');
    } catch (error) {
      // The repo map uses this seam: a genuinely missing file contributes
      // nothing, but an unreadable file is rethrown so the map reports failed
      // instead of presenting a partial index as complete.
      if (isMissingFile(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async listDirectory(directory: string): Promise<readonly DirectoryEntry[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(directory));
      return entries.map(([name, type]) => ({
        path: vscode.Uri.joinPath(vscode.Uri.file(directory), name).fsPath,
        isDirectory: (type & vscode.FileType.Directory) !== 0
      }));
    } catch {
      return [];
    }
  }

  async gitBranch(root: string): Promise<string | null> {
    const head = await this.readFile(join(root, '.git', 'HEAD'));
    if (!head) {
      return null;
    }
    const match = /^ref:\s*refs\/heads\/(.+)\s*$/m.exec(head);
    return match ? match[1].trim() : null;
  }

  async gitRemote(root: string): Promise<string | null> {
    const config = await this.readFile(join(root, '.git', 'config'));
    if (!config) {
      return null;
    }
    // The first `remote "..."` block's url wins; `origin` is preferred when it
    // is present, because that is the repository's own name rather than a fork.
    const url = remoteUrl(config);
    if (!url) {
      return null;
    }
    return ownerRepo(url);
  }

  activeEditor(): ReturnType<ProjectContextHost['activeEditor']> {
    const editor = this.fileEditor();
    if (!editor) {
      return null;
    }
    const selection = editor.selection;
    return {
      absolutePath: editor.document.uri.fsPath,
      languageId: editor.document.languageId,
      selection: selection.isEmpty
        ? null
        : {
            startLine: selection.start.line + 1,
            startColumn: selection.start.character + 1,
            endLine: selection.end.line + 1,
            endColumn: selection.end.character + 1
          }
    };
  }

  activeSelectionText(): string {
    const editor = this.fileEditor();
    if (!editor || editor.selection.isEmpty) {
      return '';
    }
    return editor.document.getText(editor.selection);
  }

  activeFileText(): string {
    const editor = this.fileEditor();
    return editor ? editor.document.getText() : '';
  }

  openEditors(): ReturnType<ProjectContextHost['openEditors']> {
    const active = this.fileEditor()?.document.uri.fsPath;
    return vscode.window.visibleTextEditors.map((editor) => ({
      absolutePath: editor.document.uri.fsPath,
      languageId: editor.document.languageId,
      isActive: editor.document.uri.fsPath === active,
      isDirty: editor.document.isDirty
    }));
  }

  dirtyFiles(): readonly string[] {
    return vscode.workspace.textDocuments
      .filter((document) => document.isDirty && document.uri.scheme === 'file')
      .map((document) => document.uri.fsPath);
  }

  async terminalCwd(): Promise<string | null> {
    // VS Code exposes no non-command read of a terminal's cwd, and issuing
    // `terminal.processId` or a shell command would be a write to the host. The
    // snapshot therefore reports `null` rather than guessing or probing.
    return null;
  }

  filesExclude(): readonly string[] {
    return readGlobs('files.exclude');
  }

  searchExclude(): readonly string[] {
    return readGlobs('search.exclude');
  }

  userExclude(): readonly string[] {
    return this.contextSettings().exclude;
  }

  /**
   * The project-context defaults the settings screen writes. Every value is
   * clamped and type-checked here so a hand-edited `settings.json` can never
   * produce an unbounded snapshot or a non-boolean flag.
   */
  contextSettings(): ContextSettings {
    const section = vscode.workspace.getConfiguration(CONTEXT_SECTION);
    return {
      includeInstructions: section.get<boolean>('includeInstructions', DEFAULT_CONTEXT_SETTINGS.includeInstructions) === true,
      includeShape: section.get<boolean>('includeShape', DEFAULT_CONTEXT_SETTINGS.includeShape) === true,
      includeEditorState: section.get<boolean>('includeEditorState', DEFAULT_CONTEXT_SETTINGS.includeEditorState) === true,
      includeSelection: section.get<boolean>('includeSelection', DEFAULT_CONTEXT_SETTINGS.includeSelection) === true,
      includeChangedFiles: section.get<boolean>('includeChangedFiles', DEFAULT_CONTEXT_SETTINGS.includeChangedFiles) === true,
      maxBytes: clampMaxBytes(section.get<unknown>('maxBytes', DEFAULT_CONTEXT_SETTINGS.maxBytes)),
      exclude: readStringArray(section.get<unknown>('exclude', DEFAULT_CONTEXT_SETTINGS.exclude)),
      repoMap: section.get<boolean>('repoMap') === true,
      repoMapMaxFiles: clampCount(
        section.get<unknown>('repoMapMaxFiles'),
        DEFAULT_REPO_MAP_CAPS.maxFiles
      ),
      repoMapMaxBytes: clampCount(
        section.get<unknown>('repoMapMaxBytes'),
        DEFAULT_REPO_MAP_CAPS.maxBytes
      ),
      repoMapBuildMs: clampCount(
        section.get<unknown>('repoMapBuildMs'),
        DEFAULT_REPO_MAP_CAPS.maxBuildMs
      ),
      repoMapMaxChars: clampCount(
        section.get<unknown>('repoMapMaxChars'),
        DEFAULT_REPO_MAP_CAPS.maxChars
      )
    };
  }

  now(): number {
    return Date.now();
  }
}

/**
 * The service plus its invalidation wiring. `watch` returns a disposable so the
 * caller can register it with `context.subscriptions`; disposing it detaches
 * every listener and leaves the service itself inert.
 */
export class VscodeProjectContext {
  readonly context: ProjectContext;
  private readonly host: VscodeProjectContextHost;

  constructor() {
    this.host = new VscodeProjectContextHost();
    this.context = new ProjectContext({ host: this.host });
  }

  /**
   * Register the listeners that drop the cached picture. Editor and selection
   * changes are deliberately absent: they are delta-only and never rebuild the
   * tree, so typing costs nothing.
   */
  watch(): vscode.Disposable {
    const invalidate = (reason: ContextInvalidation): void => this.context.invalidate(reason);
    const listeners: vscode.Disposable[] = [
      this.host.watchEditors(),
      vscode.workspace.onDidChangeWorkspaceFolders(() => invalidate('workspaceFolders')),
      vscode.workspace.onDidCreateFiles(() => invalidate('fileCreated')),
      vscode.workspace.onDidDeleteFiles(() => invalidate('fileDeleted')),
      vscode.workspace.onDidRenameFiles(() => invalidate('fileCreated')),
      vscode.workspace.onDidSaveTextDocument(() => invalidate('fileSaved')),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('files.exclude') ||
          event.affectsConfiguration('search.exclude') ||
          event.affectsConfiguration('melink.context')
        ) {
          invalidate('configuration');
        }
      })
    ];
    for (const disposable of gitBranchListeners(() => invalidate('gitBranch'))) {
      listeners.push(disposable);
    }
    return vscode.Disposable.from(...listeners);
  }
}

/** Configuration globs, as a string array, ignoring a non-array value. */
function readGlobs(section: string): string[] {
  const value = vscode.workspace.getConfiguration().get<unknown>(section, {});
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([, enabled]) => enabled === true)
    .map(([pattern]) => pattern);
}

/** A finite byte cap inside the documented range, or the default otherwise. */
/** A genuinely absent file, as opposed to an unreadable one. */
function isMissingFile(error: unknown): boolean {
  if (error instanceof vscode.FileSystemError) {
    if (error.code === 'FileNotFound') {
      return true;
    }
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'FileNotFound' || code === 'ENOENT') {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /file not found|no such file or directory/i.test(message);
}

function clampMaxBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CONTEXT_SETTINGS.maxBytes;
  }
  return Math.min(MAX_CONTEXT_BYTES, Math.max(MIN_CONTEXT_BYTES, Math.floor(value)));
}

/** A positive whole-number setting, or the documented default when unusable. */
function clampCount(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

/** The string entries of a configured array, ignoring anything else. */
function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

/**
 * Branch-change listeners from the built-in git extension, when it is present
 * and active. Absent git is not an error: the identity is re-read every
 * snapshot regardless, so the cache stays correct without a listener.
 */
function gitBranchListeners(onChange: () => void): vscode.Disposable[] {
  const extension = vscode.extensions.getExtension('vscode.git');
  if (!extension || !extension.isActive) {
    return [];
  }
  type GitRepository = { state: { onDidChange: (listener: () => void) => vscode.Disposable } };
  type GitApi = { repositories: GitRepository[]; onDidOpenRepository: (listener: (repo: GitRepository) => void) => vscode.Disposable };
  const api = extension.exports as { getAPI?: (version: number) => GitApi } | undefined;
  const git = api?.getAPI?.(1);
  if (!git) {
    return [];
  }
  const disposables: vscode.Disposable[] = [];
  const subscribe = (repository: GitRepository): void => {
    disposables.push(repository.state.onDidChange(onChange));
  };
  for (const repository of git.repositories) {
    subscribe(repository);
  }
  disposables.push(git.onDidOpenRepository(subscribe));
  return disposables;
}

function join(...parts: string[]): string {
  return parts.join('/');
}
