import type { DefaultMode } from '../backends/types.ts';

/**
 * Which addresses the editor browser may open without asking.
 *
 * Only Ask mode prompts for an origin. In Agent and Plan, `browser_navigate`
 * opens the address directly and the turn's own permission level still governs
 * the agent's other actions. Within Ask mode, an http(s) origin opens only
 * after the user allowed that exact scheme, host and port for the session;
 * localhost has no special case.
 */

export type NavigationDecision = 'allow' | 'ask' | 'invalid';

/**
 * Whether opening an origin needs the user's decision.
 *
 * Ask mode is the only place the browser asks: it is the mode that exists to
 * confirm before the agent reads anything, and it always runs read-only. Agent
 * and Plan open the address without a second prompt; the level still governs
 * everything else the agent does.
 */
export function originApprovalRequired(mode: DefaultMode): boolean {
  return mode === 'ask';
}

/**
 * The exact origins the user allowed for the current browser session.
 *
 * Host-free so it can be tested without VS Code. `add` only records the origin;
 * the caller decides which user choice grants it.
 */
export class SessionOrigins {
  private readonly origins = new Set<string>();

  has(origin: string): boolean {
    return this.origins.has(origin);
  }

  add(origin: string): this {
    this.origins.add(origin);
    return this;
  }

  clear(): void {
    this.origins.clear();
  }
}

/** True unless the stored value is explicitly off. An unset setting stays on. */
export function browserSkillEnabled(value: unknown): boolean {
  return value !== false;
}

export type BrowserSkillProvider = 'codex' | 'opencode';

/**
 * Whether browser control is on for one provider.
 *
 * Prefers `browserCodex` / `browserOpencode`. When those are unset, falls back
 * to the legacy `browser` flag so an older settings.json still applies.
 */
export function browserSkillEnabledFor(
  provider: BrowserSkillProvider,
  settings: { browser?: unknown; browserCodex?: unknown; browserOpencode?: unknown }
): boolean {
  const specific = provider === 'codex' ? settings.browserCodex : settings.browserOpencode;
  if (specific !== undefined) {
    return browserSkillEnabled(specific);
  }
  return browserSkillEnabled(settings.browser);
}

/**
 * The user-configured value for a boolean setting, ignoring the package default.
 *
 * Needed so an unset `browserCodex` / `browserOpencode` can fall back to the
 * legacy `browser` key instead of always reading the schema default (`true`).
 */
export function configuredSettingValue<T>(
  inspect: { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined
): T | undefined {
  if (!inspect) {
    return undefined;
  }
  if (inspect.workspaceFolderValue !== undefined) {
    return inspect.workspaceFolderValue;
  }
  if (inspect.workspaceValue !== undefined) {
    return inspect.workspaceValue;
  }
  if (inspect.globalValue !== undefined) {
    return inspect.globalValue;
  }
  return undefined;
}

/**
 * `allow` only for an exact granted origin, `ask` for any other `http(s)`
 * address, `invalid` otherwise. Localhost has no special case.
 *
 * This reports whether a grant is missing, not whether the user must be
 * prompted: the caller pairs it with `originApprovalRequired` so Agent and Plan
 * can navigate without a prompt.
 *
 * The comparison uses `URL.origin`, so scheme, host alias and port all count:
 * granting `http://localhost:3000` does not grant port 5173, `127.0.0.1`,
 * `[::1]`, or `https://localhost:3000`.
 */
export function navigationDecision(
  url: string,
  grantedOrigins: { has(origin: string): boolean }
): NavigationDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'invalid';
  }
  if (grantedOrigins.has(parsed.origin)) {
    return 'allow';
  }
  return 'ask';
}

/** The origin a prompt names, or undefined when the address cannot be parsed. */
export function navigationOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * The body of the origin approval prompt.
 *
 * Says exactly what each choice covers and that allowing an origin also opens
 * the ungated click/type/press/snapshot tools in the tab the user is watching.
 */
export function originApprovalCopy(origin: string): string {
  return [
    `sideCode browser wants to open ${origin}.`,
    '',
    'Allowing this origin also lets the agent use browser_click, browser_type, browser_press and browser_snapshot in the browser tab you are watching.',
    'Redirects and in-page link or form navigation are not re-prompted; navigate explicitly to be asked again.',
    '',
    'Allow once: one navigation only; nothing is remembered.',
    `Allow for this session: later navigations to ${origin} until the browser is stopped.`,
    'Deny: the address is not opened.'
  ].join('\n');
}
