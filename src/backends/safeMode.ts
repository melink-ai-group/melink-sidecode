import type { ApprovalRequest } from './types';
import {
  boundedCommand,
  classifyDestructiveCommand,
  redactCommand,
  type DestructiveCategory,
  type DestructiveMatch
} from './destructive.ts';

/**
 * The safety setting that runs before stored approval rules.
 *
 * A stored `Always allow` / `Allow for this conversation` rule is a convenience,
 * not a policy override. This layer names destructive commands and forces the
 * user to decide (or refuses them outright) even when a broad first-token rule
 * would match. It is a prompt gate only: it does not sandbox or rewrite the
 * command, and it never asks in `unrestricted` mode because that mode has no
 * approval path at all.
 */

export type SafeModeAction = 'off' | 'ask' | 'block';

export interface SafeModeSettings {
  destructiveCommands: SafeModeAction;
  destructivePatterns: readonly string[];
}

export const DEFAULT_SAFE_MODE_SETTINGS: SafeModeSettings = {
  destructiveCommands: 'ask',
  destructivePatterns: []
};

export interface SafeModeAllow {
  action: 'allow';
}

export interface SafeModeForce {
  action: 'ask' | 'block';
  category: DestructiveCategory;
  label: string;
  /** Risk plus the exact (bounded) command, with common credentials redacted. */
  reason: string;
  command: string;
}

export type SafeModeDecision = SafeModeAllow | SafeModeForce;

/** The minimal configuration reader the policy needs, so it stays testable. */
export interface SafeModeConfigReader {
  get<T>(key: string, defaultValue: T): T;
}

/**
 * The stored rule a request may use, unless safe mode is forcing a decision.
 *
 * `ask` deliberately hides the rule: the user must see the destructive request
 * even when a broad first-token rule would otherwise answer it. `block` and
 * `allow` never reach this helper with a live rule, but returning the lookup for
 * those actions keeps the call site honest.
 */
export function storedRuleUnlessAsk<T>(
  decision: SafeModeDecision,
  find: () => T | undefined
): T | undefined {
  return decision.action === 'ask' ? undefined : find();
}

/**
 * Decide what the safety layer wants for one approval request.
 *
 * `settings` is explicit so the policy is pure and unit-testable. When it is
 * omitted the contributed `melink.safety.*` values are read from the host; if
 * no host is available (plain Node tests) the documented defaults apply.
 */
export function safeModeDecision(
  request: ApprovalRequest,
  settings: SafeModeSettings = readSafeModeSettings()
): SafeModeDecision {
  if (request.kind !== 'command' || !request.command) {
    return { action: 'allow' };
  }
  if (settings.destructiveCommands === 'off') {
    return { action: 'allow' };
  }
  const match = classifyDestructiveCommand(request.command, settings.destructivePatterns);
  if (!match) {
    return { action: 'allow' };
  }
  const command = boundedCommand(redactCommand(request.command));
  const action = settings.destructiveCommands === 'block' ? 'block' : 'ask';
  const reason = promptReason(action, match, command);
  // Annotate the request too, so a caller that forwards the object shows the
  // same risk sentence even if it does not copy the decision field. The raw
  // `command` is left alone: rule matching must keep using it.
  request.reason = reason;
  request.displayCommand = command;
  return {
    action,
    category: match.category,
    label: match.label,
    reason,
    command
  };
}

/** The exact sentence shown on the card or in the denial notice. */
export function promptReason(action: 'ask' | 'block', match: DestructiveMatch, command: string): string {
  const risk = match.label;
  const bounded = boundedCommand(redactCommand(command));
  return action === 'block'
    ? `Blocked ${risk}: ${bounded}`
    : `This command matches a ${risk} and needs your approval: ${bounded}`;
}

/**
 * The effective contributed values, degraded to the documented defaults.
 *
 * The optional reader exists for tests; production always reads the host.
 */
export function readSafeModeSettings(config: SafeModeConfigReader | undefined = safetyConfiguration()): SafeModeSettings {
  if (!config) {
    return { ...DEFAULT_SAFE_MODE_SETTINGS, destructivePatterns: [] };
  }
  const action = config.get<string>('destructiveCommands', DEFAULT_SAFE_MODE_SETTINGS.destructiveCommands);
  const rawPatterns = config.get<unknown>('destructivePatterns', []);
  const patterns = Array.isArray(rawPatterns)
    ? rawPatterns.filter((pattern): pattern is string => typeof pattern === 'string')
    : [];
  return {
    destructiveCommands: isSafeModeAction(action) ? action : DEFAULT_SAFE_MODE_SETTINGS.destructiveCommands,
    destructivePatterns: patterns
  };
}

export function isSafeModeAction(value: unknown): value is SafeModeAction {
  return value === 'off' || value === 'ask' || value === 'block';
}

function safetyConfiguration(): SafeModeConfigReader | undefined {
  try {
    // Loaded lazily so the pure decision remains importable in Node tests.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode') as {
      workspace: { getConfiguration(section: string): SafeModeConfigReader };
    };
    return vscode.workspace.getConfiguration('melink.safety');
  } catch {
    return undefined;
  }
}
