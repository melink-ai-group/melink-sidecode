/**
 * Buffered runtime diagnostics for the editor browser page.
 *
 * Pure and host-free: the session feeds Playwright-shaped data to the
 * normalisers below, and the tool returns the formatted text. No Playwright or
 * VS Code import lives here, so the tests run with strip-types.
 */

/** How many of the most recent entries the buffer keeps. */
export const CONSOLE_BUFFER_LIMIT = 200;

/** Longest entry text kept, so one huge console message cannot flood the tool output. */
export const CONSOLE_ENTRY_TEXT_LIMIT = 4000;

/** The exact text returned when nothing has been captured. */
export const EMPTY_CONSOLE_TEXT = 'No console or network entries.';

export interface ConsoleEntry {
  level: string;
  text: string;
  url: string;
  status?: number;
}

/** The parts of Playwright's ConsoleMessage this module reads. */
export interface ConsoleMessageLike {
  type(): string;
  text(): string;
  location(): { url?: string };
}

/** The parts of Playwright's Request this module reads. */
export interface FailedRequestLike {
  url(): string;
  failure(): { errorText?: string } | null;
}

/** The parts of Playwright's Response this module reads. */
export interface ResponseLike {
  url(): string;
  status(): number;
  statusText?(): string;
}

/** The page events the diagnostics buffer subscribes to. */
export type PageDiagnosticEvent = 'console' | 'pageerror' | 'requestfailed' | 'response';

/** The event surface of a Playwright page, kept small so tests can fake it. */
export interface PageDiagnosticSource {
  on(event: PageDiagnosticEvent, handler: (value: unknown) => void): void;
  off?(event: PageDiagnosticEvent, handler: (value: unknown) => void): void;
}

/**
 * Subscribe one page to the buffer. Returns a cleanup that removes every
 * listener, so a reopened page never stacks a second set.
 */
export function attachPageDiagnostics(page: PageDiagnosticSource, buffer: ConsoleBuffer): () => void {
  const handlers: Record<PageDiagnosticEvent, (value: unknown) => void> = {
    console: (value) => buffer.pushConsole(value as ConsoleMessageLike),
    pageerror: (value) => buffer.pushPageError(value),
    requestfailed: (value) => buffer.pushRequestFailed(value as FailedRequestLike),
    response: (value) => buffer.pushResponse(value as ResponseLike)
  };
  for (const event of Object.keys(handlers) as PageDiagnosticEvent[]) {
    page.on(event, handlers[event]);
  }
  return () => {
    for (const event of Object.keys(handlers) as PageDiagnosticEvent[]) {
      page.off?.(event, handlers[event]);
    }
  };
}

/** The navigation surface of a Playwright page, kept small so tests can fake it. */
export interface PageNavigationSource extends PageDiagnosticSource {
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
}

/**
 * Clear diagnostics, then navigate. Only explicit navigation clears; in-page
 * links, reloads and form submissions do not pass through here.
 */
export async function navigatePage(
  page: PageNavigationSource,
  buffer: ConsoleBuffer,
  url: string
): Promise<{ url: string; title: string }> {
  buffer.clear();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  const title = await page.title().catch(() => '');
  return { url: page.url(), title };
}

/** A console message keeps Playwright's own level, e.g. log/info/warning/error/debug. */
export function consoleEntry(message: ConsoleMessageLike): ConsoleEntry {
  return {
    level: message.type(),
    text: message.text(),
    url: message.location()?.url ?? ''
  };
}

/** An uncaught page error is an error, with the message plus a short stack summary. */
export function pageErrorEntry(error: unknown): ConsoleEntry {
  const record = (error && typeof error === 'object' ? error : {}) as { message?: unknown; stack?: unknown };
  const message = typeof record.message === 'string' && record.message ? record.message : 'Uncaught page error.';
  const summary = stackSummary(typeof record.stack === 'string' ? record.stack : '', message);
  return {
    level: 'error',
    text: summary ? `${message} (${summary})` : message,
    url: ''
  };
}

/** A failed request is an error and names the failure reason when Playwright reports one. */
export function requestFailedEntry(request: FailedRequestLike): ConsoleEntry {
  const reason = request.failure()?.errorText;
  return {
    level: 'error',
    text: reason || 'Request failed.',
    url: request.url()
  };
}

/** HTTP responses below 400 are ignored; the rest are errors carrying their status. */
export function responseEntry(response: ResponseLike): ConsoleEntry | undefined {
  const status = response.status();
  if (status < 400) {
    return undefined;
  }
  const statusText = response.statusText?.() ?? '';
  return {
    level: 'error',
    text: statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`,
    url: response.url(),
    status
  };
}

/** One line per entry: level, URL, optional status, then the message. */
export function formatConsoleEntries(entries: readonly ConsoleEntry[]): string {
  if (entries.length === 0) {
    return EMPTY_CONSOLE_TEXT;
  }
  return entries.map(formatEntry).join('\n');
}

/** Bounded, newest-last buffer. Pushing past the cap drops the oldest entry. */
export class ConsoleBuffer {
  private items: ConsoleEntry[] = [];
  private readonly limit: number;

  constructor(limit = CONSOLE_BUFFER_LIMIT) {
    this.limit = limit;
  }

  push(entry: ConsoleEntry): void {
    const text =
      entry.text.length > CONSOLE_ENTRY_TEXT_LIMIT ? `${entry.text.slice(0, CONSOLE_ENTRY_TEXT_LIMIT - 3)}...` : entry.text;
    this.items.push({ ...entry, text });
    if (this.items.length > this.limit) {
      this.items.splice(0, this.items.length - this.limit);
    }
  }

  pushConsole(message: ConsoleMessageLike): void {
    this.push(consoleEntry(message));
  }

  pushPageError(error: unknown): void {
    this.push(pageErrorEntry(error));
  }

  pushRequestFailed(request: FailedRequestLike): void {
    this.push(requestFailedEntry(request));
  }

  pushResponse(response: ResponseLike): void {
    const entry = responseEntry(response);
    if (entry) {
      this.push(entry);
    }
  }

  clear(): void {
    this.items = [];
  }

  size(): number {
    return this.items.length;
  }

  entries(): readonly ConsoleEntry[] {
    return this.items.slice();
  }

  format(): string {
    return formatConsoleEntries(this.items);
  }
}

function formatEntry(entry: ConsoleEntry): string {
  const url = entry.url || '(no url)';
  const status = entry.status === undefined ? '' : ` [${entry.status}]`;
  const text = entry.text.replace(/\r?\n/g, ' ').trim();
  return `[${entry.level}] ${url}${status}: ${text}`;
}

function stackSummary(stack: string, message: string): string {
  const lines = stack
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const frame = lines.find((line) => /^at\s/.test(line));
  const summary = frame ?? lines.find((line) => line !== message && !line.endsWith(`: ${message}`)) ?? '';
  return summary.length > 160 ? `${summary.slice(0, 157)}...` : summary;
}
