import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  looksLikePath,
  opencodePathError,
  parseOpencodeVersion,
  probeOpencode,
  upgradeOpencode
} from './status.ts';

test('the version parser reads a semantic version from a --version line', () => {
  assert.equal(parseOpencodeVersion('1.1.65'), '1.1.65');
  assert.equal(parseOpencodeVersion('opencode 1.1.65'), '1.1.65');
  assert.equal(parseOpencodeVersion('v0.4.2\n'), '0.4.2');
  assert.equal(parseOpencodeVersion('opencode-cli 2.0.0-beta.3'), '2.0.0-beta.3');
});

test('the version parser returns undefined when no version is present', () => {
  assert.equal(parseOpencodeVersion(''), undefined);
  assert.equal(parseOpencodeVersion('usage: opencode run'), undefined);
});

test('a bare command name is left to PATH, never refused as a bad path', () => {
  assert.equal(looksLikePath('opencode'), false);
  assert.equal(opencodePathError('opencode', () => false), undefined);
});

test('a present path-shaped value is accepted', () => {
  assert.equal(opencodePathError('/usr/local/bin/opencode', () => true), undefined);
});

test('a missing path-shaped value is refused and says the stored path stays', () => {
  const message = opencodePathError('/opt/tools/opencod', () => false);
  assert.ok(message);
  assert.match(message as string, /not saved/);
});

test('an empty path is refused', () => {
  assert.match(opencodePathError('   ', () => true) ?? '', /not saved/);
});

test('a relative path with a separator is refused even when the file exists', () => {
  // The child runs with the workspace as its working directory, so a relative
  // path would name a file inside the repository.
  const message = opencodePathError('./evil', () => true);
  assert.ok(message);
  assert.match(message as string, /absolute path or a command name/);
  assert.match(message as string, /not saved/);
  assert.match(opencodePathError('..\\evil', () => true) ?? '', /not saved/);
});

test('a drive-relative path is refused even when the file exists', () => {
  // `C:evil.exe` has no separator, so only the drive-relative rule catches
  // it: Windows resolves it against the current directory of that drive.
  const message = opencodePathError('C:evil.exe', () => true);
  assert.ok(message);
  assert.match(message as string, /absolute path or a command name/);
  assert.match(message as string, /not saved/);
  assert.match(opencodePathError('C:', () => true) ?? '', /not saved/);
});

/**
 * The fake spawn seam: the probe records the command it was asked to launch,
 * so a test can assert the binary rather than trust a resolver's return
 * value.
 */
function fakeProbeChild(): ChildProcess {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(emitter, {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(),
    stdout,
    stderr,
    kill: () => true
  });
  setTimeout(() => {
    stdout.write('1.2.3\n');
    emitter.emit('close', 0);
  }, 5);
  return emitter as unknown as ChildProcess;
}

test('the probe spawns the bare command for a drive-relative value', async () => {
  const commands: string[] = [];
  const result = await probeOpencode('C:evil.exe', {
    timeoutMs: 2_000,
    spawnImpl: ((exe: string) => {
      commands.push(exe);
      return fakeProbeChild();
    }) as unknown as typeof import('node:child_process').spawn
  });
  assert.deepEqual(commands, ['opencode']);
  assert.equal(commands.some((command) => command.includes('evil')), false);
  assert.equal(result.status, 'detected');
});

test('the probe spawns the bare command for a relative path with a separator', async () => {
  const commands: string[] = [];
  await probeOpencode('./evil', {
    timeoutMs: 2_000,
    spawnImpl: ((exe: string) => {
      commands.push(exe);
      return fakeProbeChild();
    }) as unknown as typeof import('node:child_process').spawn
  });
  assert.deepEqual(commands, ['opencode']);
});

test('the probe spawns an absolute path as-is', async () => {
  const commands: string[] = [];
  await probeOpencode('C:\\tools\\opencode.exe', {
    timeoutMs: 2_000,
    spawnImpl: ((exe: string) => {
      commands.push(exe);
      return fakeProbeChild();
    }) as unknown as typeof import('node:child_process').spawn
  });
  assert.deepEqual(commands, ['C:\\tools\\opencode.exe']);
});

/**
 * The upgrade path.
 *
 * `opencode upgrade` spawns a binary too, so it applies the same rules: a
 * relative path with a separator — or a Windows drive-relative path — would
 * run a file from the workspace, so the bare command name is used instead.
 */
function fakeUpgradeChild(): ChildProcess {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(emitter, {
    pid: 4243,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(),
    stdout,
    stderr,
    kill: () => true
  });
  setTimeout(() => {
    stdout.write('Updated to 1.19.0.\n');
    emitter.emit('close', 0);
  }, 5);
  return emitter as unknown as ChildProcess;
}

test('the upgrade spawns the bare command for a drive-relative value', async () => {
  const commands: string[] = [];
  await upgradeOpencode('C:evil.exe', {
    timeoutMs: 2_000,
    spawnImpl: ((exe: string) => {
      commands.push(exe);
      return fakeUpgradeChild();
    }) as unknown as typeof import('node:child_process').spawn
  });
  assert.deepEqual(commands, ['opencode']);
  assert.equal(commands.some((command) => command.includes('evil')), false);
});

test('the upgrade spawns the bare command for a relative path with a separator', async () => {
  const commands: string[] = [];
  await upgradeOpencode('./evil', {
    timeoutMs: 2_000,
    spawnImpl: ((exe: string) => {
      commands.push(exe);
      return fakeUpgradeChild();
    }) as unknown as typeof import('node:child_process').spawn
  });
  assert.deepEqual(commands, ['opencode']);
});

test('the upgrade spawns an absolute path as-is', async () => {
  const commands: string[] = [];
  await upgradeOpencode('C:\\tools\\opencode.exe', {
    timeoutMs: 2_000,
    spawnImpl: ((exe: string) => {
      commands.push(exe);
      return fakeUpgradeChild();
    }) as unknown as typeof import('node:child_process').spawn
  });
  assert.deepEqual(commands, ['C:\\tools\\opencode.exe']);
});
