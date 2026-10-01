import * as vscode from 'vscode';
import { BackendRegistry } from './backends/registry';
import { setDiagnosticSink } from './backends/diagnostics';
import { OLLAMA_TOKEN_SECRET_KEY } from './backends/secrets';
import { VscodeProjectContext } from './context/vscodeHost';
import { SidebarViewProvider } from './sidebarView';

/**
 * The registry is referenced by `deactivate` as well as by the subscriptions, so
 * a window reload or extension-host restart can await child-process teardown and
 * leave no orphaned `codex` process behind.
 */
let registry: BackendRegistry | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // Diagnostics only, and never a credential: this records which spawn form
  // started so an argument drift is visible instead of falling silently into
  // `unavailable`. Installed once, before any backend can spawn a child.
  const diagnostics = vscode.window.createOutputChannel('Agent sidebar (Codex)');
  context.subscriptions.push(diagnostics);
  setDiagnosticSink((message) => diagnostics.appendLine(message));

  const activeRegistry = new BackendRegistry(context);
  registry = activeRegistry;
  // The project-context service is the single source of project awareness: it
  // owns the workspace root and the snapshot/delta reads, and hands them to the
  // view, which delivers them to each backend through the AgentBackend seam.
  const projectContext = new VscodeProjectContext();
  const provider = new SidebarViewProvider(context.extensionUri, context, activeRegistry, projectContext);

  context.subscriptions.push(
    activeRegistry,
    projectContext.watch(),
    // A `melink.context` change made outside the settings screen (the VS Code
    // settings UI, a settings.json edit, or a workspace switch) must also reach
    // an open conversation's next turn. `projectContext.watch()` drops the
    // snapshot cache; this re-arms delivery so the cached rendered prefix is not
    // re-sent under the old include flags, cap, or patterns.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('melink.context')) {
        provider.invalidateContextDelivery();
      }
    }),
    vscode.window.registerWebviewViewProvider(SidebarViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    // The strip follows the current editor state: a file switch or a new
    // selection re-reads the snapshot and repaints the strip and its panel, with
    // no window reload and without re-rendering the transcript. These reads only
    // rebuild editor state; the cached tree is untouched, so typing is cheap.
    vscode.window.onDidChangeActiveTextEditor(() => provider.refreshContextView()),
    vscode.window.onDidChangeTextEditorSelection(() => provider.refreshContextView()),
    vscode.commands.registerCommand('melink.setOllamaToken', async () => {
      const value = await vscode.window.showInputBox({
        title: 'Ollama Cloud token',
        prompt: 'Stored in VS Code secret storage and sent only to the configured base URL.',
        password: true,
        ignoreFocusOut: true
      });
      if (value === undefined) {
        return;
      }
      await context.secrets.store(OLLAMA_TOKEN_SECRET_KEY, value);
      await activeRegistry.refresh();
    }),
    vscode.commands.registerCommand('melink.clearOllamaToken', async () => {
      await context.secrets.delete(OLLAMA_TOKEN_SECRET_KEY);
      await activeRegistry.refresh();
    }),
    vscode.commands.registerCommand('melink.refreshBackends', () => activeRegistry.refresh()),
    vscode.commands.registerCommand('melink.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'melink')
    )
  );

  void activeRegistry.refresh();
}

export function deactivate(): Promise<void> {
  // VS Code disposes `context.subscriptions` and then calls this. Awaiting the
  // registry's teardown is what guarantees the Codex child process is gone
  // before the extension host exits.
  return registry?.dispose() ?? Promise.resolve();
}
