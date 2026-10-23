import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
  browserAgentCallAllowed,
  browserEndpointFileName,
  type BrowserCommand
} from './config.ts';
import { BrowserBridge } from './bridge.ts';
import { BrowserPanel, type BrowserTabState } from './panel.ts';
import {
  browserSkillEnabledFor,
  configuredSettingValue,
  originApprovalCopy,
  SessionOrigins,
  type BrowserSkillProvider
} from './policy.ts';
import { BrowserPage } from './session.ts';
import { preflightNavigation } from './preflight.ts';
import { saveSnapshotPng } from './snapshot.ts';
import { runBrowserTool, textResult, type BrowserActions, type OriginApproval, type ToolResult } from './tools.ts';
import { SKILLS_SECTION } from '../settingsKeys';

/**
 * Owns the bridge, the page, and the editor tab for one window.
 *
 * The bridge starts when an agent is given the tool. The page and the tab
 * start on the first tool call. Turning the skill off closes all three.
 */
export class BrowserSkill {
  private bridge?: BrowserBridge;
  private page?: BrowserPage;
  private panel?: BrowserPanel;
  private opening?: Promise<BrowserPage>;
  private token = '';
  private endpointFile = '';
  private starting?: Promise<void>;
  private stopped = false;
  private readonly sessionOrigins = new SessionOrigins();
  private launchErrorListener?: () => void;
  launchError?: string;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Called after a browser launch fails, so the Skills tab can show the reason. */
  setLaunchErrorListener(listener: () => void): void {
    this.launchErrorListener = listener;
  }

  private skillSettings(): { browser?: unknown; browserCodex?: unknown; browserOpencode?: unknown } {
    const config = vscode.workspace.getConfiguration(SKILLS_SECTION);
    return {
      browser: configuredSettingValue(config.inspect('browser')),
      browserCodex: configuredSettingValue(config.inspect('browserCodex')),
      browserOpencode: configuredSettingValue(config.inspect('browserOpencode'))
    };
  }

  /** Whether browser control is on for one provider (or either, when omitted). */
  enabled(provider?: BrowserSkillProvider): boolean {
    const settings = this.skillSettings();
    if (provider) {
      return browserSkillEnabledFor(provider, settings);
    }
    return browserSkillEnabledFor('codex', settings) || browserSkillEnabledFor('opencode', settings);
  }

  /**
   * Spawn description for a conversation. Starts the bridge only.
   * Undefined when the skill is off for that provider.
   */
  async command(provider: BrowserSkillProvider): Promise<BrowserCommand | undefined> {
    if (!this.enabled(provider)) {
      return undefined;
    }
    this.stopped = false;
    await this.ensureBridge();
    if (this.stopped || !this.enabled(provider)) {
      return undefined;
    }
    return {
      command: process.execPath,
      args: [
        join(this.context.extensionPath, 'dist', 'browser-mcp.js'),
        '--endpoint-file',
        this.endpointFile,
        '--provider',
        provider
      ],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    };
  }

  /** Close the page and the bridge when both providers have the skill off. */
  async syncEnabled(): Promise<void> {
    if (!this.enabled()) {
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.opening = undefined;
    this.starting = undefined;
    this.launchError = undefined;
    this.sessionOrigins.clear();
    const page = this.page;
    this.page = undefined;
    await page?.close();
    this.panel?.close();
    this.panel = undefined;
    const bridge = this.bridge;
    this.bridge = undefined;
    await bridge?.close();
    if (this.endpointFile) {
      await rm(this.endpointFile, { force: true }).catch(() => undefined);
    }
  }

  private async ensureBridge(): Promise<void> {
    if (this.bridge && this.endpointFile) {
      return;
    }
    if (!this.starting) {
      this.starting = this.openBridge().finally(() => {
        this.starting = undefined;
      });
    }
    await this.starting;
  }

  private async openBridge(): Promise<void> {
    if (!this.token) {
      this.token = randomBytes(24).toString('hex');
    }
    if (!this.bridge) {
      this.bridge = new BrowserBridge((call) => this.handle(call.name, call.arguments, call.provider));
    }
    const url = await this.bridge.start(this.token);
    const directory = this.context.globalStorageUri.fsPath;
    await mkdir(directory, { recursive: true });
    this.endpointFile = join(directory, browserEndpointFileName(this.token));
    await writeFile(this.endpointFile, JSON.stringify({ url, token: this.token }), { mode: 0o600 });
    if (this.stopped) {
      const bridge = this.bridge;
      const file = this.endpointFile;
      this.bridge = undefined;
      this.endpointFile = '';
      await bridge?.close();
      await rm(file, { force: true }).catch(() => undefined);
    }
  }

  private async handle(name: string, args: unknown, provider?: BrowserSkillProvider): Promise<ToolResult> {
    if (!browserAgentCallAllowed(provider, (candidate) => this.enabled(candidate))) {
      return { content: [{ type: 'text', text: 'Browser control is off for this provider.' }], isError: true };
    }
    if (name === 'browser_assert' && !this.page) {
      return {
        content: [{ type: 'text', text: 'The browser is not open; navigate first.' }],
        isError: true
      };
    }
    try {
      if (name === 'browser_close') {
        await this.closeBrowser();
        return textResult('Closed the browser page. The next navigation opens a new one.');
      }
      const preflight = name === 'browser_navigate' ? preflightNavigation(args, this.sessionOrigins) : undefined;
      let approvedOrigin: string | undefined;
      let approval: OriginApproval | undefined;
      if (preflight) {
        if (preflight.kind === 'missing') {
          this.panel?.showError('Provide a url.');
          return textResult('Provide a url.', true);
        }
        if (preflight.kind === 'invalid') {
          this.panel?.showError('Only http and https addresses can be opened.');
          return textResult('Only http and https addresses can be opened.', true);
        }
        if (preflight.kind === 'ask') {
          approvedOrigin = preflight.origin;
          approval = await this.askOrigin(preflight.origin);
          if (approval === 'deny') {
            this.panel?.showError(`Navigation to ${preflight.origin} was denied.`);
            return textResult(`Navigation to ${preflight.origin} was denied.`, true);
          }
        }
      }
      const page = await this.ensurePage();
      const actions = this.actions(page);
      const allow = async (origin: string): Promise<OriginApproval> => {
        if (approvedOrigin === origin && approval) {
          return approval;
        }
        return this.askOrigin(origin);
      };
      const result = await runBrowserTool(actions, name, args, allow, this.sessionOrigins);
      if (result.isError && name === 'browser_navigate') {
        this.panel?.showError(errorText(result));
      } else {
        await this.pushState(page);
      }
      return result;
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : 'The browser action failed.';
      this.launchError = message;
      this.launchErrorListener?.();
      if (name === 'browser_navigate') {
        this.panel?.showError(message);
      }
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  }

  private actions(page: BrowserPage): BrowserActions {
    return {
      navigate: (url) => page.navigate(url),
      resize: async (width, height) => {
        const size = await page.resize(width, height);
        await page.restartScreencast((jpeg) => this.panel?.frame(jpeg));
        return size;
      },
      snapshot: async () => {
        const shot = await page.snapshot();
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return { ...shot, ...(await saveSnapshotPng(root, shot)) };
      },
      click: (input) => page.click(input),
      type: (text, selector) => page.type(text, selector),
      press: (key) => page.press(key),
      console: async () => page.consoleText(),
      assert: (input) => page.assert(input),
      scroll: (dx, dy) => page.scroll(dx, dy),
      back: () => page.back(),
      forward: () => page.forward(),
      reload: () => page.reload(),
      close: () => this.closeBrowser()
    };
  }

  /** Close the page and the tab but keep the bridge, so a later navigate reopens. */
  private async closeBrowser(): Promise<void> {
    const opening = this.opening;
    this.opening = undefined;
    if (opening) {
      await opening.catch(() => undefined);
    }
    const page = this.page;
    this.page = undefined;
    await page?.close();
    this.panel?.close();
    this.panel = undefined;
    this.launchError = undefined;
  }

  private async ensurePage(): Promise<BrowserPage> {
    if (this.page) {
      this.ensurePanel(await this.page.location().catch(() => ({ url: '', title: '' })));
      return this.page;
    }
    if (!this.opening) {
      this.opening = this.launch().finally(() => {
        this.opening = undefined;
      });
    }
    return this.opening;
  }

  private async launch(): Promise<BrowserPage> {
    const page = new BrowserPage();
    try {
      await page.open((jpeg) => this.panel?.frame(jpeg));
    } catch (error) {
      await page.close();
      throw error;
    }
    this.page = page;
    this.launchError = undefined;
    const location = await page.location().catch(() => ({ url: '', title: '' }));
    this.ensurePanel(location);
    return page;
  }

  private ensurePanel(location: { url: string; title: string }): void {
    if (!this.panel) {
      this.panel = new BrowserPanel(
        (x, y) => {
          void this.page?.clickFraction(x, y);
        },
        (key) => {
          void this.page?.press(key);
        },
        (url) => {
          void this.handle('browser_navigate', { url });
        },
        (width, height) => {
          void this.handle('browser_resize', { width, height });
        }
      );
    }
    const viewport = this.page?.viewport() ?? { width: 1280, height: 800 };
    const state: BrowserTabState = {
      url: location.url,
      title: location.title || 'Browser',
      width: viewport.width,
      height: viewport.height
    };
    this.panel.show(state);
  }

  private async pushState(page: BrowserPage): Promise<void> {
    const location = await page.location().catch(() => ({ url: '', title: '' }));
    this.ensurePanel(location);
    this.panel?.state({
      url: location.url,
      title: location.title || 'Browser',
      ...page.viewport()
    });
  }

  private async askOrigin(origin: string): Promise<OriginApproval> {
    const choice = await vscode.window.showWarningMessage(
      originApprovalCopy(origin),
      { modal: true },
      'Allow once',
      'Allow for this session',
      'Deny'
    );
    if (choice === 'Allow once') {
      return 'once';
    }
    if (choice === 'Allow for this session') {
      this.sessionOrigins.add(origin);
      return 'session';
    }
    return 'deny';
  }
}

/** The first text block of a tool result, which is what the panel shows inline. */
function errorText(result: ToolResult): string {
  const text = result.content.find((entry) => entry.type === 'text' && entry.text)?.text;
  return text || 'The browser action failed.';
}

let current: BrowserSkill | undefined;

export function attachBrowserSkill(skill: BrowserSkill): void {
  current = skill;
}

/** Command for the next conversation, or undefined when the skill is off for that provider. */
export async function browserCommand(provider: BrowserSkillProvider): Promise<BrowserCommand | undefined> {
  return current?.command(provider);
}

/** The last launch failure, for the Skills tab. Absent until a launch fails. */
export function browserLaunchError(): string | undefined {
  return current?.launchError;
}

export async function syncBrowserSkill(): Promise<void> {
  await current?.syncEnabled();
}

export async function stopBrowserSkill(): Promise<void> {
  await current?.stop();
}
