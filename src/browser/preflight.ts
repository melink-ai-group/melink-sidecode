import { navigationDecision, navigationOrigin } from './policy.ts';

/**
 * The decision `browser_navigate` needs before anything is launched.
 *
 * `missing` means no url was supplied, `invalid` means it is not http(s),
 * `ask` means the user must allow the exact origin, and `allow` means that
 * origin was already granted for this session. Pure so the ordering can be
 * tested without Edge, VS Code, or a panel.
 */
export type NavigationPreflight =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'ask'; url: string; origin: string }
  | { kind: 'allow'; url: string; origin: string };

export function preflightNavigation(
  raw: unknown,
  grantedOrigins: { has(origin: string): boolean }
): NavigationPreflight {
  const args =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) {
    return { kind: 'missing' };
  }
  const decision = navigationDecision(url, grantedOrigins);
  if (decision === 'invalid') {
    return { kind: 'invalid' };
  }
  const origin = navigationOrigin(url);
  if (!origin) {
    return { kind: 'invalid' };
  }
  return { kind: decision, url, origin };
}
