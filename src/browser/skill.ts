import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { BrowserCommand } from './config.ts';
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
import { runBrowserTool, type BrowserActions, type OriginApproval, type ToolResult } from './tools.ts';

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
    const config = vscode.workspace.getConfiguration('melink.skills');
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
      args: [join(this.context.extensionPath, 'dist', 'browser-mcp.js'), '--endpoint-file', this.endpointFile],
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
      this.bridge = new BrowserBridge((call) => this.handle(call.name, call.arguments));
    }
    const url = await this.bridge.start(this.token);
    const directory = this.context.globalStorageUri.fsPath;
    await mkdir(directory, { recursive: true });
    this.endpointFile = join(directory, 'browser-endpoint.json');
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

  private async handle(name: string, args: unknown): Promise<ToolResult> {
    if (!this.enabled()) {
      return { content: [{ type: 'text', text: 'Browser control is off for this provider.' }], isError: true };
    }
    try {
      const page = await this.ensurePage();
      const actions = this.actions(page);
      const result = await runBrowserTool(actions, name, args, (origin) => this.askOrigin(origin), this.sessionOrigins);
      await this.pushState(page);
      return result;
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : 'The browser action failed.';
      this.launchError = message;
      this.launchErrorListener?.();
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
      snapshot: () => page.snapshot(),
      click: (input) => page.click(input),
      type: (text, selector) => page.type(text, selector),
      press: (key) => page.press(key)
    };
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
