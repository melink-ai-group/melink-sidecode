import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FailureLogSink } from './failureLog.ts';

/**
 * Host wiring for the opt-in local missed-issue log, without importing
 * `vscode`: the extension passes the real setting, storage root, clock, and
 * file operations; tests pass fakes. Keeping the seam here means the storage
 * path and the off behaviour are testable on their own.
 */
export interface FailureLogHostEnv {
  /** Reads `melink.telemetry.failureLog`; false keeps every file untouched. */
  enabled: () => boolean;
  /** `context.globalStorageUri.fsPath`, never a workspace folder. */
  globalStoragePath: string;
  /** ISO timestamp source, so tests can make entries deterministic. */
  now: () => string;
}

/** The only filesystem operations the log needs. */
export interface FailureLogFileOps {
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
  appendFile: (path: string, data: string, encoding: 'utf8') => Promise<void>;
}

/**
 * Direct `node:fs` is intentional here. This is not workspace content: the
 * file is extension-owned, appends-only, and lives under global storage, so it
 * needs neither `vscode.workspace.fs` nor the virtual-workspace routing that
 * workspace files use. The operations stay injectable, so tests remain
 * host-free and no `vscode` import enters this module.
 */
const DEFAULT_FILE_OPS: FailureLogFileOps = {
  mkdir: (path, options) => mkdir(path, options),
  appendFile: (path, data, encoding) => appendFile(path, data, encoding)
};

/** The one file the extension owns under its global storage. */
export const FAILURE_LOG_FILENAME = 'failure-log.jsonl';

/** Absolute path of the local log for a global-storage root. */
export function failureLogFilePath(globalStoragePath: string): string {
  return join(globalStoragePath, FAILURE_LOG_FILENAME);
}

/**
 * Build the sink the core logger uses. The directory and file are created
 * lazily by the first append; while the setting is off no append happens, so
 * neither is created. Nothing here reads the file back or rewrites it.
 */
export function createFailureLogHost(
  env: FailureLogHostEnv,
  fileOps: FailureLogFileOps = DEFAULT_FILE_OPS
): { sink: FailureLogSink; path: string } {
  const path = failureLogFilePath(env.globalStoragePath);
  let directoryReady: Promise<void> | undefined;

  const ensureDirectory = (): Promise<void> => {
    if (!directoryReady) {
      directoryReady = fileOps.mkdir(dirname(path), { recursive: true }).then(
        () => undefined,
        (error: unknown) => {
          // A failed first write may be retried by a later command.
          directoryReady = undefined;
          throw error;
        }
      );
    }
    return directoryReady;
  };

  const sink: FailureLogSink = {
    enabled: env.enabled,
    now: env.now,
    append: async (line) => {
      await ensureDirectory();
      await fileOps.appendFile(path, line, 'utf8');
    }
  };

  return { sink, path };
}
