/**
 * One headless page, shown to the user through a screencast rather than a
 * second window. Edge is tried first, then Chrome. Nothing is downloaded.
 */

const CHANNELS = ['msedge', 'chrome'] as const;

interface ScreencastFrame {
  data: string;
  sessionId: number;
}

interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: 'Page.screencastFrame', handler: (frame: ScreencastFrame) => void): void;
  detach(): Promise<void>;
}

interface PlaywrightPage {
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  viewportSize(): { width: number; height: number } | null;
  screenshot(options: { type: 'png' }): Promise<Buffer>;
  locator(selector: string): {
    ariaSnapshot(): Promise<string>;
    click(options: { timeout: number }): Promise<void>;
  };
  getByText(text: string, options: { exact: boolean }): { first(): { click(options: { timeout: number }): Promise<void> } };
  mouse: { click(x: number, y: number): Promise<void> };
  keyboard: { type(text: string): Promise<void>; press(key: string): Promise<void>; insertText?(text: string): Promise<void> };
  context(): { newCDPSession(page: PlaywrightPage): Promise<CdpSession> };
}

interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightModule {
  chromium: {
    launch(options: { channel: string; headless: boolean }): Promise<PlaywrightBrowser>;
  };
}

export class BrowserPage {
  private browser?: PlaywrightBrowser;
  private page?: PlaywrightPage;
  private cdp?: CdpSession;
  private width = 1280;
  private height = 800;

  /** Launch Edge, then Chrome. Throws a plain message when neither starts. */
  async open(onFrame: (jpegBase64: string) => void): Promise<void> {
    if (this.page) {
      return;
    }
    const playwright = (await import('playwright-core')) as PlaywrightModule;
    let last: unknown;
    for (const channel of CHANNELS) {
      try {
        this.browser = await playwright.chromium.launch({ channel, headless: true });
        break;
      } catch (error) {
        last = error;
        this.browser = undefined;
      }
    }
    if (!this.browser) {
      const detail = last instanceof Error ? last.message : '';
      throw new Error(
        detail
          ? `SideCode could not start Edge or Chrome. ${detail}`
          : 'SideCode could not start Edge or Chrome, so the browser tab is unavailable.'
      );
    }
    this.page = await this.browser.newPage();
    await this.page.setViewportSize({ width: this.width, height: this.height });
    await this.startScreencast(onFrame);
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    const page = this.requirePage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    const title = await page.title().catch(() => '');
    return { url: page.url(), title };
  }

  async resize(width: number, height: number): Promise<{ width: number; height: number }> {
    const page = this.requirePage();
    this.width = width;
    this.height = height;
    await page.setViewportSize({ width, height });
    return { width, height };
  }

  /** Start the screencast again so the picture matches a new viewport. */
  async restartScreencast(onFrame: (jpegBase64: string) => void): Promise<void> {
    if (this.cdp) {
      await this.cdp.send('Page.stopScreencast').catch(() => undefined);
      await this.cdp.detach().catch(() => undefined);
      this.cdp = undefined;
    }
    await this.startScreencast(onFrame);
  }

  async snapshot(): Promise<{ text: string; pngBase64: string }> {
    const page = this.requirePage();
    let text = '';
    try {
      text = await page.locator('body').ariaSnapshot();
    } catch {
      text = await page.title().catch(() => '');
    }
    const png = await page.screenshot({ type: 'png' });
    return { text, pngBase64: png.toString('base64') };
  }

  async click(input: { selector?: string; text?: string; x?: number; y?: number }): Promise<string> {
    const page = this.requirePage();
    if (input.selector) {
      await page.locator(input.selector).click({ timeout: 5_000 });
      return `Clicked ${input.selector}.`;
    }
    if (input.text) {
      await page.getByText(input.text, { exact: false }).first().click({ timeout: 5_000 });
      return `Clicked “${input.text}”.`;
    }
    if (input.x !== undefined && input.y !== undefined) {
      await page.mouse.click(input.x, input.y);
      return `Clicked ${Math.round(input.x)}, ${Math.round(input.y)}.`;
    }
    throw new Error('Provide a selector, visible text, or both x and y.');
  }

  /** `x` and `y` are fractions of the viewport, from the editor tab. */
  async clickFraction(x: number, y: number): Promise<void> {
    const page = this.requirePage();
    const size = page.viewportSize() ?? { width: this.width, height: this.height };
    const px = Math.min(size.width - 1, Math.max(0, x * size.width));
    const py = Math.min(size.height - 1, Math.max(0, y * size.height));
    await page.mouse.click(px, py);
  }

  async type(text: string, selector?: string): Promise<void> {
    const page = this.requirePage();
    if (selector) {
      await page.locator(selector).click({ timeout: 5_000 });
    }
    await page.keyboard.type(text);
  }

  async press(key: string): Promise<void> {
    const page = this.requirePage();
    if (key.length === 1) {
      await page.keyboard.type(key);
      return;
    }
    await page.keyboard.press(key);
  }

  viewport(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  async location(): Promise<{ url: string; title: string }> {
    const page = this.requirePage();
    return { url: page.url(), title: await page.title().catch(() => '') };
  }

  async close(): Promise<void> {
    const cdp = this.cdp;
    this.cdp = undefined;
    if (cdp) {
      await cdp.detach().catch(() => undefined);
    }
    const browser = this.browser;
    this.page = undefined;
    this.browser = undefined;
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }

  private requirePage(): PlaywrightPage {
    if (!this.page) {
      throw new Error('The browser is not open.');
    }
    return this.page;
  }

  private async startScreencast(onFrame: (jpegBase64: string) => void): Promise<void> {
    const page = this.requirePage();
    const cdp = await page.context().newCDPSession(page);
    this.cdp = cdp;
    cdp.on('Page.screencastFrame', (frame) => {
      onFrame(frame.data);
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: this.width,
      maxHeight: this.height,
      everyNthFrame: 1
    });
  }
}
