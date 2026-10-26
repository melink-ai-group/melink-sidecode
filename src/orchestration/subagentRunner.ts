import type {
  AgentBackend,
  AgentEvent,
  ContextPayload,
  ModelSettingOverrides,
  ThreadHandle
} from '../backends/types.ts';

/** A delegated assessment has its own provider thread, never the parent's. */
export const SUBAGENT_TIMEOUT_MS = 90_000;
export const SUBAGENT_OUTPUT_CHAR_LIMIT = 64_000;

export interface ReadOnlySubagentOptions {
  backend: Pick<AgentBackend,
    'permissionLevels' | 'startThread' | 'sendTurn' | 'onEvent' | 'cancel' | 'decideApproval'>;
  prompt: string;
  model?: string;
  modelSettings?: ModelSettingOverrides;
  context?: ContextPayload;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Register the child with its owner before any turn events are emitted. */
  onStarted?: (handle: ThreadHandle) => void;
  /** Compact tool/activity descriptions; assistant output is returned once. */
  onProgress?: (detail: string) => void;
}

/**
 * Run a bounded, read-only child on the selected provider/model. The caller
 * owns activity presentation and must isolate this thread from main-chat
 * persistence and change tracking. The backend is shared: never dispose it.
 * Approval escalation is always rejected, and cancellation targets this child
 * only. Missing permissions fail explicitly rather than silently widening them.
 */
export async function runReadOnlySubagent(options: ReadOnlySubagentOptions): Promise<string> {
  const { backend, signal } = options;
  if (!backend.permissionLevels.includes('read-only')) {
    throw new Error('This provider cannot enforce read-only subagents.');
  }
  if (!options.prompt.trim()) {
    throw new Error('A subagent task is required.');
  }
  if (signal?.aborted) {
    throw new Error('Subagent cancelled.');
  }

  let handle: ThreadHandle | undefined;
  let stopped = false;
  let completed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectStop!: (error: Error) => void;
  const stop = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  const abort = (): void => {
    stopped = true;
    rejectStop(new Error('Subagent cancelled.'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => {
    stopped = true;
    rejectStop(new Error('Subagent timed out.'));
  }, Math.max(1, options.timeoutMs ?? SUBAGENT_TIMEOUT_MS));

  let subscription: ReturnType<AgentBackend['onEvent']> | undefined;
  try {
    // A delayed start may resolve after cancellation; clean up its child too.
    const starting = backend.startThread({
      internalSubagent: true,
      permissionLevel: 'read-only',
      mode: 'agent',
      model: options.model,
      modelSettings: options.modelSettings,
      context: options.context
    }).then((started) => {
      if (stopped) {
        backend.cancel(started.threadId);
      }
      return started;
    });
    handle = await Promise.race([starting, stop]);
    options.onStarted?.(handle);
    const child = handle;
    const messages = new Map<string, string>();
    let outputSize = 0;
    const result = new Promise<string>((resolve, reject) => {
      const fail = (message: string): void => reject(new Error(message));
      const onEvent = (event: AgentEvent): void => {
        if (event.backendId !== child.backendId || event.threadId !== child.threadId) {
          return;
        }
        if (event.type === 'approval/requested') {
          backend.decideApproval(child.threadId, event.approval.id, 'reject');
        } else if (event.type === 'question/requested') {
          fail('Subagent requested user input; the main agent must resolve it.');
        } else if (event.type === 'item/started') {
          if (event.item.kind === 'message' && event.item.role === 'assistant') {
            const initial = event.item.text ?? '';
            if (!messages.has(event.item.id) || initial.length > 0) {
              outputSize += initial.length - (messages.get(event.item.id)?.length ?? 0);
              if (outputSize > SUBAGENT_OUTPUT_CHAR_LIMIT) {
                fail('Subagent response exceeded the output limit.');
                return;
              }
              messages.set(event.item.id, initial);
            }
          } else if (event.item.kind === 'tool') {
            options.onProgress?.((event.item.title ?? event.item.tool ?? 'Inspecting references').slice(0, 160));
          }
        } else if (event.type === 'item/delta' && messages.has(event.itemId)) {
          outputSize += event.delta.length;
          if (outputSize > SUBAGENT_OUTPUT_CHAR_LIMIT) {
            fail('Subagent response exceeded the output limit.');
            return;
          }
          messages.set(event.itemId, messages.get(event.itemId)! + event.delta);
        } else if (event.type === 'item/completed' && event.status === 'failed' && messages.has(event.itemId)) {
          fail('Subagent assessment failed.');
        } else if (event.type === 'turn/completed') {
          const final = [...messages.values()].reverse().find((text) => text.trim().length > 0)?.trim();
          if (!final) {
            fail('Subagent returned no assessment.');
          } else if (outputSize > SUBAGENT_OUTPUT_CHAR_LIMIT) {
            fail('Subagent response exceeded the output limit.');
          } else {
            completed = true;
            resolve(final);
          }
        } else if (event.type === 'turn/interrupted') {
          fail(event.canceled ? 'Subagent cancelled.' : 'Subagent was interrupted.');
        } else if (event.type === 'error') {
          fail('Subagent provider request failed.');
        }
      };
      subscription = backend.onEvent(onEvent);
    });
    const sending = backend.sendTurn(child, {
      text: [
        'This is a delegated read-only assessment. The main agent owns implementation, validation, and user decisions. Do not edit files, request elevated permissions, ask the user questions, or delegate further. Return the requested assessment only.',
        options.prompt
      ].join('\n\n'),
      permissionLevel: 'read-only',
      mode: 'agent',
      model: options.model ?? child.model,
      modelSettings: options.modelSettings,
      context: options.context
    });
    // Some providers acknowledge sendTurn before producing their final event.
    // A successful acknowledgement must therefore never finish the assessment.
    return await Promise.race([
      result,
      stop,
      sending.then(() => new Promise<never>(() => {}))
    ]);
  } finally {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
    signal?.removeEventListener('abort', abort);
    await subscription?.dispose();
    if (handle && !completed) {
      backend.cancel(handle.threadId);
    }
  }
}
