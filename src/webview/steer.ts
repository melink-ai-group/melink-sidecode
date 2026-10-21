import type { BackendStatus } from '../backends/types';

/**
 * Codex steers in place; both Ollama profiles and the OpenCode adapter continue
 * the same live session. The list is capability data, not a UI preference, so
 * adding a provider means adding it here (and to the adapter's `steerTurn`).
 */
const STEERABLE_BACKEND_IDS = new Set<string>(['codex', 'ollama', 'ollama-local', 'opencode']);

export function acceptsSteer(backendId: string | undefined): boolean {
  return backendId !== undefined && STEERABLE_BACKEND_IDS.has(backendId);
}

export interface SteerContext {
  busy: boolean;
  backendId: string | undefined;
  backendStatus: BackendStatus | undefined;
  hasDraft: boolean;
  attachmentCount: number;
  restoring: boolean;
  pendingApproval: boolean;
  askingQuestion: boolean;
  modeSwitch: boolean;
}

/**
 * A busy turn accepts a steer only when the provider supports it and the
 * composer is otherwise idle. The same predicate gates Send while busy and the
 * steer/Stop swap.
 */
export function canSteer(context: SteerContext): boolean {
  return (
    context.busy &&
    acceptsSteer(context.backendId) &&
    context.backendStatus === 'available' &&
    context.hasDraft &&
    context.attachmentCount === 0 &&
    !context.restoring &&
    !context.pendingApproval &&
    !context.askingQuestion &&
    !context.modeSwitch
  );
}
