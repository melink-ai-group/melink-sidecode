import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  applyZvecGrep,
  detectZvecGrep,
  firstExisting,
  nodeMajor,
  npmGlobalInstallArgs,
  opencodeConfigCandidates,
  opencodeConfigHasZvecGrep,
  zgIntegrationArgs,
  type CommandRunner,
  type SpawnOutcome,
  type ZvecGrepIO
} from './zvecGrep.ts';

const CONFIGURED = `{
  // "zvec_grep": { "command": "ignored" }
  "mcp": {
    "other": { "command": "echo" },
    "zvec_grep": { "type": "local", "command": ["zg", "--server", "--stdio"] },
  }
}`;

test('node major is read from a version line', () => {
  assert.equal(nodeMajor('v22.14.0'), 22);
  assert.equal(nodeMajor('v21.0.0\n'), 21);
  assert.equal(nodeMajor('not a version'), undefined);
});

test('integration args use the current installer form and never force', () => {
  assert.deepEqual(zgIntegrationArgs('install'), ['--install', '--target', 'opencode', '--yes']);
  assert.deepEqual(zgIntegrationArgs('uninstall'), ['--uninstall', '--target', 'opencode', '--yes']);
  assert.deepEqual(npmGlobalInstallArgs(), ['install', '-g', '@zvec/zvec-grep']);
  assert.equal(zgIntegrationArgs('install').includes('--force'), false);
});

test('config candidates follow zg path rules', () => {
  assert.deepEqual(
    opencodeConfigCandidates({
      homedir: '/home/me',
      platform: 'linux',
      opencodeConfig: '/tmp/opencode.json'
    }),
    ['/tmp/opencode.json']
  );
  assert.deepEqual(
    opencodeConfigCandidates({
      homedir: '/home/me',
      platform: 'linux',
      xdgConfigHome: '/xdg'
    }),
    [join('/xdg', 'opencode', 'opencode.jsonc'), join('/xdg', 'opencode', 'opencode.json')]
  );
  assert.deepEqual(
    opencodeConfigCandidates({
      homedir: 'C:\\Users\\me',
      platform: 'win32',
      xdgConfigHome: '/xdg'
    }),
    [
      join('C:\\Users\\me', '.config', 'opencode', 'opencode.jsonc'),
      join('C:\\Users\\me', '.config', 'opencode', 'opencode.json')
    ]
  );
  assert.equal(
    firstExisting(['a.jsonc', 'a.json'], (path) => path === 'a.json'),
    'a.json'
  );
  assert.equal(firstExisting(['a.jsonc', 'a.json'], () => false), undefined);
});

test('a commented or mentioned name is not a configured server', () => {
  assert.equal(
    opencodeConfigHasZvecGrep(`{
      // "zvec_grep": { "command": "zg" }
      /* "zvec_grep": {} */
      "note": "do not add zvec_grep here"
    }`),
    false
  );
  assert.equal(opencodeConfigHasZvecGrep(CONFIGURED), true);
});

test('enable installs zg when it is missing, then connects OpenCode', async () => {
  let packageInstalled = false;
  let configured = false;
  const calls: string[] = [];
  const result = await applyZvecGrep(true, io('linux', async (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'zg' && args[0] === '--version') {
      return packageInstalled ? ok('1.0.0') : missing();
    }
    if (command === 'node') {
      return ok('v22.14.0');
    }
    if (command === 'npm') {
      packageInstalled = true;
      return ok('added 1 package');
    }
    if (args[0] === '--install') {
      configured = true;
      return ok('installed opencode');
    }
    return fail('unexpected');
  }, async () => (configured ? CONFIGURED : '{ "mcp": {} }')));

  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(result.cli, 'installed');
  assert.deepEqual(calls, [
    'zg --version',
    'node --version',
    'npm install -g @zvec/zvec-grep',
    'zg --version',
    'zg --install --target opencode --yes',
    'zg --version'
  ]);
});

test('enable skips npm when zg is already installed', async () => {
  const calls: string[] = [];
  const result = await applyZvecGrep(true, io('linux', async (command, args) => {
    calls.push(command);
    if (args[0] === '--version') {
      return ok('1.2.3');
    }
    return ok('installed');
  }, async () => CONFIGURED));

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['zg', 'zg', 'zg']);
});

test('enable refuses Node older than 22 and does not install', async () => {
  const calls: string[] = [];
  const result = await applyZvecGrep(true, io('linux', async (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'zg') {
      return missing();
    }
    return ok('v21.7.0');
  }, async () => undefined));

  assert.equal(result.ok, false);
  assert.match(result.message, /Node\.js 22/);
  assert.equal(calls.some((call) => call.startsWith('npm')), false);
  assert.equal(calls.some((call) => call.includes('--install')), false);
});

test('an unmanaged entry is reported and not forced', async () => {
  const calls: string[][] = [];
  const result = await applyZvecGrep(true, io('linux', async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === '--version') {
      return ok('1.0.0');
    }
    return { code: 1, stdout: '', stderr: 'An unmanaged zvec_grep entry already exists.', error: undefined };
  }, async () => '{ "mcp": {} }'));

  assert.equal(result.ok, false);
  assert.match(result.message, /unmanaged zvec_grep/);
  assert.equal(calls.some((call) => call.includes('--force')), false);
});

test('disable uninstalls the integration and leaves the package installed', async () => {
  let configured = true;
  const calls: string[] = [];
  const result = await applyZvecGrep(false, io('linux', async (command, args) => {
    calls.push([command, ...args].join(' '));
    if (args[0] === '--uninstall') {
      configured = false;
      return ok('removed');
    }
    return ok('1.0.0');
  }, async () => (configured ? CONFIGURED : '{ "mcp": {} }')));

  assert.equal(result.ok, true);
  assert.equal(result.enabled, false);
  assert.equal(result.cli, 'installed');
  assert.equal(calls.some((call) => call.startsWith('npm')), false);
  assert.equal(calls.includes('zg --uninstall --target opencode --yes'), true);
});

test('disable is a no-op when OpenCode is not configured', async () => {
  const calls: string[] = [];
  const result = await applyZvecGrep(false, io('linux', async (command, args) => {
    calls.push(args[0] ?? command);
    return missing();
  }, async () => undefined));

  assert.equal(result.ok, true);
  assert.equal(result.enabled, false);
  assert.equal(calls.includes('--uninstall'), false);
});

test('detection requires both the CLI and the server entry', async () => {
  const present = await detectZvecGrep(io('linux', async () => ok('1.0.0'), async () => CONFIGURED));
  assert.deepEqual(present, { enabled: true, cli: 'installed' });

  const noCli = await detectZvecGrep(io('linux', async () => missing(), async () => CONFIGURED));
  assert.deepEqual(noCli, { enabled: false, cli: 'missing' });
});

test('Windows uses the npm shims', async () => {
  let packageInstalled = false;
  const calls: string[] = [];
  const result = await applyZvecGrep(true, io('win32', async (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'zg.cmd') {
      return missing();
    }
    if (command === 'zg' && args[0] === '--version') {
      return packageInstalled ? ok('1.0.0') : missing();
    }
    if (command === 'node') {
      return ok('v22.0.0');
    }
    if (command === 'npm.cmd') {
      packageInstalled = true;
      return ok('added');
    }
    if (command === 'zg' && args[0] === '--install') {
      return ok('installed');
    }
    return fail(command);
  }, async () => CONFIGURED));
  assert.equal(result.ok, true);

  assert.equal(calls.includes('npm.cmd install -g @zvec/zvec-grep'), true);
  assert.equal(calls.includes('zg.cmd --version'), true);
  assert.equal(calls.includes('zg --install --target opencode --yes'), true);
});

function io(
  platform: NodeJS.Platform,
  run: CommandRunner,
  readConfig: () => Promise<string | undefined>
): ZvecGrepIO {
  return { platform, run, readConfig };
}

function ok(stdout: string): SpawnOutcome {
  return { code: 0, stdout, stderr: '' };
}

function missing(): SpawnOutcome {
  return { code: null, stdout: '', stderr: '', error: 'missing' };
}

function fail(stderr: string): SpawnOutcome {
  return { code: 1, stdout: '', stderr };
}
