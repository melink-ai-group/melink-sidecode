/**
 * Pure message assembly for providers that take a chat-style message list.
 *
 * The direct Ollama adapter is the only current consumer, but the ordering rule
 * is provider-neutral and unit-testable here (this module imports no `vscode`
 * and no provider SDK):
 *
 *   1. the full snapshot as a `system` message, once per session, before the
 *      first user turn;
 *   2. the prior user/assistant history unchanged;
 *   3. a compact per-turn delta as a `system` message, just before the new user
 *      turn;
 *   4. the new user turn.
 *
 * Context is therefore always `system`-role input. It is never folded into a
 * user turn, and never returned as something a transcript store might persist.
 */

import type { ContextPayload } from './types.ts';

/** The minimal chat message shape every chat-style provider shares. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Build the request message list from prior user/assistant history, the new user
 * text, and the rendered context payload.
 *
 * `history` must contain only persisted user/assistant turns; this function
 * never mutates it and never adds context to it, so a caller that persists
 * `history` can never persist the synthetic context.
 */
export function buildContextMessages(
  history: readonly ChatMessage[],
  text: string,
  context?: ContextPayload
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // The snapshot is the stable, cacheable prefix. A notice is the degraded
  // substitute used when a snapshot could not be built. The snapshot wins when
  // both are present, so a stale notice never masks a good snapshot.
  if (context?.snapshot) {
    messages.push({ role: 'system', content: context.snapshot });
  } else if (context?.notice) {
    messages.push({ role: 'system', content: context.notice });
  }

  for (const message of history) {
    messages.push({ role: message.role, content: message.content });
  }

  // The delta is per-turn and system-role only.
  if (context?.delta) {
    messages.push({ role: 'system', content: context.delta });
  }

  // The bounded symbol/import map is per-turn too, alongside the delta.
  if (context?.repoMap) {
    messages.push({ role: 'system', content: context.repoMap });
  }

  // The viewed file is also per-turn. It is never folded into the user text,
  // so the transcript does not persist it.
  if (context?.attachedFile) {
    messages.push({ role: 'system', content: context.attachedFile });
  }

  messages.push({ role: 'user', content: text });
  return messages;
}
