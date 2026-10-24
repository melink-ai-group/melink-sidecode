/**
 * The one local attention decision a finished turn may make.
 *
 * It reads status only: plan shape and the autopilot decision, plus a terminal
 * check status. It never reads check output, a diff, file content or plan text,
 * and it never sends, queues or repairs anything. The notice points at evidence
 * that already exists in its owning card.
 */

export type AttentionTrigger = 'plan' | 'check';

export type AttentionKind = 'plan-remaining' | 'check-failed';

export type AttentionAction = 'preparePlanFollowUp' | 'prepareCheckFollowUp';

export type AttentionPlanDecision = 'continue' | 'hold';

export type AttentionCheckStatus =
  | 'not-run'
  | 'untrusted'
  | 'skipped'
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'cancelled';

export interface AttentionPlanFacts {
  built: boolean;
  planning: boolean;
  remaining: number;
  epochCurrent: boolean;
  hold: boolean;
  autopilot: AttentionPlanDecision;
}

export interface AttentionCheckFacts {
  status: AttentionCheckStatus;
}

export interface AttentionInput {
  trigger: AttentionTrigger;
  mode: string;
  terminus: 'completed' | 'interrupted';
  quick: boolean;
  sameSession: boolean;
  sameThread: boolean;
  currentTurn: boolean;
  pendingQuestion: boolean;
  pendingApproval: boolean;
  plan?: AttentionPlanFacts;
  check?: AttentionCheckFacts;
}

export interface AttentionNotice {
  kind: AttentionKind;
  level: 'info' | 'warning';
  message: string;
  action: AttentionAction;
}

export const ATTENTION_LEDGER_LIMIT = 256;

export function attentionKey(backendId: string, threadId: string, turnId: string): string {
  return `${backendId}:${threadId}:${turnId}`;
}

export function attentionFollowUpText(kind: AttentionKind): string {
  return kind === 'plan-remaining'
    ? 'Continue the remaining steps of this plan.'
    : "The post-turn checks failed. Investigate the failure, fix it, and rerun the project's checks.";
}

export function decideAttention(input: AttentionInput): AttentionNotice | undefined {
  if (!commonEligible(input)) {
    return undefined;
  }
  if (input.trigger === 'plan') {
    return planNotice(input.plan);
  }
  return checkNotice(input.check);
}

function commonEligible(input: AttentionInput): boolean {
  return (
    input.mode === 'agent' &&
    input.terminus === 'completed' &&
    !input.quick &&
    input.sameSession &&
    input.sameThread &&
    input.currentTurn &&
    !input.pendingQuestion &&
    !input.pendingApproval
  );
}

function planNotice(plan: AttentionPlanFacts | undefined): AttentionNotice | undefined {
  if (
    !plan ||
    !plan.planning ||
    !plan.built ||
    plan.remaining <= 0 ||
    !plan.epochCurrent ||
    plan.hold ||
    plan.autopilot !== 'hold'
  ) {
    return undefined;
  }
  return {
    kind: 'plan-remaining',
    level: 'info',
    message: planRemainingMessage(plan.remaining),
    action: 'preparePlanFollowUp'
  };
}

function checkNotice(check: AttentionCheckFacts | undefined): AttentionNotice | undefined {
  if (!check || check.status !== 'failed') {
    return undefined;
  }
  return {
    kind: 'check-failed',
    level: 'warning',
    message: 'The post-turn checks failed. See the change card for details.',
    action: 'prepareCheckFollowUp'
  };
}

function planRemainingMessage(remaining: number): string {
  return remaining === 1
    ? '1 plan step still remains.'
    : `${remaining} plan steps still remain.`;
}

export class AttentionLedger {
  private readonly keys = new Set<string>();
  private readonly order: string[] = [];

  get size(): number {
    return this.keys.size;
  }

  claim(key: string): boolean {
    if (!key || this.keys.has(key)) {
      return false;
    }
    this.keys.add(key);
    this.order.push(key);
    while (this.order.length > ATTENTION_LEDGER_LIMIT) {
      const oldest = this.order.shift();
      if (oldest !== undefined) {
        this.keys.delete(oldest);
      }
    }
    return true;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  clear(): void {
    this.keys.clear();
    this.order.length = 0;
  }
}
