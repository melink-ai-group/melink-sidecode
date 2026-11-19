import * as vscode from 'vscode';
import { planHasRemainingSteps, renderPlanMarkdown } from './backends/plan';
import type { PlanArtifact } from './backends/types';
import { openFileInEditor, openUrlInInternalBrowser } from './editorNavigation';

/** Messages the rendered plan sends back to the host. */
interface PlanPreviewMessage {
  type?: string;
  path?: unknown;
  line?: unknown;
  column?: unknown;
  url?: unknown;
}

/** Payload the rendered plan view shows. */
export interface PlanPreviewState {
  title: string;
  markdown: string;
  /** True while Build can switch the thread into Agent mode and execute the steps. */
  canBuild: boolean;
}

/**
 * Editor-area view of one plan: rendered markdown, with Build at the top right.
 * The panel is created on demand and reused for later revisions of the same
 * document. Build is forwarded to the host; this view does not change mode itself.
 */
export class PlanPreview {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private pending?: PlanPreviewState;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onBuild: () => void
  ) {}

  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  /**
   * Show `state`. When `reveal` is true the panel is brought to the active
   * editor column. An already-open panel is updated in place when `reveal` is
   * false, so step updates do not steal focus.
   */
  show(state: PlanPreviewState, reveal: boolean): void {
    this.pending = state;
    if (!this.panel) {
      this.ready = false;
      this.panel = vscode.window.createWebviewPanel(
        'melink.planPreview',
        state.title || 'Plan',
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: !reveal },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')]
        }
      );
      this.panel.webview.html = this.html(this.panel.webview);
      this.panel.webview.onDidReceiveMessage((message: PlanPreviewMessage) => {
        if (message?.type === 'ready') {
          this.ready = true;
          this.flush();
        } else if (message?.type === 'build') {
          this.onBuild();
        } else if (message?.type === 'openFile' && typeof message.path === 'string') {
          void openFileInEditor({
            path: message.path,
            ...(typeof message.line === 'number' ? { line: message.line } : {}),
            ...(typeof message.column === 'number' ? { column: message.column } : {})
          });
        } else if (message?.type === 'openLink' && typeof message.url === 'string') {
          void openUrlInInternalBrowser(message.url);
        }
      });
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.ready = false;
      });
    } else if (reveal) {
      this.panel.reveal(vscode.ViewColumn.Active, false);
    }
    this.panel.title = state.title || 'Plan';
    this.flush();
  }

  close(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.ready = false;
  }

  private flush(): void {
    if (!this.ready || !this.panel || !this.pending) {
      return;
    }
    void this.panel.webview.postMessage({ type: 'plan', ...this.pending });
  }

  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'planPreview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'planPreview.css'));
    const nonce = createNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${styleUri}" rel="stylesheet" />
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

/** The rendered document and whether Build is available for this artifact. */
export function planPreviewState(plan: PlanArtifact, markdown?: string): PlanPreviewState {
  return {
    title: plan.title || 'Plan',
    markdown: markdown ?? renderPlanMarkdown({
      title: plan.title || 'Plan',
      summary: plan.summary,
      body: plan.body,
      steps: plan.steps
    }),
    canBuild: plan.built !== true && planHasRemainingSteps(plan.steps)
  };
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
