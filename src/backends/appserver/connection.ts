import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { Emitter } from '../base.ts';
import type { Disposable } from '../types.ts';
import {
  CODEX_VERSION_VALIDATION_HINT,
  codexVersionFromUserAgent,
  isAcceptedCodexVersion,
  supportedCodexVersionRange
} from './version.ts';
import {
  DEFAULT_BACKOFF,
  RetryExhaustedError,
  retryWithBackoff,
  type BackoffOptions
} from './backoff.ts';
import {
  drainLines,
  encodeNotification,
  encodeRequest,
  encodeSuccess,
  encodeError,
  isServerOverloaded,
  JsonRpcError,
  parseMessage,
  type JsonRpcIncomingRequest,
  type JsonRpcNotification,
  type JsonRpcResponse
} from './jsonrpc.ts';
import { codexAuthPreferenceArgs, scrubbedCodexEnv } from '../codex/env.ts';
import type { InitializeParams } from '../../../schemas/InitializeParams';
import type { InitializeResponse } from '../../../schemas/InitializeResponse';
import type { ThreadStartParams } from '../../../schemas/v2/ThreadStartParams';
import type { ThreadStartResponse } from '../../../schemas/v2/ThreadStartResponse';
import type { ThreadResumeParams } from '../../../schemas/v2/ThreadResumeParams';
import type { ThreadResumeResponse } from '../../../schemas/v2/ThreadResumeResponse';
import type { ThreadListParams } from '../../../schemas/v2/ThreadListParams';
import type { ThreadListResponse } from '../../../schemas/v2/ThreadListResponse';
import type { ThreadTurnsListParams } from '../../../schemas/v2/ThreadTurnsListParams';
import type { ThreadTurnsListResponse } from '../../../schemas/v2/ThreadTurnsListResponse';
import type { ThreadItemsListParams } from '../../../schemas/v2/ThreadItemsListParams';
import type { ThreadItemsListResponse } from '../../../schemas/v2/ThreadItemsListResponse';
import type { TurnStartParams } from '../../../schemas/v2/TurnStartParams';
import type { TurnStartResponse } from '../../../schemas/v2/TurnStartResponse';
import type { TurnInterruptParams } from '../../../schemas/v2/TurnInterruptParams';
import type { ThreadCompactStartParams } from '../../../schemas/v2/ThreadCompactStartParams';
import type { ThreadCompactStartResponse } from '../../../schemas/v2/ThreadCompactStartResponse';
import type { TurnSteerParams } from '../../../schemas/v2/TurnSteerParams';
import type { TurnSteerResponse } from '../../../schemas/v2/TurnSteerResponse';
import type { ModelListParams } from '../../../schemas/v2/ModelListParams';
import type { ModelListResponse } from '../../../schemas/v2/ModelListResponse';
import type { GetAuthStatusParams } from '../../../schemas/GetAuthStatusParams';
import type { GetAuthStatusResponse } from '../../../schemas/GetAuthStatusResponse';

/** Why a connection failed before it could be used. */
export type ConnectionFailure = 'unavailable' | 'incompatible' | 'protocol' | 'closed';

/** Raised when the CLI cannot be launched or the handshake does not complete. */
export class ConnectionError extends Error {
  readonly kind: ConnectionFailure;
  /**
   * The app-server's self-reported version, when the failure is a handshake
   * disagreement or a range mismatch. Carried so the `incompatible` status can
   * name the version instead of rendering a generic dead backend.
   */
  readonly serverVersion?: string;

  constructor(kind: ConnectionFailure, message: string, cause?: unknown, serverVersion?: string) {
    super(message);
    this.name = 'ConnectionError';
    this.kind = kind;
    this.serverVersion = serverVersion;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * Raised when the app-server reports a version outside the pinned protocol
 * window. Distinct from a launch failure: the binary exists and answered, but
 * its protocol is not the one the checked-in `schemas/` describe.
 */
export class ServerVersionMismatchError extends ConnectionError {
  readonly reportedVersion: string;

  constructor(reportedVersion: string) {
    super(
      'incompatible',
      `Codex app-server version ${reportedVersion} is outside the supported protocol range ${supportedCodexVersionRange()}. ${CODEX_VERSION_VALIDATION_HINT}`,
      undefined,
      reportedVersion
    );
    this.name = 'ServerVersionMismatchError';
    this.reportedVersion = reportedVersion;
  }
}

/** An outstanding request, with the timer that bounds its wait. */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ConnectionOptions {
  /** Executable resolved from `melink.codex.path`. */
  executable: string;
  /** Working directory handed to `thread/start`. */
  cwd: string;
  /** Bounded time allowed for spawn + initialize to reach a usable state. */
  startTimeoutMs?: number;
  /** Client identity reported during `initialize`. */
  clientInfo?: { name: string; title: string; version: string };
  /** Retry policy for the `-32001` overload signal. */
  backoff?: BackoffOptions;
  /**
   * Diagnostic sink for the spawn form that succeeded. The connection never
   * logs a credential or a raw stderr line; it logs only which argument form
   * started, so a future argument drift is visible rather than silent.
   */
  log?: (message: string) => void;
  /**
   * Child-process factory, injectable so the spawn-form retry is unit-testable
   * without launching a real CLI. Defaults to `node:child_process.spawn`.
   */
  spawnImpl?: typeof spawn;
  /**
   * Exact versions a previous Validate version run allowed, in addition to the
   * built-in protocol window.
   */
  allowedVersions?: readonly string[];
  /**
   * Complete the handshake even when the server version is outside the window.
   * Only the version validator sets this. A normal connection still refuses
   * the version so an unchecked CLI is never used.
   */
  acceptOutOfRangeVersion?: boolean;
}

/** One way to launch the app-server, tried in order. */
export interface SpawnForm {
  label: string;
  args: string[];
}

/**
 * The argument forms tried in order. `--listen stdio://` is the explicit form
 * the previously verified pin used; the bare command is the current documented
 * default, so if a newer CLI rejects the explicit flag the adapter still starts.
 */
export const APP_SERVER_SPAWN_FORMS: readonly SpawnForm[] = [
  { label: 'app-server --listen stdio://', args: ['app-server', '--listen', 'stdio://'] },
  { label: 'app-server', args: ['app-server'] }
];

const DEFAULT_START_TIMEOUT_MS = 15_000;
/** Grace after closing stdin before signalling. */
const STDIN_EXIT_GRACE_MS = 1_500;
/** Grace after SIGTERM before an unignorable kill. */
const TERM_EXIT_GRACE_MS = 2_000;

const DEFAULT_CLIENT_INFO = {
  name: 'melink-sidecode',
  title: 'SideCode',
  version: '0.2.0'
};

/**
 * One long-lived stdio connection to `codex app-server`.
 *
 * The transport is newline-delimited JSON-RPC 2.0 with `"jsonrpc"` omitted on
 * the wire. This class owns the child process, the two-step handshake, request
 * correlation, and teardown. It emits raw notifications and server requests and
 * leaves provider-neutral translation to the adapter.
 *
 * The connection is deliberately lazy and single-use: `start()` spawns and
 * initializes exactly once, and `dispose()` makes the instance unusable. A
 * caller that needs to reconnect constructs a new instance.
 */
export class AppServerConnection implements Disposable {
  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<InitializeResponse>;
  private started = false;
  private disposed = false;
  private disposing?: Promise<void>;
  private nextId = 1;
  private stdoutBuffer = '';
  private stdoutDecoder = new StringDecoder('utf8');
  private stderrTail = '';
  /** The argument form that actually started, for the diagnostic log. */
  private spawnForm?: string;
  private readonly pending = new Map<number, PendingRequest>();

  private readonly notificationEmitter = new Emitter<JsonRpcNotification>();
  readonly onNotification = this.notificationEmitter.event;

  private readonly serverRequestEmitter = new Emitter<JsonRpcIncomingRequest>();
  readonly onServerRequest = this.serverRequestEmitter.event;

  private readonly closeEmitter = new Emitter<{ code: number | null; expected: boolean }>();
  readonly onClose = this.closeEmitter.event;

  private readonly backoff: BackoffOptions;
  private readonly options: ConnectionOptions;

  constructor(options: ConnectionOptions) {
    this.options = options;
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** True once the handshake has completed and the process is usable. */
  get ready(): boolean {
    return this.started && !this.disposed;
  }

  /** The `initialize` response, including the CLI's self-reported user agent. */
  private initializeResult?: InitializeResponse;

  get serverInfo(): InitializeResponse | undefined {
    return this.initializeResult;
  }

  /** The argument form that established the connection, once started. */
  get startedWith(): string | undefined {
    return this.spawnForm;
  }

  /**
   * Spawn the CLI and complete the handshake. Calling twice returns the first
   * result; after `dispose()` it rejects. A missing binary rejects with
   * `ConnectionError('unavailable')` before anything is written.
   */
  start(): Promise<InitializeResponse> {
    if (this.startPromise) {
      return this.startPromise;
    }
    if (this.disposed) {
      return Promise.reject(new ConnectionError('closed', 'The Codex app-server connection was disposed.'));
    }
    this.startPromise = this.spawnAndInitialize().catch((error) => {
      // A failed start is terminal: never keep a half-open process around.
      this.hardStop();
      throw error;
    });
    return this.startPromise;
  }

  private spawnAndInitialize(): Promise<InitializeResponse> {
    // The app-server's stdio transport is the default, so `--listen stdio://`
    // is redundant and a newer CLI may reject it outright. Try the explicit
    // form first (it is what the previously verified pin used), then fall back
    // to the bare command once. Whichever form starts is logged so the drift is
    // visible instead of being hidden behind `unavailable`.
    return this.trySpawnForms([...APP_SERVER_SPAWN_FORMS]);
  }

  private async trySpawnForms(forms: SpawnForm[]): Promise<InitializeResponse> {
    let lastError: unknown;
    for (let index = 0; index < forms.length; index += 1) {
      try {
        return await this.attemptStart(forms[index]);
      } catch (error) {
        lastError = error;
        this.stopChildIfCurrent();
        // A missing binary is not an argument problem: retrying the other form
        // would spawn a second failing process and cannot help. A version
        // mismatch and a disposed connection are equally terminal. Only an
        // early close (a rejected argument exits non-zero before answering the
        // handshake) is worth one retry.
        if (!shouldRetrySpawn(error, index < forms.length - 1)) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  private attemptStart(form: SpawnForm): Promise<InitializeResponse> {
    const { executable, cwd } = this.options;
    const launch = this.options.spawnImpl ?? spawn;
    // The ChatGPT auth preference is passed ahead of the subcommand as a
    // per-invocation config override, so behaviour does not depend on the
    // user's `~/.codex/config.toml`. The child env is scrubbed of inherited
    // credentials and base-URL overrides so the only credential Codex can see
    // is the ChatGPT one in `$CODEX_HOME/auth.json`; `HOME`, `USERPROFILE`,
    // `PATH`, and `CODEX_HOME` are preserved so that file stays discoverable.
    const args = [...codexAuthPreferenceArgs(), ...form.args];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = launch(executable, args, {
        cwd,
        env: scrubbedCodexEnv(process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // No shell: the app-server must be a direct child so teardown can reach
        // it without a `cmd.exe` wrapper outliving the extension.
        shell: false
      });
    } catch (cause) {
      throw new ConnectionError('unavailable', `Cannot launch Codex CLI "${executable}".`, cause);
    }
    // A retry replaces the child reference; guard every listener so the failed
    // attempt's late events cannot corrupt the new attempt's buffers or settle
    // its requests.
    this.child = child;
    this.stdoutBuffer = '';
    this.stdoutDecoder = new StringDecoder('utf8');
    this.stderrTail = '';

    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child === child) {
        this.onStdout(this.stdoutDecoder.write(chunk));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.child === child) {
        this.onStderr(chunk.toString());
      }
    });
    child.on('error', (cause: NodeJS.ErrnoException) => {
      if (this.child === child) {
        this.onProcessError(cause);
      }
    });
    child.on('close', (code) => {
      if (this.child === child) {
        this.onProcessClose(code);
      }
    });

    return this.request<InitializeResponse>(
      'initialize',
      {
        clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
        capabilities: { experimentalApi: true, requestAttestation: false }
      } satisfies InitializeParams,
      { timeoutMs: this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS, retryable: false }
    )
      .catch((error: unknown) => this.classifyHandshakeFailure(error))
      .then((result) => {
        // The server reports its own version on the initialize user agent. A
        // version outside the pinned protocol window means the checked-in
        // `schemas/` no longer describe this server, so it is reported as a
        // specific `incompatible` carrying the version rather than used blindly.
        const reported = codexVersionFromUserAgent(result.userAgent);
        const accepted = !reported || isAcceptedCodexVersion(reported, this.options.allowedVersions);
        if (reported && !accepted && !this.options.acceptOutOfRangeVersion) {
          throw new ServerVersionMismatchError(reported);
        }
        // `initialized` is the second half of the handshake and carries no params.
        this.notify('initialized');
        this.initializeResult = result;
        this.started = true;
        this.spawnForm = form.label;
        // Logging the form is diagnostic only; it never carries a credential or
        // a raw stderr line (the CLI could echo one).
        this.options.log?.(`Codex app-server started with: ${form.label}`);
        return result;
      });
  }

  /**
   * Turn a handshake failure into a typed one. A timeout is not proof the
   * binary is missing — the process started and simply never answered an
   * `initialize` shape it disagreed with — so it is reported as `incompatible`
   * carrying the CLI's own `--version`, which is the specific diagnostic the
   * silent-timeout path could not previously provide.
   */
  private async classifyHandshakeFailure(error: unknown): Promise<never> {
    if (error instanceof ConnectionError && error.kind === 'protocol' && isHandshakeTimeout(error)) {
      const version = await queryCliVersion(this.options.executable);
      throw new ConnectionError(
        'incompatible',
        version
          ? `Codex app-server ${version} did not answer the pinned initialize handshake. ${CODEX_VERSION_VALIDATION_HINT}`
          : `The Codex app-server did not answer the pinned initialize handshake. ${CODEX_VERSION_VALIDATION_HINT}`,
        error,
        version
      );
    }
    throw error;
  }

  /** Best-effort teardown of a failed spawn attempt before the next form. */
  private stopChildIfCurrent(): void {
    const child = this.child;
    this.child = undefined;
    this.rejectAll(new ConnectionError('closed', 'The Codex app-server spawn attempt failed.'));
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      killProcessTree(child);
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const { lines, remainder } = drainLines(this.stdoutBuffer);
    this.stdoutBuffer = remainder;
    for (const line of lines) {
      this.applyLine(line);
    }
  }

  /**
   * Apply one stdout line. A listener that throws must not abandon the rest of
   * the buffer: that is how a turn stops mid-reply with no further events.
   */
  private applyLine(line: string): void {
    try {
      this.handleLine(line);
    } catch {
      this.options.log?.('A Codex notification could not be applied.');
    }
  }

  /** A process can exit with the last JSON object still missing its newline. */
  private flushStdoutTail(): void {
    this.onStdout(this.stdoutDecoder.end());
    const tail = this.stdoutBuffer.trim();
    this.stdoutBuffer = '';
    if (tail) {
      this.applyLine(tail);
    }
  }

  private onStderr(chunk: string): void {
    // Bounded tail, used only to explain a failed start. Never logged verbatim:
    // the CLI could echo a credential, and this adapter must not surface one.
    this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2_000);
  }

  private handleLine(line: string): void {
    const message = parseMessage(line);
    switch (message.kind) {
      case 'response':
        this.resolveResponse(message);
        break;
      case 'notification':
        this.notificationEmitter.fire(message);
        break;
      case 'request':
        this.serverRequestEmitter.fire(message);
        break;
      case 'unknown':
        // A line we cannot classify is ignored; a newer Codex release must not
        // be able to take the connection down with an unfamiliar shape.
        break;
    }
  }

  private resolveResponse(message: JsonRpcResponse): void {
    const entry = this.pending.get(message.id);
    if (!entry) {
      return;
    }
    this.pending.delete(message.id);
    if ('error' in message) {
      entry.reject(new JsonRpcError(message.error));
    } else {
      entry.resolve(message.result);
    }
  }

  private onProcessError(cause: NodeJS.ErrnoException): void {
    const unavailable = cause.code === 'ENOENT';
    const error = new ConnectionError(
      unavailable ? 'unavailable' : 'protocol',
      unavailable
        ? `Codex CLI not found at "${this.options.executable}".`
        : `Cannot launch Codex CLI "${this.options.executable}".`,
      cause
    );
    this.rejectAll(error);
    this.closeEmitter.fire({ code: null, expected: this.disposed });
  }

  private onProcessClose(code: number | null): void {
    this.flushStdoutTail();
    const expected = this.disposed;
    const reason = this.stderrTail.trim().split(/\r?\n/).slice(-1)[0] ?? '';
    const error = new ConnectionError(
      'closed',
      expected
        ? 'The Codex app-server connection closed.'
        : `The Codex app-server exited unexpectedly${code === null ? '' : ` (code ${code})`}${
            reason ? `: ${reason}` : '.'
          }`
    );
    this.rejectAll(error);
    this.closeEmitter.fire({ code, expected });
  }

  private rejectAll(error: unknown): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  /** Send a request and resolve with its typed result. */
  private request<T>(
    method: string,
    params: unknown,
    options: { timeoutMs?: number; retryable?: boolean } = {}
  ): Promise<T> {
    const retryable = options.retryable ?? true;
    const send = async (): Promise<T> => {
      if (this.disposed) {
        throw new ConnectionError('closed', 'The Codex app-server connection was disposed.');
      }
      const child = this.child;
      if (!child || !child.stdin.writable) {
        throw new ConnectionError('closed', 'The Codex app-server is not accepting requests.');
      }
      const id = this.nextId;
      this.nextId += 1;
      const promise = new Promise<unknown>((resolve, reject) => {
        const entry: PendingRequest = {
          resolve: (value) => {
            clearTimeout(entry.timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(entry.timer);
            reject(error);
          }
        };
        if (options.timeoutMs !== undefined) {
          entry.timer = setTimeout(() => {
            if (this.pending.delete(id)) {
              entry.reject(new ConnectionError('protocol', `Codex app-server did not answer "${method}" in time.`));
            }
          }, options.timeoutMs);
          // Never let a pending request's timeout keep the host process alive.
          entry.timer.unref?.();
        }
        this.pending.set(id, entry);
      });
      child.stdin.write(encodeRequest(id, method, params));
      return (await promise) as T;
    };

    if (!retryable) {
      return send();
    }
    return retryWithBackoff(send, isServerOverloaded, this.backoff);
  }

  // Typed wrappers kept here so the adapter never repeats a method string.
  initialize(): Promise<InitializeResponse> {
    return this.start();
  }

  startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return this.request<ThreadStartResponse>('thread/start', params);
  }

  deleteThread(threadId: string): Promise<unknown> {
    return this.request<unknown>('thread/delete', { threadId });
  }

  resumeThread(params: ThreadResumeParams, timeoutMs?: number): Promise<ThreadResumeResponse> {
    return this.request<ThreadResumeResponse>(
      'thread/resume',
      params,
      timeoutMs === undefined ? {} : { timeoutMs, retryable: false }
    );
  }

  listThreads(params: ThreadListParams): Promise<ThreadListResponse> {
    return this.request<ThreadListResponse>('thread/list', params);
  }

  /** Older turns of a paginated thread. `sortDirection: "desc"` walks backwards. */
  listTurns(params: ThreadTurnsListParams): Promise<ThreadTurnsListResponse> {
    return this.request<ThreadTurnsListResponse>('thread/turns/list', params);
  }

  /** Older items of a paginated thread. `sortDirection: "desc"` walks backwards. */
  listItems(params: ThreadItemsListParams): Promise<ThreadItemsListResponse> {
    return this.request<ThreadItemsListResponse>('thread/items/list', params);
  }

  listModels(params: ModelListParams): Promise<ModelListResponse> {
    return this.request<ModelListResponse>('model/list', params);
  }

  startTurn(params: TurnStartParams): Promise<TurnStartResponse> {
    return this.request<TurnStartResponse>('turn/start', params);
  }

  steerTurn(params: TurnSteerParams): Promise<TurnSteerResponse> {
    return this.request<TurnSteerResponse>('turn/steer', params);
  }

  compactThread(params: ThreadCompactStartParams): Promise<ThreadCompactStartResponse> {
    return this.request<ThreadCompactStartResponse>('thread/compact/start', params);
  }

  interruptTurn(params: TurnInterruptParams): Promise<unknown> {
    // An interrupt on an already-finished turn must not fail the caller.
    return this.request<unknown>('turn/interrupt', params).catch((error) => {
      if (error instanceof JsonRpcError) {
        return undefined;
      }
      throw error;
    });
  }

  getAuthStatus(params: GetAuthStatusParams): Promise<GetAuthStatusResponse> {
    return this.request<GetAuthStatusResponse>('getAuthStatus', params);
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed || !this.child?.stdin.writable) {
      return;
    }
    this.child.stdin.write(encodeNotification(method, params));
  }

  /** Answer a server-initiated request. */
  respond(id: number, result: unknown): void {
    if (this.disposed || !this.child?.stdin.writable) {
      return;
    }
    this.child.stdin.write(encodeSuccess(id, result));
  }

  /** Answer a server-initiated request with a failure, so it never hangs. */
  respondError(id: number, code: number, message: string): void {
    if (this.disposed || !this.child?.stdin.writable) {
      return;
    }
    this.child.stdin.write(encodeError(id, { code, message }));
  }

  /**
   * Graceful shutdown: close stdin so the server exits on its own, then SIGTERM
   * after a grace period, then an unignorable kill after another. Safe to call
   * more than once: repeat callers await the same teardown promise rather than
   * returning before the process is gone.
   */
  dispose(): Promise<void> {
    if (this.disposing) {
      return this.disposing;
    }
    this.disposing = this.performDispose();
    return this.disposing;
  }

  private async performDispose(): Promise<void> {
    this.disposed = true;
    this.started = false;
    const child = this.child;
    this.rejectAll(new ConnectionError('closed', 'The Codex app-server connection was disposed.'));
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
      this.finishDispose();
      return;
    }

    const exited = waitForExit(child);
    try {
      child.stdin.end();
    } catch {
      // stdin may already be gone; fall through to signalling.
    }
    if (await raceWithTimeout(exited, STDIN_EXIT_GRACE_MS)) {
      this.finishDispose();
      return;
    }

    signalGracefully(child);
    if (await raceWithTimeout(exited, TERM_EXIT_GRACE_MS)) {
      this.finishDispose();
      return;
    }

    killProcessTree(child);
    this.finishDispose();
  }

  private finishDispose(): void {
    this.notificationEmitter.dispose();
    this.serverRequestEmitter.dispose();
    this.closeEmitter.dispose();
  }

  /** Best-effort synchronous teardown for a failed start. */
  private hardStop(): void {
    const child = this.child;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      killProcessTree(child);
    }
  }
}

/**
 * Whether a failed start should be retried with the next spawn form, and a
 * `hasAnotherForm` flag. Only an early close (`closed`, or the `protocol` code
 * used for an exited process) is a plausible argument rejection. A missing
 * binary (`unavailable`), a version mismatch (`incompatible`), and a disposed
 * connection are terminal: retrying them cannot help and would only risk a
 * second orphan.
 */
function shouldRetrySpawn(error: unknown, hasAnotherForm: boolean): boolean {
  if (!hasAnotherForm) {
    return false;
  }
  if (error instanceof ConnectionError) {
    return error.kind === 'closed' || error.kind === 'protocol';
  }
  return false;
}

/** Exposed so the retry rule is unit-testable without a child process. */
export { shouldRetrySpawn as shouldRetrySpawnWithNextForm };

/** True when a failure is the bounded-timeout rejection from the initialize request. */
function isHandshakeTimeout(error: ConnectionError): boolean {
  return /did not answer .* in time/.test(error.message);
}

/**
 * Ask the installed CLI for its own version, best-effort and bounded. Used to
 * make an unanswered handshake specific: the process started but disagreed with
 * our `initialize` shape, so the version is the diagnostic that distinguishes a
 * protocol drift from a missing binary. Any failure (missing binary, no output,
 * timeout) resolves to `undefined` so the caller degrades to a version-less
 * `incompatible` rather than throwing a second error.
 */
function queryCliVersion(executable: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      execFile(
        executable,
        ['--version'],
        { timeout: 2_000, windowsHide: true },
        (error, stdout) => {
          if (error) {
            finish(undefined);
            return;
          }
          const match = /(\d+\.\d+\.\d+)/.exec(String(stdout));
          finish(match ? match[1] : undefined);
        }
      );
    } catch {
      finish(undefined);
    }
  });
}

/**
 * Terminate a spawned app-server and anything it in turn spawned.
 *
 * On Windows a `cmd.exe`/`.cmd` shim can sit between the extension and the real
 * `codex.exe`; `child.kill()` would stop only the wrapper, leaving the server as
 * an orphan. `taskkill /T` walks the tree. On POSIX the child gets a SIGTERM,
 * escalating to SIGKILL.
 */
function killProcessTree(child: ChildProcessWithoutNullStreams): void {
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
    // The process may already have exited; nothing more to do.
  }
}

function signalGracefully(child: ChildProcessWithoutNullStreams): void {
  try {
    child.kill('SIGTERM');
  } catch {
    // Already gone.
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once('close', () => resolve()));
}

/** Resolve `true` when `promise` settles before the timeout, `false` otherwise. */
async function raceWithTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([promise.then(() => true as const), timedOut]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** Re-exported so the adapter can special-case the overload cap in its copy. */
export { RetryExhaustedError };
