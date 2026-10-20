import { spawn, type ChildProcess } from 'node:child_process';
import {
  isTerminalStepReason,
  opencodeStreamDetail,
  parseOpencodeEvent,
  sessionIdOf,
  type OpencodeEvent
} from './events.ts';
import { OPENCODE_CONFIG_ENV } from './config.ts';
import type { OpencodePermissionAsk, OpencodePermissionReply } from './approval.ts';
import type { ClarifyingQuestion } from '../../questions.ts';

/** One OpenCode question request, already reduced to the shared card shape. */
export interface OpencodeQuestionAsk {
  id: string;
  sessionId?: string;
  questions: ClarifyingQuestion[];
}

export type { OpencodeEvent } from './events.ts';

/** A spawned child whose stdout/stderr are piped, since stdin is ignored. */
type OpencodeChild = ChildProcess & { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream };

/**
 * The optional opencode agentic runtime, run once per turn.
 *
 * This module owns exactly one short-lived child process per turn. It is free of
 * `vscode`, so it is driven by the adapter and testable in isolation. It never
 * writes a file: the generated config is handed to the child purely through
 * `OPENCODE_CONFIG_CONTENT`, and the credential is handed over only through the
 * child's environment.
 *
 * ## Security
 *
 * The generated config declares only the credential variable's name
 * (`OLLAMA_API_KEY`), so the secret is never in the config text; this module
 * additionally asserts that invariant before spawn. The token reaches the child
 * only through `env`, and stderr is never logged or surfaced verbatim — only
 * classified.
 */

/** How a run ended, in the adapter's own vocabulary. */
export type OpencodeOutcome =
  | 'completed'
  | 'canceled'
  | 'stale-session'
  | 'cli-missing'
  | 'spawn'
  | 'invalid-config'
  | 'permission'
  | 'unauthenticated'
  | 'stream'
  | 'provider';

export interface OpencodeRunOptions {
  /** Executable resolved from `melink.ollama.opencode.path`. */
  executable: string;
  /** Working directory the agent runs in. */
  cwd: string;
  /** The generated config object; serialized to `OPENCODE_CONFIG_CONTENT`. */
  config: Record<string, unknown>;
  /** `provider/model` reference passed to `--model`. */
  modelRef: string;
  /** Agent passed to `--agent`. */
  agent: string;
  /** The user turn text. */
  prompt: string;
  /** Existing runtime session to resume, when one is recorded for this thread. */
  sessionId?: string;
  /** API credential; read into the child environment only under {@link apiKeyEnv}. */
  token: string;
  /**
   * Environment variable name that carries `token`. Defaults to `OLLAMA_API_KEY`
   * for the Ollama nested runtime; Zen uses `OPENCODE_API_KEY`.
   */
  apiKeyEnv?: string;
  /** Aborted by `cancel()`; terminates the child process tree. */
  signal?: AbortSignal;
  /**
   * When set, the turn is driven through `opencode serve` and every `ask`
   * permission is handed here. The promise must not resolve before the user
   * decides or {@link APPROVAL_WAIT_MS} elapses. Absent means `opencode run`,
   * which cannot show a prompt.
   */
  decidePermission?: (ask: OpencodePermissionAsk, signal: AbortSignal) => Promise<OpencodePermissionReply>;
  /**
   * Whether a new session may raise `question.asked`. Ask mode denies it.
   * Existing sessions keep the permission they were created with.
   */
  questionPermission?: 'ask' | 'deny';
  /**
   * When set, a `question.asked` event waits here instead of being rejected.
   * `'reject'` tells the server to drop the question.
   */
  answerQuestion?: (ask: OpencodeQuestionAsk, signal: AbortSignal) => Promise<string[][] | 'reject'>;
}

export interface OpencodeRunResult {
  outcome: OpencodeOutcome;
  /** The runtime session id observed during the run, if any. */
  sessionId?: string;
  /** Safe, plain-language detail for a failure; never a raw stack or the token. */
  detail?: string;
  /** True when a terminal `step_finish` (reason `stop`) was observed. */
  terminal: boolean;
}

/**
 * Run one turn and stream parsed events as they arrive. Resolves with the
 * classified outcome; never rejects for a provider failure. The caller decides
 * how to translate the outcome onto its normalized event union.
 */
export async function runOpencodeTurn(
  options: OpencodeRunOptions,
  onEvent: (event: OpencodeEvent) => void
): Promise<OpencodeRunResult> {
  const args = buildArgs(options);
  const env = buildEnv(options);

  // Belt-and-braces: a generated config must never carry the literal token, so
  // refuse to spawn if one ever did. This is a programming-error guard, and it
  // keeps the credential out of the child's argv and config even if a future
  // edit accidentally inlines a value.
  if (configContainsSecret(options.config, options.token)) {
    return {
      outcome: 'invalid-config',
      terminal: false,
      detail: 'The generated opencode config would contain the credential, so it was not started.'
    };
  }

  if (options.decidePermission) {
    const { runOpencodeServerTurn } = await import('./interactive.ts');
    return runOpencodeServerTurn(
      { ...options, decidePermission: options.decidePermission },
      onEvent
    );
  }

  let child: OpencodeChild;
  try {
    child = spawn(options.executable, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // No shell: the child must be direct so teardown reaches it without a
      // `cmd.exe` wrapper outliving the extension.
      shell: false,
      env
    });
  } catch (cause) {
    return { outcome: 'spawn', terminal: false, detail: describeSpawnFailure(cause) };
  }

  const state = {
    sessionId: options.sessionId,
    terminal: false,
    sawError: undefined as { message: string; statusCode?: number } | undefined,
    sawAnyEvent: false,
    sawPermissionReject: false,
    openTools: new Set<string>(),
    lastStepReason: undefined as string | undefined,
    spawnError: undefined as NodeJS.ErrnoException | undefined,
    stderrTail: '',
    aborted: false
  };

  const onAbort = (): void => {
    state.aborted = true;
    killProcessTree(child);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  let stdoutBuffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    state.sawAnyEvent = true;
    stdoutBuffer += chunk.toString();
    let newline = stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.trim()) {
        const event = parseOpencodeEvent(line);
        if (event.kind === 'malformed' && /permission requested|auto-rejecting/i.test(line)) {
          state.sawPermissionReject = true;
        }
        captureState(event, state);
        onEvent(event);
      }
      newline = stdoutBuffer.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    // Bounded tail, used only to classify a failure. Never surfaced verbatim:
    // the child could echo a credential, and this adapter must not expose one.
    const text = chunk.toString();
    if (/permission requested|auto-rejecting/i.test(text)) {
      // A headless `ask` is auto-rejected rather than prompted; that is a real
      // outcome to report, not a dropped stream.
      state.sawPermissionReject = true;
    }
    state.stderrTail = `${state.stderrTail}${text}`.slice(-4_000);
  });
  child.on('error', (error: NodeJS.ErrnoException) => {
    state.spawnError = error;
  });

  const exit = await waitForExit(child);
  options.signal?.removeEventListener('abort', onAbort);

  // Flush a trailing line with no newline terminator.
  if (stdoutBuffer.trim()) {
    const event = parseOpencodeEvent(stdoutBuffer);
    captureState(event, state);
    onEvent(event);
  }

  const common = { sessionId: state.sessionId, terminal: state.terminal };
  if (state.aborted || options.signal?.aborted) {
    return { ...common, outcome: 'canceled' };
  }
  if (state.spawnError?.code === 'ENOENT') {
    return {
      ...common,
      outcome: 'cli-missing',
      detail: `The opencode CLI was not found at "${options.executable}".`
    };
  }
  if (state.spawnError) {
    return { ...common, outcome: 'spawn', detail: `The opencode CLI could not be started: ${state.spawnError.code ?? 'unknown error'}.` };
  }
  if (isStaleSession(state.stderrTail, exit.code, state.sawAnyEvent)) {
    return { ...common, outcome: 'stale-session', detail: 'The saved opencode session is no longer available.' };
  }
  if (state.sawError) {
    if (state.sawError.statusCode === 401 || state.sawError.statusCode === 403) {
      return { ...common, outcome: 'unauthenticated', detail: 'The API credential was rejected.' };
    }
    return { ...common, outcome: 'provider', detail: state.sawError.message };
  }
  if (exit.code !== 0 && !state.sawAnyEvent) {
    if (/JSON Parse error|Unexpected error|Invalid config/i.test(state.stderrTail)) {
      return {
        ...common,
        outcome: 'invalid-config',
        detail: 'The generated opencode config was rejected.'
      };
    }
    return { ...common, outcome: 'spawn', detail: 'The opencode CLI exited before it produced any output.' };
  }
  if (state.sawPermissionReject && !state.terminal) {
    // The turn stopped because a tool action required approval, which a headless
    // run cannot grant. This is distinct from a dropped stream: nothing failed,
    // the action was refused, and the user can rerun at a level that permits it.
    return {
      ...common,
      outcome: 'permission',
      detail: 'A tool action needed approval, which a headless turn cannot grant, so it was not run.'
    };
  }
  if (!state.terminal) {
    // JSON mode sometimes exits 0 after the tools have finished and drops the
    // final `step_finish`. That is a completed turn. A process that dies while
    // a tool is still running, or right after it asked for tool calls, is not.
    if (cleanOpencodeExit(exit.code, state)) {
      return { ...common, outcome: 'completed', terminal: true };
    }
    return {
      ...common,
      outcome: 'stream',
      detail: opencodeStreamDetail(state.lastStepReason)
    };
  }
  return { ...common, outcome: 'completed' };
}

/** Build the argv for `opencode run`. Flags are the pinned version's own. */
export function buildArgs(options: OpencodeRunOptions): string[] {
  const args = ['run', options.prompt, '--format', 'json', '--model', options.modelRef, '--agent', options.agent];
  if (options.sessionId) {
    args.push('--session', options.sessionId);
  }
  return args;
}

/** Default credential env for the Ollama nested OpenCode runtime. */
export const DEFAULT_OPENCODE_API_KEY_ENV = 'OLLAMA_API_KEY';

/** Build the child environment; the config and the token travel only here. */
export function buildEnv(options: OpencodeRunOptions): NodeJS.ProcessEnv {
  const apiKeyEnv = options.apiKeyEnv?.trim() || DEFAULT_OPENCODE_API_KEY_ENV;
  return {
    ...process.env,
    // The generated config wins on overlapping keys, so a workspace cannot
    // disable the active agent or widen its permission block.
    [OPENCODE_CONFIG_ENV]: JSON.stringify(options.config),
    [apiKeyEnv]: options.token
  };
}

/** Whether the serialized config contains the literal token anywhere. */
function configContainsSecret(config: Record<string, unknown>, token: string): boolean {
  if (!token) {
    return false;
  }
  try {
    return JSON.stringify(config).includes(token);
  } catch {
    // A non-serializable config is caught by the spawn failure path.
    return false;
  }
}

/**
 * A zero exit after real output, with no tool left running, finished the turn
 * even when `step_finish` was dropped. A recorded reason other than `stop`
 * (the output limit, a request for more tool calls) did not finish it.
 */
export function cleanOpencodeExit(
  exitCode: number | null,
  state: { sawAnyEvent: boolean; openTools: ReadonlySet<string>; lastStepReason?: string }
): boolean {
  const droppedFinish = state.lastStepReason === undefined || state.lastStepReason === 'stop';
  return exitCode === 0 && state.sawAnyEvent && state.openTools.size === 0 && droppedFinish;
}

function captureState(
  event: OpencodeEvent,
  state: {
    sessionId?: string;
    terminal: boolean;
    sawError?: { message: string; statusCode?: number };
    sawAnyEvent: boolean;
    openTools: Set<string>;
    lastStepReason?: string;
  }
): void {
  const sessionId = sessionIdOf(event);
  if (sessionId) {
    state.sessionId = sessionId;
  }
  if (event.kind === 'tool') {
    if (event.status === 'pending' || event.status === 'running') {
      state.openTools.add(event.callId);
    } else {
      state.openTools.delete(event.callId);
    }
  }
  if (event.kind === 'step-finish') {
    state.lastStepReason = event.reason;
    if (isTerminalStepReason(event.reason)) {
      state.terminal = true;
    }
  }
  if (event.kind === 'error') {
    state.sawError = { message: event.message, statusCode: event.statusCode };
  }
}

/**
 * Whether a failure is a stale session rather than a fresh problem. opencode
 * names the missing session file on stderr and produces no events, so both must
 * hold before the adapter degrades to a fresh session.
 */
function isStaleSession(stderr: string, exitCode: number | null, sawAnyEvent: boolean): boolean {
  if (sawAnyEvent) {
    return false;
  }
  if (!/session/i.test(stderr)) {
    return false;
  }
  return /Resource not found|NotFoundError|not found/i.test(stderr) || exitCode !== 0;
}

function describeSpawnFailure(cause: unknown): string {
  return cause instanceof Error ? `The opencode CLI could not be started: ${cause.message}` : 'The opencode CLI could not be started.';
}

/**
 * Terminate a spawned opencode and anything it spawned.
 *
 * On Windows a wrapper can sit between the extension and the real process;
 * `taskkill /T` walks the tree. On POSIX the child gets a SIGKILL, since the
 * turn is being abandoned rather than asked to stop gracefully.
 */
export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
    killer.on('error', () => child.kill('SIGKILL'));
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

function waitForExit(child: OpencodeChild): Promise<{ code: number | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode });
  }
  return new Promise((resolve) => {
    child.once('close', (code) => resolve({ code }));
    child.once('error', () => resolve({ code: null }));
  });
}
