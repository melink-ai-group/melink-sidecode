import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequestKind,
  ApprovalRule
} from './types';

/**
 * Pure approval-rule logic: describing a request, building the rule a decision
 * would store, matching an incoming request against a rule, and scoping session
 * rules to a thread. Kept free of `vscode` and of the transport so the scoping
 * rules are unit-testable and the same shape is used by `always` and `session`.
 */

/** Human-readable label for what a request concerns, used on rules and cards. */
export function describeApproval(request: ApprovalRequest): string {
  switch (request.kind) {
    case 'command': {
      if (request.command) {
        return request.command;
      }
      return 'a command';
    }
    case 'file-change': {
      const paths = request.paths ?? [];
      if (paths.length === 1) {
        return `writes under ${paths[0]}`;
      }
      if (paths.length > 1) {
        return `writes under ${paths.length} paths`;
      }
      return 'file changes';
    }
    case 'permissions': {
      return request.network ? `network access to ${request.network}` : 'extra permissions';
    }
    default:
      return 'an action';
  }
}

/**
 * The scope a decision persists as. `allow-once` and `reject` persist nothing;
 * `always` becomes a global rule; `session` becomes a thread-scoped rule. This
 * is the single mapping from the user's decision to storage, so a decision can
 * never silently widen further than it claims.
 */
export function ruleScopeFor(decision: ApprovalDecision): 'none' | 'global' | 'session' {
  switch (decision) {
    case 'allow-always':
      return 'global';
    case 'allow-session':
      return 'session';
    case 'allow-once':
    case 'reject':
    default:
      return 'none';
  }
}

/**
 * Build the rule a decision stores. The rule records enough structure (kind,
 * command prefix, file roots, origin, and the native proposed amendment) to be
 * listed, matched and revoked later, and `scope` is the exact sentence shown
 * when listing it.
 */
export function ruleFor(
  request: ApprovalRequest,
  backendId: string,
  now: number = Date.now()
): ApprovalRule {
  const rule: ApprovalRule = {
    id: `rule_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    backendId,
    kind: request.kind,
    scope: describeApproval(request),
    origin: request.origin,
    createdAt: now
  };
  if (request.execPolicyAmendment && request.execPolicyAmendment.length > 0) {
    rule.execPolicyAmendment = [...request.execPolicyAmendment];
    rule.commandPrefix = [...request.execPolicyAmendment];
  } else if (request.kind === 'command' && request.command) {
    // No native amendment was offered, so fall back to the command's own first
    // token. That mirrors what the user was shown, rather than inventing a
    // broader prefix the CLI never proposed.
    rule.commandPrefix = commandPrefix(request.command);
  }
  if (request.kind === 'file-change') {
    if (request.paths && request.paths.length > 0) {
      rule.paths = [...request.paths];
    } else if (request.grantRoot) {
      rule.paths = [request.grantRoot];
    }
  }
  if (request.kind === 'permissions' && request.network) {
    rule.host = request.network;
  }
  return rule;
}

/** The first token of a command, used when no native amendment is available. */
export function commandPrefix(command: string): string[] {
  const token = command.trim().split(/\s+/, 1)[0];
  return token ? [token] : [];
}

/**
 * Whether a stored rule already covers an incoming request. A rule only matches
 * a request of the same kind, and each kind matches on its own recorded scope,
 * so a command rule can never be treated as an allow for a file write.
 */
export function ruleMatchesRequest(rule: ApprovalRule, request: ApprovalRequest): boolean {
  if (rule.kind !== request.kind) {
    return false;
  }
  switch (rule.kind) {
    case 'command': {
      const prefix = rule.commandPrefix ?? [];
      if (prefix.length === 0) {
        return false;
      }
      const tokens = tokenize(request.command ?? '');
      return prefix.length <= tokens.length && prefix.every((token, index) => tokens[index] === token);
    }
    case 'file-change': {
      const roots = rule.paths ?? [];
      if (roots.length === 0) {
        return false;
      }
      const paths = request.paths ?? [];
      if (paths.length === 0) {
        // A grant-root request with no explicit paths is covered only when the
        // rule is for that exact root.
        return request.grantRoot !== undefined && roots.includes(request.grantRoot);
      }
      return paths.every((path) => roots.some((root) => path.startsWith(root)));
    }
    case 'permissions': {
      if (!request.network) {
        return false;
      }
      return rule.host === request.network;
    }
    default:
      return false;
  }
}

/**
 * The first stored rule that covers a request, searching session rules (this
 * thread) before global ones. A hit means the request can proceed without
 * asking; a miss means the user must decide. Nothing here decides on its own.
 */
export function findMatchingRule(
  request: ApprovalRequest,
  sessionRules: readonly ApprovalRule[],
  globalRules: readonly ApprovalRule[]
): ApprovalRule | undefined {
  return (
    sessionRules.find((rule) => ruleMatchesRequest(rule, request)) ??
    globalRules.find((rule) => ruleMatchesRequest(rule, request))
  );
}

/** Key for one thread's session scope, shared by the store and the adapter. */
export function sessionKey(backendId: string, threadId: string): string {
  return `${backendId}:${threadId}`;
}

/** Split a command into tokens for prefix matching, preserving quoting groups. */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

/** The kinds a backend's approval channel is expected to surface. */
export const APPROVAL_REQUEST_KINDS: readonly ApprovalRequestKind[] = ['command', 'file-change', 'permissions'];
