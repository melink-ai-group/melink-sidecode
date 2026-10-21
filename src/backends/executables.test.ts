import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  executablePathError,
  hasPathSeparator,
  isAbsoluteExecutable,
  isDriveRelativeExecutable,
  resolveExecutableCommand,
  resolveProbedExecutable,
  resolveTrustedExecutable
} from './executables.ts';
import { resolveOpencodeExecutable } from './opencode/resolve.ts';
import { resolveAstGrepExecutable } from './astGrep/resolve.ts';
import { resolveZvecGrepExecutable } from './zvecGrep/resolve.ts';
import { AppServerConnection } from './appserver/connection.ts';

/**
 * Which binary a turn runs.
 *
 * The child process starts with the workspace as the working directory, so a
 * value that names a file inside the repository would run that file. These
 * tests pin the rules that prevent it: the value comes from the user's own
 * setting only, a relative path with a separator is refused, and a Windows
 * drive-relative path is refused too.
 */

test('a bare command name is left for PATH resolution', () => {
  assert.equal(isAbsoluteExecutable('codex'), false);
  assert.equal(hasPathSeparator('codex'), false);
  const resolved = resolveExecutableCommand('codex', 'codex');
  assert.deepEqual(resolved, { ok: true, command: 'codex' });
});

test('an absolute path is used as-is', () => {
  assert.equal(isAbsoluteExecutable('/usr/local/bin/codex'), true);
  assert.equal(isAbsoluteExecutable('C:\\Tools\\codex.exe'), true);
  assert.equal(isAbsoluteExecutable('\\\\server\\share\\codex.exe'), true);
  const resolved = resolveExecutableCommand('C:\\Tools\\codex.exe', 'codex');
  assert.deepEqual(resolved, { ok: true, command: 'C:\\Tools\\codex.exe' });
});

test('a relative path with a separator is refused', () => {
  for (const value of ['./evil', '..\\evil', 'bin/codex', 'sub\\codex.exe', '.\\evil']) {
    const resolved = resolveExecutableCommand(value, 'codex');
    assert.equal(resolved.ok, false, value);
    assert.equal(resolved.ok === false && resolved.reason, 'relative-with-separator');
  }
});

test('an empty value falls back to the bare command name', () => {
  assert.deepEqual(resolveExecutableCommand('   ', 'codex'), { ok: true, command: 'codex' });
});

/**
 * The Windows drive-relative form.
 *
 * `C:evil.exe` carries no separator, so the "relative path with a separator"
 * rule does not catch it — but Windows resolves it against the current
 * directory *of that drive*, which for a child spawned with the workspace as
 * its working directory is the workspace. The value would run
 * `workspace\evil.exe`.
 */
test('a Windows drive-relative path is refused', () => {
  for (const value of ['C:evil.exe', 'c:evil.exe', 'C:', 'c:', 'C:..\\evil', 'C:sub\\evil.exe', 'Z:evil']) {
    assert.equal(isDriveRelativeExecutable(value), true, value);
    assert.equal(isAbsoluteExecutable(value), false, value);
    const resolved = resolveExecutableCommand(value, 'codex');
    assert.equal(resolved.ok, false, value);
    assert.equal(resolved.ok === false && resolved.reason, 'drive-relative', value);
  }
});

test('a true absolute path is not drive-relative', () => {
  for (const value of [
    'C:\\Tools\\codex.exe',
    'C:/Tools/codex.exe',
    'c:\\tools',
    '\\\\server\\share\\codex.exe',
    '/usr/local/bin/codex'
  ]) {
    assert.equal(isDriveRelativeExecutable(value), false, value);
    assert.equal(isAbsoluteExecutable(value), true, value);
    assert.deepEqual(resolveExecutableCommand(value, 'codex'), { ok: true, command: value }, value);
  }
});

test('the drive-relative refusal message names the reason in plain language', () => {
  const message = executablePathError('drive-relative', 'Codex CLI');
  assert.match(message, /absolute path or a command name/);
  assert.match(message, /not saved/);
  assert.match(message, /drive-relative/);
});

test('a drive-relative user path is refused and falls back to the bare command', () => {
  const inspected = { defaultValue: 'codex', globalValue: 'C:evil.exe' };
  assert.equal(resolveTrustedExecutable(inspected, 'codex'), 'codex');
});

/**
 * The probe seam.
 *
 * The settings screen probes the configured path to show a status line. The
 * probe must apply the same rules as the spawn itself, so a value the turn
 * would refuse is never run by the probe either.
 */
test('the probed command refuses a drive-relative value', () => {
  for (const value of ['C:evil.exe', 'C:', 'C:..\\evil']) {
    assert.equal(resolveProbedExecutable(value, 'opencode'), 'opencode', value);
  }
});

test('the probed command refuses a relative path with a separator', () => {
  for (const value of ['./evil', '..\\evil', 'sub/opencode']) {
    assert.equal(resolveProbedExecutable(value, 'opencode'), 'opencode', value);
  }
});

test('the probed command keeps an absolute path and a bare name', () => {
  assert.equal(resolveProbedExecutable('C:\\tools\\opencode.exe', 'opencode'), 'C:\\tools\\opencode.exe');
  assert.equal(resolveProbedExecutable('/usr/local/bin/opencode', 'opencode'), '/usr/local/bin/opencode');
  assert.equal(resolveProbedExecutable('opencode', 'opencode'), 'opencode');
  assert.equal(resolveProbedExecutable('   ', 'opencode'), 'opencode');
});

test('the refusal message names the reason in plain language', () => {
  const message = executablePathError('relative-with-separator', 'Codex CLI');
  assert.match(message, /absolute path or a command name/);
  assert.match(message, /not saved/);
  assert.match(executablePathError('empty', 'Codex CLI'), /not saved/);
});

test('a workspace path setting is never the spawned command', () => {
  const inspected = {
    defaultValue: 'codex',
    globalValue: 'codex',
    workspaceValue: './evil'
  };
  assert.equal(resolveTrustedExecutable(inspected, 'codex'), 'codex');
});

test('a workspace path setting is ignored even without a global value', () => {
  const inspected = {
    defaultValue: 'codex',
    workspaceValue: './evil',
    workspaceFolderValue: '..\\evil'
  };
  assert.equal(resolveTrustedExecutable(inspected, 'codex'), 'codex');
});

test('the user own absolute path is used', () => {
  const inspected = {
    defaultValue: 'codex',
    globalValue: '/usr/local/bin/codex',
    workspaceValue: './evil'
  };
  assert.equal(resolveTrustedExecutable(inspected, 'codex'), '/usr/local/bin/codex');
});

test('a user relative path with a separator is refused and falls back', () => {
  const inspected = { defaultValue: 'codex', globalValue: './evil' };
  assert.equal(resolveTrustedExecutable(inspected, 'codex'), 'codex');
});

test('the opencode resolver refuses a relative path with a separator', () => {
  const roots = { extensionPath: 'C:\\ext', globalStoragePath: 'C:\\storage' };
  assert.equal(
    resolveOpencodeExecutable({ source: 'local', path: './evil', roots }),
    'opencode'
  );
  assert.equal(
    resolveOpencodeExecutable({ source: 'local', path: '/usr/local/bin/opencode', roots }),
    '/usr/local/bin/opencode'
  );
  assert.equal(
    resolveOpencodeExecutable({ source: 'local', path: 'opencode', roots }),
    'opencode'
  );
});

test('the skill resolvers refuse a relative path with a separator', () => {
  const roots = { extensionPath: 'C:\\ext', globalStoragePath: 'C:\\storage' };
  assert.equal(
    resolveAstGrepExecutable({ source: 'local', path: './evil', roots }),
    'ast-grep'
  );
  assert.equal(
    resolveAstGrepExecutable({ source: 'local', path: '/usr/local/bin/ast-grep', roots }),
    '/usr/local/bin/ast-grep'
  );
  assert.equal(
    resolveZvecGrepExecutable({ source: 'local', path: '../evil', roots, platform: 'linux' }),
    'zg'
  );
  assert.equal(
    resolveZvecGrepExecutable({ source: 'local', path: '/usr/local/bin/zg', roots, platform: 'linux' }),
    '/usr/local/bin/zg'
  );
});

/**
 * All five resolvers must refuse the drive-relative form, not just the shared
 * helper: a resolver that reaches for its own path test would otherwise let
 * `C:evil.exe` through.
 */
test('every resolver refuses a Windows drive-relative path', () => {
  const roots = { extensionPath: 'C:\\ext', globalStoragePath: 'C:\\storage' };
  for (const value of ['C:evil.exe', 'C:', 'C:..\\evil']) {
    assert.equal(
      resolveTrustedExecutable({ defaultValue: 'codex', globalValue: value }, 'codex'),
      'codex',
      `codex: ${value}`
    );
    assert.equal(
      resolveOpencodeExecutable({ source: 'local', path: value, roots }),
      'opencode',
      `opencode: ${value}`
    );
    assert.equal(
      resolveZvecGrepExecutable({ source: 'local', path: value, roots, platform: 'win32' }),
      'zg.cmd',
      `zvecGrep: ${value}`
    );
    assert.equal(
      resolveAstGrepExecutable({ source: 'local', path: value, roots }),
      'ast-grep',
      `astGrep: ${value}`
    );
  }
});

/**
 * The fake spawn seam: the app-server connection records the command it was
 * asked to launch, so a test can assert the binary rather than trust a
 * resolver's return value.
 */
function fakeChild(): ChildProcessWithoutNullStreams {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(emitter, {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin,
    stdout,
    stderr,
    kill: () => true
  });
  stdin.on('data', (chunk: Buffer) => {
    const parsed = JSON.parse(chunk.toString());
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
  return emitter as unknown as ChildProcessWithoutNullStreams;
}

test('the spawned command is the user one, never the workspace one', async () => {
  const commands: string[] = [];
  const connection = new AppServerConnection({
    // The resolved command: the user's own setting, with the workspace
    // override already excluded by the reader.
    executable: resolveTrustedExecutable(
      { defaultValue: 'codex', globalValue: 'codex', workspaceValue: './evil' },
      'codex'
    ),
    cwd: process.cwd(),
    startTimeoutMs: 2_000,
    spawnImpl: ((exe: string) => {
      commands.push(exe);
      return fakeChild();
    }) as unknown as typeof import('node:child_process').spawn
  });
  await connection.start();
  assert.deepEqual(commands, ['codex']);
  assert.equal(commands.some((command) => command.includes('evil')), false);
  await connection.dispose();
});

/**
 * Why the drive-relative form is load-bearing.
 *
 * Windows resolves `C:evil.exe` against the current directory *of that
 * drive*, so with the workspace as the working directory it names
 * `workspace\evil.exe`. `path.win32.resolve` is the same rule Node applies,
 * which is what makes the guard below meaningful rather than theoretical.
 */
test('a drive-relative value names a file in the workspace on Windows', () => {
  // The drive-relative form resolves against the current directory *of that
  // drive*, which is the workspace when the child is spawned with it as the
  // working directory.
  assert.equal(win32.resolve('C:\\workspace', 'C:evil.exe'), 'C:\\workspace\\evil.exe');
  assert.equal(win32.resolve('C:\\workspace', 'C:sub\\evil.exe'), 'C:\\workspace\\sub\\evil.exe');
  // `..` cancels the drive-relative current directory rather than escaping
  // it, so it still names a file on the drive's root.
  assert.equal(win32.resolve('C:\\workspace', 'C:..\\evil.exe'), 'C:\\evil.exe');
  // A true absolute path is unaffected.
  assert.equal(win32.resolve('C:\\workspace', 'C:\\tools\\evil.exe'), 'C:\\tools\\evil.exe');
});

/**
 * The fake-spawn proof: a drive-relative value in the user's own settings
 * must never reach the spawn seam, so no file inside the workspace can be
 * executed.
 */
test('a drive-relative value never reaches the spawn seam', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'sidecode-workspace-'));
  const marker = join(workspace, 'evil.exe');
  // The file a drive-relative value would name inside the workspace. It is
  // never executable here; it only proves the workspace really holds the
  // file the bypass would have run.
  writeFileSync(marker, 'not a binary');
  try {
    chmodSync(marker, 0o755);
  } catch {
    // Permission bits are advisory on Windows.
  }

  const commands: string[] = [];
  const connection = new AppServerConnection({
    executable: resolveTrustedExecutable(
      { defaultValue: 'codex', globalValue: 'C:evil.exe' },
      'codex'
    ),
    cwd: workspace,
    startTimeoutMs: 2_000,
    spawnImpl: ((exe: string) => {
      commands.push(exe);
      return fakeChild();
    }) as unknown as typeof import('node:child_process').spawn
  });
  await connection.start();
  await connection.dispose();

  assert.deepEqual(commands, ['codex']);
  assert.equal(
    commands.some((command) => command === 'C:evil.exe' || command.includes('evil')),
    false
  );
});
