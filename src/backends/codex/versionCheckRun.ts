import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { AppServerConnection, ConnectionError } from '../appserver/connection.ts';
import { JsonRpcError } from '../appserver/jsonrpc.ts';
import { scrubbedCodexEnv } from './env.ts';
import {
  assessGeneratedProtocol,
  assessProtocolProbe,
  versionCheckResult,
  type CodexVersionCheckResult,
  type GeneratedProtocol,
  type ProtocolProbe
} from './versionCheck.ts';

export type { CodexVersionCheckResult } from './versionCheck.ts';

const PROBE_TIMEOUT_MS = 20_000;
const GENERATE_TIMEOUT_MS = 30_000;

/**
 * Run the checks that decide whether an out-of-range Codex CLI may be used:
 * a live `initialize`, `model/list`, `thread/list`, and `getAuthStatus`, then
 * a generated-protocol check that the methods this app calls are still there.
 * The probe connection accepts an out-of-range version so the check can run;
 * nothing is persisted here.
 */
export async function validateInstalledCodex(options: {
  executable: string;
  cwd: string;
}): Promise<CodexVersionCheckResult> {
  const probe = await probeInstalledCodex(options);
  if (!probe.ok) {
    return { ok: false, ...(probe.version ? { version: probe.version } : {}), message: probe.message };
  }
  const protocol = await readInstalledProtocol(options.executable);
  return versionCheckResult(probe, protocol);
}

async function probeInstalledCodex(options: { executable: string; cwd: string }): Promise<ReturnType<typeof assessProtocolProbe>> {
  const connection = new AppServerConnection({
    executable: options.executable,
    cwd: options.cwd,
    startTimeoutMs: PROBE_TIMEOUT_MS,
    acceptOutOfRangeVersion: true
  });
  const observed: {
    userAgent?: string;
    modelList?: unknown;
    threadList?: unknown;
    authStatus?: unknown;
    failures: string[];
  } = { failures: [] };
  try {
    try {
      const initialized = await connection.start();
      observed.userAgent = initialized.userAgent;
    } catch (error) {
      observed.failures.push(probeFailure(error, 'the handshake', options.executable));
      return assessProtocolProbe(observed);
    }
    try {
      observed.modelList = await connection.listModels({ limit: 1 });
    } catch (error) {
      observed.failures.push(probeFailure(error, 'model/list', options.executable));
      return assessProtocolProbe(observed);
    }
    try {
      observed.threadList = await connection.listThreads({ limit: 1 });
    } catch (error) {
      observed.failures.push(probeFailure(error, 'thread/list', options.executable));
      return assessProtocolProbe(observed);
    }
    try {
      observed.authStatus = await connection.getAuthStatus({ includeToken: false, refreshToken: false });
    } catch (error) {
      observed.failures.push(probeFailure(error, 'getAuthStatus', options.executable));
    }
    return assessProtocolProbe(observed satisfies ProtocolProbe);
  } finally {
    await connection.dispose();
  }
}

function probeFailure(error: unknown, step: string, executable: string): string {
  if (error instanceof ConnectionError && error.kind === 'unavailable') {
    return `Could not start the Codex CLI at "${executable}". Check the CLI path, then validate again.`;
  }
  if (error instanceof JsonRpcError) {
    return `The Codex CLI refused ${step}, so this version is still unsupported.`;
  }
  return `The Codex CLI did not complete ${step}, so this version is still unsupported.`;
}

async function readInstalledProtocol(executable: string): Promise<ReturnType<typeof assessGeneratedProtocol>> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'sidecode-codex-'));
    await runGenerate(executable, dir);
    const protocol: GeneratedProtocol = {
      clientRequest: await readFile(join(dir, 'ClientRequest.ts'), 'utf8'),
      threadStartParams: await readFile(join(dir, 'v2', 'ThreadStartParams.ts'), 'utf8')
    };
    return assessGeneratedProtocol(protocol);
  } catch {
    return {
      ok: false,
      message: 'The Codex CLI could not describe its protocol, so this version is still unsupported.'
    };
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function runGenerate(executable: string, outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server', 'generate-ts', '--out', outDir], {
      windowsHide: true,
      shell: false,
      env: scrubbedCodexEnv(process.env),
      stdio: ['ignore', 'ignore', 'ignore']
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('timeout'));
    }, GENERATE_TIMEOUT_MS);
    timer.unref?.();
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error('exit'));
      }
    });
  });
}
