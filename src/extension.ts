import * as vscode from 'vscode';
import { BackendRegistry } from './backends/registry';
import { setDiagnosticSink } from './backends/diagnostics';
import { OLLAMA_TOKEN_SECRET_KEY, OPENCODE_ZEN_TOKEN_SECRET_KEY } from './backends/secrets';
import { VscodeProjectContext } from './context/vscodeHost';
import { planStepMarkdownPlugin } from './planStepMarkdown';
import { SidebarViewProvider } from './sidebarView';
import { attachBrowserSkill, stopBrowserSkill, syncBrowserSkill, BrowserSkill } from './browser/skill';
import { SKILLS_SECTION } from './settingsKeys';
import { MODE_PROMPT_VERSION } from './backends/modes';
import { createFailureLogHost } from './telemetry/failureLogHost';
import {
  cleanLegacyOpencodeEnabled
} from './config/legacySettings.ts';
import {
  FAILURE_LOG_ISSUE_CLASSES,
  recordFailureEntry,
  type FailureIssueClass
} from './telemetry/failureLog';

/** Plain labels for the closed missed-issue taxonomy. */
const FAILURE_LOG_ISSUE_LABELS: Record<FailureIssueClass, string> = {
  'missed-fe-detail': 'Missed a frontend detail',
  'missed-requirement': 'Missed a requirement',
  'wrong-command': 'Ran the wrong command',
  'bad-decision': 'Made a bad decision',
  'tool-misuse': 'Misused a tool',
  other: 'Other'
};

const FAILURE_LOG_OFF_MESSAGE =
  'The local missed-issue log is off. Turn on "melink.telemetry.failureLog" in Settings to save entries on this machine. Nothing is ever sent.';

/**
 * The registry is referenced by `deactivate` as well as by the subscriptions, so
 * a window reload or extension-host restart can await child-process teardown and
 * leave no orphaned `codex` process behind.
 */
let registry: BackendRegistry | undefined;
/**
 * Kept for `deactivate` so the queued-turn lease release can be awaited before
 * the extension host exits; a fire-and-forget workspace-state write can be
 * lost and leave the next window waiting for the full lease.
 */
let sidebarProvider: SidebarViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): { extendMarkdownIt(md: MarkdownItLike): MarkdownItLike } {
  // T106 removed the "use opencode for Ollama turns" toggle: every Ollama turn
  // uses OpenCode now. Remove a stale *global* value once, silently. Workspace
  // and folder values are deliberately never touched (they belong to the
  // repository), and the rule is idempotent.
  void (async () => {
    const configuration = vscode.workspace.getConfiguration();
    await cleanLegacyOpencodeEnabled(configuration, vscode.ConfigurationTarget.Global);
  })().catch(() => {
    // A failed cleanup (for example a read-only user settings file) is not
    // worth interrupting activation; the removed key has no runtime effect.
  });

  // Diagnostics only, and never a credential: this records which spawn form
  // started so an argument drift is visible instead of falling silently into
  // `unavailable`. Installed once, before any backend can spawn a child.
  const diagnostics = vscode.window.createOutputChannel('SideCode (Codex)');
  context.subscriptions.push(diagnostics);
  setDiagnosticSink((message) => diagnostics.appendLine(message));

  const skill = new BrowserSkill(context);
  attachBrowserSkill(skill);

  const activeRegistry = new BackendRegistry(context);
  registry = activeRegistry;
  // The project-context service is the single source of project awareness: it
  // owns the workspace root and the snapshot/delta reads, and hands them to the
  // view, which delivers them to each backend through the AgentBackend seam.
  const projectContext = new VscodeProjectContext();
  const provider = new SidebarViewProvider(context.extensionUri, context, activeRegistry, projectContext);
  sidebarProvider = provider;
  skill.setLaunchErrorListener(() => {
    void provider.publishSettings();
  });

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
      if (
        event.affectsConfiguration(`${SKILLS_SECTION}.browser`) ||
        event.affectsConfiguration(`${SKILLS_SECTION}.browserCodex`) ||
        event.affectsConfiguration(`${SKILLS_SECTION}.browserOpencode`)
      ) {
        void syncBrowserSkill();
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
    vscode.commands.registerCommand('melink.setOpencodeZenToken', async () => {
      const value = await vscode.window.showInputBox({
        title: 'OpenCode Zen API key',
        prompt: 'Stored in VS Code secret storage. Free models work without a key; paid models need this key.',
        password: true,
        ignoreFocusOut: true
      });
      if (value === undefined) {
        return;
      }
      await context.secrets.store(OPENCODE_ZEN_TOKEN_SECRET_KEY, value);
      await activeRegistry.refresh();
    }),
    vscode.commands.registerCommand('melink.clearOpencodeZenToken', async () => {
      await context.secrets.delete(OPENCODE_ZEN_TOKEN_SECRET_KEY);
      await activeRegistry.refresh();
    }),
    vscode.commands.registerCommand('melink.refreshContext', () => provider.refreshProjectContext()),
    vscode.commands.registerCommand('melink.refreshBackends', () => activeRegistry.refresh()),
    vscode.commands.registerCommand('melink.openSettings', () => provider.openInlineSettings()),
    vscode.commands.registerCommand('melink.recordMissedIssue', async () => {
      // Application scope, read from the user value only: a workspace setting
      // can never opt the log in, even if one is written by hand.
      const inspected = vscode.workspace
        .getConfiguration('melink')
        .inspect<boolean>('telemetry.failureLog');
      const host = createFailureLogHost({
        enabled: () => inspected?.globalValue === true,
        globalStoragePath: context.globalStorageUri.fsPath,
        now: () => new Date().toISOString()
      });

      if (!host.sink.enabled()) {
        await vscode.window.showInformationMessage(FAILURE_LOG_OFF_MESSAGE);
        return;
      }

      const picked = await vscode.window.showQuickPick(
        FAILURE_LOG_ISSUE_CLASSES.map((issueClass) => ({
          label: FAILURE_LOG_ISSUE_LABELS[issueClass],
          issueClass
        })),
        { title: 'Record a missed issue', placeHolder: 'Which kind of miss was it?' }
      );
      if (!picked) {
        return;
      }

      const summary = await vscode.window.showInputBox({
        title: 'Record a missed issue',
        prompt: 'One short summary. It stays on this machine; never paste code, prompts, or secrets.',
        placeHolder: 'What did the agent miss?',
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : 'Enter a short summary.')
      });
      if (summary === undefined) {
        return;
      }

      const identity = provider.failureLogIdentity();
      const result = await recordFailureEntry(host.sink, {
        issueClass: picked.issueClass,
        modelId: identity.modelId,
        providerId: identity.providerId,
        promptVersion: MODE_PROMPT_VERSION,
        summary
      }).catch(() => undefined);
      if (!result) {
        await vscode.window.showErrorMessage('The local missed-issue entry could not be written.');
        return;
      }
      if (!result.ok) {
        if (result.reason === 'disabled') {
          await vscode.window.showInformationMessage(FAILURE_LOG_OFF_MESSAGE);
        } else {
          await vscode.window.showWarningMessage(result.message ?? 'The entry was not saved.');
        }
        return;
      }
      await vscode.window.showInformationMessage(
        `Saved locally to ${host.path}. Nothing was sent.`
      );
    })
  );

  void activeRegistry.refresh();

  // The built-in markdown preview calls this so plan steps render as status
  // icons instead of `[ ]`, `[~]`, and `[x]`.
  return {
    extendMarkdownIt(md) {
      md.use(planStepMarkdownPlugin);
      return md;
    }
  };
}

/** The slice of markdown-it the preview hands to `extendMarkdownIt`. */
interface MarkdownItLike {
  use(plugin: (md: MarkdownItLike) => void): MarkdownItLike;
  core: {
    ruler: {
      push: (name: string, fn: (state: { tokens: import('./planStepMarkdown').StepToken[]; env?: unknown }) => void) => void;
    };
  };
}

export async function deactivate(): Promise<void> {
  // VS Code disposes `context.subscriptions` and then calls this. Awaiting the
  // registry's teardown is what guarantees the Codex child process is gone
  // before the extension host exits. The browser tab and its page goes with it.
  // The queued-turn lease release is awaited too: it is a workspace-state write,
  // and a lost write would make the next window wait out the stale lease.
  await sidebarProvider?.shutdownQueue();
  await stopBrowserSkill();
  await registry?.dispose();
}
