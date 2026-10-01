// Type-only: the store touches `globalState`/`workspaceState`, never the
// `vscode` runtime module, so its rule-set behaviour is unit-testable.
import type * as vscode from 'vscode';
import { ruleMatchesRequest, sessionKey } from './approvals.ts';
import type { ApprovalRequest, ApprovalRule } from './types';

const GLOBAL_RULES_KEY = 'melink.approval.globalRules';
const SESSION_RULES_KEY = 'melink.approval.sessionRules';

/**
 * Persists approval rules so a decision survives the scope it claims:
 *
 * - `always` rules go to `globalState`, because the user asked for a lasting
 *   rule that outlives the workspace.
 * - `session` rules go to `workspaceState`, keyed by `backendId:threadId`, so a
 *   window reload during a conversation neither asks again for a decision the
 *   user already made nor silently escalates to asking again mid-turn.
 * - Session rules are cleared when the thread ends, which is what makes the
 *   scope honest: `session` means this conversation, and nothing more.
 *
 * Only structure is stored — a kind, a command prefix or path root, an origin,
 * and the native proposed amendment. No command output, no file contents, and
 * never a credential.
 */
export class ApprovalStore implements vscode.Disposable {
  private globalCache?: ApprovalRule[];
  private sessionCache?: Record<string, ApprovalRule[]>;
  private readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /** `always` rules across every workspace, newest first. */
  listGlobalRules(): ApprovalRule[] {
    return [...this.loadGlobal()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** This thread's `session` rules, newest first. */
  listSessionRules(backendId: string, threadId: string): ApprovalRule[] {
    const rules = this.loadSessions()[sessionKey(backendId, threadId)] ?? [];
    return [...rules].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Every stored rule for a backend: session rules first, then global. */
  listRules(backendId: string, threadId?: string): ApprovalRule[] {
    const session = threadId ? this.listSessionRules(backendId, threadId) : [];
    const global = this.listGlobalRules();
    return [...session, ...global].filter((rule) => rule.backendId === backendId);
  }

  /**
   * The stored rule that already covers `request`, if any, checking this
   * thread's session scope before the global scope. `undefined` means the user
   * must decide; this never decides on its own. The returned scope lets the
   * adapter answer with the native decision the stored decision actually was.
   */
  match(
    backendId: string,
    threadId: string,
    request: ApprovalRequest
  ): { rule: ApprovalRule; scope: 'session' | 'global' } | undefined {
    const session = this.listSessionRules(backendId, threadId);
    const sessionMatch = session.find((rule) => ruleMatchesRequest(rule, request));
    if (sessionMatch) {
      return { rule: sessionMatch, scope: 'session' };
    }
    const globalMatch = this.listGlobalRules().find((rule) => ruleMatchesRequest(rule, request));
    return globalMatch ? { rule: globalMatch, scope: 'global' } : undefined;
  }

  /** Persist a rule at the scope its decision claimed. */
  async addRule(rule: ApprovalRule, scope: 'global' | 'session', threadId?: string): Promise<void> {
    if (scope === 'global') {
      const rules = this.loadGlobal().filter((entry) => entry.id !== rule.id);
      this.globalCache = [rule, ...rules];
      await this.context.globalState.update(GLOBAL_RULES_KEY, this.globalCache);
      return;
    }
    const key = sessionKey(rule.backendId, threadId ?? '');
    const sessions = this.loadSessions();
    const existing = sessions[key] ?? [];
    sessions[key] = [rule, ...existing.filter((entry) => entry.id !== rule.id)];
    this.sessionCache = sessions;
    await this.context.workspaceState.update(SESSION_RULES_KEY, sessions);
  }

  /** Remove one rule wherever it is stored. A miss is harmless. */
  async revokeRule(ruleId: string): Promise<void> {
    const global = this.loadGlobal();
    const filteredGlobal = global.filter((rule) => rule.id !== ruleId);
    if (filteredGlobal.length !== global.length) {
      this.globalCache = filteredGlobal;
      await this.context.globalState.update(GLOBAL_RULES_KEY, filteredGlobal);
    }
    const sessions = this.loadSessions();
    let changed = false;
    for (const [key, rules] of Object.entries(sessions)) {
      const filtered = rules.filter((rule) => rule.id !== ruleId);
      if (filtered.length !== rules.length) {
        sessions[key] = filtered;
        changed = true;
      }
    }
    if (changed) {
      this.sessionCache = sessions;
      await this.context.workspaceState.update(SESSION_RULES_KEY, sessions);
    }
  }

  /** Drop a thread's session rules; called when the conversation ends. */
  async clearSession(backendId: string, threadId: string): Promise<void> {
    const sessions = this.loadSessions();
    const key = sessionKey(backendId, threadId);
    if (!sessions[key]) {
      return;
    }
    delete sessions[key];
    this.sessionCache = sessions;
    await this.context.workspaceState.update(SESSION_RULES_KEY, sessions);
  }

  private loadGlobal(): ApprovalRule[] {
    if (!this.globalCache) {
      this.globalCache = this.context.globalState.get<ApprovalRule[]>(GLOBAL_RULES_KEY) ?? [];
    }
    return this.globalCache;
  }

  private loadSessions(): Record<string, ApprovalRule[]> {
    if (!this.sessionCache) {
      this.sessionCache = this.context.workspaceState.get<Record<string, ApprovalRule[]>>(SESSION_RULES_KEY) ?? {};
    }
    return this.sessionCache;
  }

  dispose(): void {
    // Nothing to release: the caches are plain data and writes are awaited by
    // their callers, so a reload cannot observe a half-written rule set.
  }
}
