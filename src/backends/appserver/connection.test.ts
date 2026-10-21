import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  APP_SERVER_SPAWN_FORMS,
  AppServerConnection,
  ConnectionError,
  ServerVersionMismatchError,
  shouldRetrySpawnWithNextForm
} from './connection.ts';

/**
 * A fake `codex` child. The first spawn form exits non-zero without answering
 * (as a rejected flag would); the second answers the handshake. The test asserts
 * the adapter retried and that the successful form is recorded.
 */
function fakeChild(behavior: 'reject' | 'answer'): {
  child: ChildProcessWithoutNullStreams;
  written: string[];
} {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const written: string[] = [];
  stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()));

  Object.assign(emitter, {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin,
    stdout,
    stderr,
    kill: () => {
      (emitter as unknown as { exitCode: number | null }).exitCode = 0;
      emitter.emit('close', 0);
      return true;
    }
  });

  const child = emitter as unknown as ChildProcessWithoutNullStreams;

  if (behavior === 'reject') {
    // A rejected argument exits before the handshake can be answered.
    setTimeout(() => {
      (emitter as unknown as { exitCode: number | null }).exitCode = 1;
      stdout.write('error: unexpected argument --listen found\n');
      emitter.emit('close', 1);
    }, 5);
  } else {
    stdin.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      const parsed = JSON.parse(text);
      if (parsed.method === 'initialize') {
        setTimeout(() => {
          stdout.write(
            `${JSON.stringify({
              id: parsed.id,
              result: {
                userAgent: 'melink-agent-sidebar/0.156.1 (Windows; x86_64) (melink-agent-sidebar; 0.1.0)',
                codexHome: 'C:\\Users\\x\\.codex',
                platformFamily: 'windows',
                platformOs: 'windows'
              }
            })}\n`
          );
        }, 5);
      }
    });
  }
  return { child, written };
}

test('a rejected --listen form is retried with the bare command and succeeds', async () => {
  const calls: string[][] = [];
  let attempt = 0;
  const logs: string[] = [];
  const connection = new AppServerConnection({
    executable: 'codex',
    cwd: process.cwd(),
    startTimeoutMs: 2_000,
    log: (message) => logs.push(message),
    spawnImpl: ((_exe: string, args: string[]) => {
      calls.push(args);
      const behavior = attempt === 0 ? 'reject' : 'answer';
      attempt += 1;
      return fakeChild(behavior).child;
    }) as unknown as typeof import('node:child_process').spawn
  });

  const result = await connection.start();
  assert.equal(result.platformOs, 'windows');
  assert.equal(calls.length, 2);
  // Every invocation requests the ChatGPT auth preference ahead of the form, so
  // the auth method is explicit rather than inherited from the user's config.
  const authPreference = ['-c', 'forced_login_method="chatgpt"'];
  assert.deepEqual(calls[0], [...authPreference, 'app-server', '--listen', 'stdio://']);
  assert.deepEqual(calls[1], [...authPreference, 'app-server']);
  assert.equal(connection.startedWith, APP_SERVER_SPAWN_FORMS[1].label);
  assert.match(logs.join('\n'), /app-server\n?$/m);
  await connection.dispose();
});

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

test('the spawned child env has inherited credentials scrubbed and keeps auth.json discoverable', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalHome = process.env.CODEX_HOME;
  process.env.OPENAI_API_KEY = 'sk-svcacct-fake';
  process.env.CODEX_HOME = 'C:\\Users\\x\\.codex';
  try {
    let childEnv: NodeJS.ProcessEnv | undefined;
    const connection = new AppServerConnection({
      executable: 'codex',
      cwd: process.cwd(),
      startTimeoutMs: 2_000,
      spawnImpl: ((_exe: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        childEnv = options.env;
        return fakeChild('answer').child;
      }) as unknown as typeof import('node:child_process').spawn
    });
    await connection.start();
    assert.equal(childEnv?.OPENAI_API_KEY, undefined);
    assert.equal(childEnv?.CODEX_HOME, 'C:\\Users\\x\\.codex');
    // Windows exposes the inherited variable as `Path`, not `PATH`; compare
    // case-insensitively so the assertion holds on every platform.
    assert.equal(envValue(childEnv ?? {}, 'PATH'), envValue(process.env, 'PATH'));
    assert.notEqual(envValue(childEnv ?? {}, 'PATH'), undefined);
    await connection.dispose();
  } finally {
    if (originalKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalKey;
    }
    if (originalHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalHome;
    }
  }
});

test('a missing binary is not retried (no second spawn)', async () => {
  let calls = 0;
  const connection = new AppServerConnection({
    executable: 'codex',
    cwd: process.cwd(),
    startTimeoutMs: 2_000,
    spawnImpl: (() => {
      calls += 1;
      const emitter = new EventEmitter();
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(emitter, { pid: 1, exitCode: null, signalCode: null, stdin, stdout, stderr, kill: () => true });
      setTimeout(() => {
        const error = new Error('spawn codex ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        emitter.emit('error', error);
      }, 5);
      return emitter as unknown as ChildProcessWithoutNullStreams;
    }) as unknown as typeof import('node:child_process').spawn
  });

  await assert.rejects(connection.start(), (error: unknown) => {
    assert.ok(error instanceof ConnectionError);
    assert.equal(error.kind, 'unavailable');
    return true;
  });
  assert.equal(calls, 1);
});

test('an out-of-range server version reports incompatible with the version', async () => {
  const connection = new AppServerConnection({
    executable: 'codex',
    cwd: process.cwd(),
    startTimeoutMs: 2_000,
    spawnImpl: (() => {
      const emitter = new EventEmitter();
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(emitter, { pid: 1, exitCode: null, signalCode: null, stdin, stdout, stderr, kill: () => true });
      stdin.on('data', (chunk: Buffer) => {
        const parsed = JSON.parse(chunk.toString());
        if (parsed.method === 'initialize') {
          setTimeout(() => {
            stdout.write(
              `${JSON.stringify({
                id: parsed.id,
                result: {
                  // A server far newer than the pin.
                  userAgent: 'melink-agent-sidebar/9.9.9 (Windows; x86_64) (melink-agent-sidebar; 0.1.0)',
                  codexHome: '/home/x/.codex',
                  platformFamily: 'unix',
                  platformOs: 'linux'
                }
              })}\n`
            );
          }, 5);
        }
      });
      return emitter as unknown as ChildProcessWithoutNullStreams;
    }) as unknown as typeof import('node:child_process').spawn
  });

  await assert.rejects(connection.start(), (error: unknown) => {
    assert.ok(error instanceof ServerVersionMismatchError);
    assert.equal(error.kind, 'incompatible');
    assert.equal(error.reportedVersion, '9.9.9');
    assert.match(error.message, /Validate version/);
    return true;
  });
});

function versionedConnection(
  allowedVersions?: readonly string[],
  acceptOutOfRangeVersion = false
): AppServerConnection {
  return new AppServerConnection({
    executable: 'codex',
    cwd: process.cwd(),
    startTimeoutMs: 2_000,
    ...(allowedVersions ? { allowedVersions } : {}),
    ...(acceptOutOfRangeVersion ? { acceptOutOfRangeVersion: true } : {}),
    spawnImpl: (() => {
      const emitter = new EventEmitter();
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(emitter, {
        pid: 1,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        stdin,
        stdout,
        stderr,
        kill: () => {
          (emitter as unknown as { exitCode: number | null }).exitCode = 0;
          emitter.emit('close', 0);
          return true;
        }
      });
      stdin.on('data', (chunk: Buffer) => {
        const parsed = JSON.parse(chunk.toString());
        if (parsed.method === 'initialize') {
          setTimeout(() => {
            stdout.write(
              `${JSON.stringify({
                id: parsed.id,
                result: {
                  userAgent: 'melink-agent-sidebar/9.9.9 (Windows; x86_64) (melink-agent-sidebar; 0.1.0)',
                  codexHome: '/home/x/.codex',
                  platformFamily: 'unix',
                  platformOs: 'linux'
                }
              })}\n`
            );
          }, 5);
        }
      });
      stdin.on('end', () => {
        (emitter as unknown as { exitCode: number | null }).exitCode = 0;
        emitter.emit('close', 0);
      });
      return emitter as unknown as ChildProcessWithoutNullStreams;
    }) as unknown as typeof import('node:child_process').spawn
  });
}

test('a previously validated version is allowed through the handshake', async () => {
  const connection = versionedConnection(['9.9.9']);
  const result = await connection.start();
  assert.match(result.userAgent, /9\.9\.9/);
  await connection.dispose();
});

test('the version probe can handshake an out-of-range server without allowing it', async () => {
  const connection = versionedConnection(undefined, true);
  const result = await connection.start();
  assert.match(result.userAgent, /9\.9\.9/);
  await connection.dispose();
});

test('only an early close is worth retrying with the next form', () => {
  assert.equal(shouldRetrySpawnWithNextForm(new ConnectionError('closed', 'exited'), true), true);
  assert.equal(shouldRetrySpawnWithNextForm(new ConnectionError('protocol', 'exited'), true), true);
  assert.equal(shouldRetrySpawnWithNextForm(new ConnectionError('unavailable', 'missing'), true), false);
  assert.equal(shouldRetrySpawnWithNextForm(new ServerVersionMismatchError('9.9.9'), true), false);
  // No next form to try.
  assert.equal(shouldRetrySpawnWithNextForm(new ConnectionError('closed', 'exited'), false), false);
});
