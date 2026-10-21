import { CONSOLE_BUFFER_LIMIT } from './consoleBuffer.ts';
import { navigationDecision, navigationOrigin } from './policy.ts';

/** One MCP tool result. An image is a base64 PNG the model can look at. */
export interface ToolContent {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

/** The page operations a tool call can perform. Tests supply a fake. */
export interface BrowserActions {
  navigate(url: string): Promise<{ url: string; title: string }>;
  resize(width: number, height: number): Promise<{ width: number; height: number }>;
  snapshot(): Promise<{ text: string; pngBase64: string }>;
  click(input: { selector?: string; text?: string; x?: number; y?: number }): Promise<string>;
  type(text: string, selector?: string): Promise<void>;
  press(key: string): Promise<void>;
  console(): Promise<string>;
}

export interface BrowserTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const VIEWPORT = {
  type: 'object',
  properties: {
    width: { type: 'number', description: 'Viewport width in CSS pixels, from 200 to 3840.' },
    height: { type: 'number', description: 'Viewport height in CSS pixels, from 200 to 2160.' }
  },
  additionalProperties: false
};

/** The tool list both the shim and the model see. */
export const BROWSER_TOOLS: readonly BrowserTool[] = [
  {
    name: 'browser_navigate',
    description:
      'Open a URL in the editor browser tab the user is watching. Use the running app, usually localhost. Other sites ask the user before opening.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http or https URL.' } },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_resize',
    description: 'Set the viewport size, then the user sees that width in the editor tab. Use this to check a responsive layout.',
    inputSchema: {
      ...VIEWPORT,
      required: ['width', 'height']
    }
  },
  {
    name: 'browser_snapshot',
    description:
      'Read the page the user is seeing. Returns the accessibility tree and a screenshot of the current viewport.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'browser_console',
    description: `Return runtime diagnostics from the browser page since the last navigation: console messages, uncaught page errors, failed requests and HTTP responses with status 400 or above. Keeps the most recent ${CONSOLE_BUFFER_LIMIT} entries. The buffer clears when the address bar or browser_navigate starts a navigation; in-page links, reloads and form submissions do not clear it.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'browser_click',
    description: 'Click in the editor browser tab. Provide a CSS selector, visible text, or viewport x and y.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string', description: 'Visible text of the element to click.' },
        x: { type: 'number' },
        y: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'browser_type',
    description: 'Type text into the focused element, or into the element matching selector.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        selector: { type: 'string' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_press',
    description: 'Press a key in the editor browser tab, such as Enter, Tab, or Escape.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
      additionalProperties: false
    }
  }
];

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/**
 * Run one browser tool.
 *
 * `allow` is called only when the address is not localhost and not already
 * allowed. A denial does not navigate.
 */
export async function runBrowserTool(
  actions: BrowserActions,
  name: string,
  raw: unknown,
  allow: (origin: string) => Promise<boolean>,
  allowedOrigins: ReadonlySet<string>
): Promise<ToolResult> {
  const args = asRecord(raw);
  try {
    switch (name) {
      case 'browser_navigate':
        return await navigate(actions, args, allow, allowedOrigins);
      case 'browser_resize':
        return await resize(actions, args);
      case 'browser_snapshot':
        return await snapshot(actions);
      case 'browser_click':
        return textResult(await actions.click(clickInput(args)));
      case 'browser_type':
        return await typeText(actions, args);
      case 'browser_press':
        return await press(actions, args);
      case 'browser_console':
        return textResult(await actions.console());
      default:
        return textResult(`Unknown browser tool "${name}".`, true);
    }
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'The browser action failed.';
    return textResult(message, true);
  }
}

async function navigate(
  actions: BrowserActions,
  args: Record<string, unknown>,
  allow: (origin: string) => Promise<boolean>,
  allowedOrigins: ReadonlySet<string>
): Promise<ToolResult> {
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) {
    return textResult('Provide a url.', true);
  }
  const decision = navigationDecision(url, allowedOrigins);
  if (decision === 'invalid') {
    return textResult('Only http and https addresses can be opened.', true);
  }
  if (decision === 'ask') {
    const origin = navigationOrigin(url);
    if (!origin) {
      return textResult('Only http and https addresses can be opened.', true);
    }
    const accepted = await allow(origin);
    if (!accepted) {
      return textResult(`Navigation to ${origin} was denied.`, true);
    }
  }
  const page = await actions.navigate(url);
  return textResult(`Opened ${page.url}${page.title ? ` (${page.title})` : ''}.`);
}

async function resize(actions: BrowserActions, args: Record<string, unknown>): Promise<ToolResult> {
  const width = clampDimension(args.width, 200, 3840);
  const height = clampDimension(args.height, 200, 2160);
  if (width === undefined || height === undefined) {
    return textResult('Provide a width and a height in pixels.', true);
  }
  const size = await actions.resize(width, height);
  return textResult(`Viewport is ${size.width}×${size.height}.`);
}

async function snapshot(actions: BrowserActions): Promise<ToolResult> {
  const shot = await actions.snapshot();
  return {
    content: [
      { type: 'text', text: shot.text || 'The page has no accessibility tree.' },
      { type: 'image', data: shot.pngBase64, mimeType: 'image/png' }
    ]
  };
}

function clickInput(args: Record<string, unknown>): { selector?: string; text?: string; x?: number; y?: number } {
  const selector = typeof args.selector === 'string' ? args.selector : undefined;
  const text = typeof args.text === 'string' ? args.text : undefined;
  const x = typeof args.x === 'number' ? args.x : undefined;
  const y = typeof args.y === 'number' ? args.y : undefined;
  if (!selector && !text && (x === undefined || y === undefined)) {
    throw new Error('Provide a selector, visible text, or both x and y.');
  }
  return { selector, text, x, y };
}

async function typeText(actions: BrowserActions, args: Record<string, unknown>): Promise<ToolResult> {
  if (typeof args.text !== 'string') {
    return textResult('Provide the text to type.', true);
  }
  const selector = typeof args.selector === 'string' ? args.selector : undefined;
  await actions.type(args.text, selector);
  return textResult(selector ? `Typed into ${selector}.` : 'Typed into the focused element.');
}

async function press(actions: BrowserActions, args: Record<string, unknown>): Promise<ToolResult> {
  if (typeof args.key !== 'string' || args.key.trim().length === 0) {
    return textResult('Provide a key to press.', true);
  }
  await actions.press(args.key);
  return textResult(`Pressed ${args.key}.`);
}

function clampDimension(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
