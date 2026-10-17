/**
 * Which addresses the editor browser may open without asking.
 *
 * Localhost is the app the user is already running. Anything else is a
 * different site, so the user has to allow that origin once for the session.
 */

export type NavigationDecision = 'allow' | 'ask' | 'invalid';

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

/** `allow` for localhost, `ask` for another http(s) origin, `invalid` otherwise. */
export function navigationDecision(url: string, allowedOrigins: ReadonlySet<string>): NavigationDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'invalid';
  }
  if (isLocalHost(parsed.hostname)) {
    return 'allow';
  }
  if (allowedOrigins.has(parsed.origin)) {
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

function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
