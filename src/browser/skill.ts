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
  originApprovalRequired,
  SessionOrigins,
  type BrowserSkillProvider
} from './policy.ts';
import type { Attachment, DefaultMode } from '../backends/types.ts';
import { browserImageAttachment } from './capture.ts';
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
  private modeProvider?: () => DefaultMode;
  private attachmentSink?: (attachment: Attachment) => Promise<boolean> | boolean;
  /** Page input is serialized so a drag never overtakes its own press. */
  private inputChain: Promise<void> = Promise.resolve();
  private hoverPending?: { x: number; y: number };
  private hoverRunning = false;
  launchError?: string;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * How the host reports the mode of the chat on screen. The bridge answers
   * outside the webview's async context, so the host reads its visible tab
   * rather than the request-local store.
   *
   * Absent means the strict prompt stays: an embedder that never wires this
   * keeps Ask's behaviour instead of silently opening an origin.
   */
  setModeProvider(read: () => DefaultMode): void {
    this.modeProvider = read;
  }

  /**
   * Where a snippet or whole-view capture goes. The host adds it to the open
   * chat's composer and returns false when no chat tab is open, so the browser
   * tab can say so instead of dropping the image.
   */
  setAttachmentSink(sink: (attachment: Attachment) => Promise<boolean> | boolean): void {
    this.attachmentSink = sink;
  }

  /** Whether this call must surface the origin approval prompt. */
  private originPromptRequired(): boolean {
    return originApprovalRequired(this.modeProvider?.() ?? 'ask');
  }

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
          approval = await this.approveOrigin(preflight.origin);
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
        return this.approveOrigin(origin);
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
      this.panel = new BrowserPanel({
        navigate: (url) => {
          void this.handle('browser_navigate', { url });
        },
        resize: (width, height) => {
          void this.handle('browser_resize', { width, height });
        },
        pointer: (action, x, y, options) => this.pointer(action, x, y, options),
        wheel: (x, y, dx, dy) => this.wheel(x, y, dx, dy),
        keyDown: (key) => this.keyDown(key),
        keyUp: (key) => this.keyUp(key),
        insertText: (text) => this.insertText(text),
        paste: () => this.paste(),
        hover: (x, y) => this.hover(x, y),
        leave: () => this.leave(),
        capture: (rect) => void this.attachCapture(rect),
        blur: () => this.releaseKeys()
      });
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

  /** Queue one page input so a drag's move never runs before its press. */
  private queueInput(task: () => Promise<void>): void {
    this.inputChain = this.inputChain.then(task, task).catch(() => undefined);
  }

  private pointer(
    action: 'move' | 'down' | 'up',
    x: number,
    y: number,
    options?: { button?: number; clickCount?: number }
  ): void {
    const button = options?.button === 1 ? 'middle' : options?.button === 2 ? 'right' : 'left';
    const clickCount = options?.clickCount && options.clickCount > 1 ? options.clickCount : 1;
    this.queueInput(async () => {
      const page = this.page;
      if (!page) {
        return;
      }
      if (action === 'move') {
        await page.moveFraction(x, y);
        return;
      }
      if (action === 'down') {
        await page.downFraction(x, y, { button, clickCount });
        return;
      }
      await page.upFraction(x, y, { button, clickCount });
    });
  }

  private wheel(x: number, y: number, dx: number, dy: number): void {
    this.queueInput(async () => {
      await this.page?.wheelFraction(x, y, dx, dy);
    });
  }

  private keyDown(key: string): void {
    this.queueInput(async () => {
      await this.page?.keyDown(key);
    });
  }

  private keyUp(key: string): void {
    this.queueInput(async () => {
      await this.page?.keyUp(key);
    });
  }

  private insertText(text: string): void {
    this.queueInput(async () => {
      await this.page?.insertText(text);
    });
  }

  /**
   * Paste the OS clipboard into the page.
   *
   * The panel is not an editable field, so the webview's own paste event does
   * not fire there; the host reads the clipboard and inserts it, which also
   * works for a page input that has focus in the headless browser.
   */
  private paste(): void {
    this.queueInput(async () => {
      try {
        const text = await vscode.env.clipboard.readText();
        if (text) {
          await this.page?.insertText(text);
        }
      } catch {
        // A clipboard that cannot be read leaves the page unchanged.
      }
    });
  }

  private releaseKeys(): void {
    this.queueInput(async () => {
      await this.page?.releaseKeys();
    });
  }

  /**
   * The page's cursor under the pointer, coalesced.
   *
   * A move can arrive faster than a cursor read; only the latest position is
   * kept, and a slow page never builds an unbounded queue behind the pointer.
   */
  private hover(x: number, y: number): void {
    this.hoverPending = { x, y };
    if (this.hoverRunning) {
      return;
    }
    this.hoverRunning = true;
    this.queueInput(async () => {
      try {
        while (this.hoverPending) {
          const point = this.hoverPending;
          this.hoverPending = undefined;
          const page = this.page;
          if (!page) {
            break;
          }
          await page.moveFraction(point.x, point.y);
          this.panel?.cursor(await page.cursorAtFraction(point.x, point.y));
        }
      } finally {
        this.hoverRunning = false;
      }
    });
  }

  /** Clear the page's hover state when the pointer leaves the image. */
  private leave(): void {
    this.queueInput(async () => {
      await this.page?.leavePointer();
    });
  }

  /**
   * Save and attach one capture. No rect means the whole viewport.
   *
   * The PNG goes under `.melink/reports/browser/` when a workspace is open;
   * otherwise the inline data URL is the attachment and the draft writer keeps
   * the bytes. The chat sink returns false when no tab is open.
   */
  private async attachCapture(rect?: { x: number; y: number; width: number; height: number }): Promise<void> {
    const page = this.page;
    if (!page) {
      this.panel?.attachError('The browser is not open.');
      return;
    }
    try {
      const shot = await page.capture(rect);
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const saved = await saveSnapshotPng(root, shot);
      const attachment = browserImageAttachment({
        pngBase64: shot.pngBase64,
        title: shot.title,
        url: shot.url,
        kind: rect ? 'snippet' : 'page',
        ...(saved.path ? { path: saved.path } : {})
      });
      const sink = this.attachmentSink;
      const attached = sink ? await sink(attachment) : false;
      if (!attached) {
        this.panel?.attachError('Open a chat tab, then capture again.');
        return;
      }
      this.panel?.attached(`Attached ${attachment.name} to the chat.`);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : 'The capture failed.';
      this.panel?.attachError(message);
    }
  }

  /**
   * The origin decision for one navigation.
   *
   * Ask mode shows the warning and honors Deny. Agent and Plan return `once`
   * without recording a session grant, so switching to Ask later still asks.
   */
  private approveOrigin(origin: string): Promise<OriginApproval> {
    return this.originPromptRequired() ? this.askOrigin(origin) : Promise.resolve('once');
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
