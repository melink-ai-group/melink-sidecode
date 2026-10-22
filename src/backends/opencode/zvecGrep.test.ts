import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  applyZvecGrep,
  commandLaunch,
  commandNotFound,
  detectZvecGrep,
  firstExisting,
  nodeMajor,
  npmGlobalInstallArgs,
  npmPrefixInstallArgs,
  zgGlobalBin,
  zvecVersionSupported,
  opencodeConfigCandidates,
  opencodeConfigHasZvecGrep,
  rejectsIntegrationVerb,
  zgIntegrationArgs,
  type CommandRunner,
  type SpawnOutcome,
  type ZvecGrepIO
} from './zvecGrep.ts';
import type { OpencodeUserConfigIO } from './userConfig.ts';
import {
  bundledZvecGrepExecutable,
  bundledZvecGrepPrefix,
  resolveZvecGrepExecutable
} from '../zvecGrep/resolve.ts';
import { windowsCommandCandidates } from '../launch.ts';

const CONFIGURED = `{
  // "zvec_grep": { "command": "ignored" }
  "mcp": {
    "other": { "command": "echo" },
    "zvec_grep": { "type": "local", "command": ["zg", "server", "--stdio"] }
  }
}`;

test('node major is read from a version line', () => {
  assert.equal(nodeMajor('v22.14.0'), 22);
  assert.equal(nodeMajor('v21.0.0\n'), 21);
  assert.equal(nodeMajor('not a version'), undefined);
});

test('only zg 0.2 or newer supports the server subcommand', () => {  assert.equal(zvecVersionSupported('0.2.2'), true);
  assert.equal(zvecVersionSupported('0.3.0'), true);
  assert.equal(zvecVersionSupported('1.0.0'), true);
  assert.equal(zvecVersionSupported('0.1.9'), false);
  assert.equal(zvecVersionSupported('0.0.1'), false);
  assert.equal(zvecVersionSupported(undefined), true);
});

test('integration args use the current installer form and never force', () => {
  assert.deepEqual(zgIntegrationArgs('install'), ['install', '--target', 'opencode', '--yes']);
  assert.deepEqual(zgIntegrationArgs('uninstall'), ['uninstall', '--target', 'opencode', '--yes']);
  assert.deepEqual(zgIntegrationArgs('install', 'flag'), ['--install', '--target', 'opencode', '--yes']);
  assert.deepEqual(npmGlobalInstallArgs(), ['install', '-g', '@zvec/zvec-grep']);
  assert.deepEqual(npmPrefixInstallArgs('/tmp/zg'), [
    'install',
    '-g',
    '--prefix',
    '/tmp/zg',
    '@zvec/zvec-grep'
  ]);
  assert.equal(zgIntegrationArgs('install').includes('--force'), false);
  assert.equal(
    rejectsIntegrationVerb({ code: 1, stdout: '', stderr: 'Error: Unknown command: --install.' }, 'install'),
    true
  );
});

test('a bare zg resolves to the Windows cmd shim', () => {
  const roots = { extensionPath: '/ext' };
  assert.equal(
    resolveZvecGrepExecutable({ source: 'local', path: 'zg', roots, platform: 'win32' }),
    'zg.cmd'
  );
  assert.equal(
    resolveZvecGrepExecutable({ source: 'local', path: 'zg', roots, platform: 'linux' }),
    'zg'
  );
  assert.equal(
    resolveZvecGrepExecutable({ source: 'local', path: 'C:\\tools\\zg.exe', roots, platform: 'win32' }),
    'C:\\tools\\zg.exe'
  );
  assert.deepEqual(windowsCommandCandidates('ast-grep', 'win32'), [
    'ast-grep.exe',
    'ast-grep.cmd',
    'ast-grep'
  ]);
  assert.deepEqual(windowsCommandCandidates('C:\\tools\\ast-grep.exe', 'win32'), [
    'C:\\tools\\ast-grep.exe'
  ]);
  assert.deepEqual(windowsCommandCandidates('ast-grep', 'linux'), ['ast-grep']);
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
  const store = memoryConfig();
  const calls: string[] = [];
  const result = await applyZvecGrep(true, {
    io: io('linux', async (command, args) => {
      calls.push([command, ...args].join(' '));
      if (command === 'zg' && args[0] === '--version') {
        return packageInstalled ? ok('1.0.0') : missing();
      }
      if (command === 'node') {
        return ok('v22.14.0');
      }
      if (command === 'npm' && args[0] === 'prefix') {
        return ok('/usr/local');
      }
      if (command === 'npm') {
        packageInstalled = true;
        return ok('added 1 package');
      }
      if (command === zgGlobalBin('/usr/local', 'linux')) {
        return missing();
      }
      if (args[0] === 'install') {
        return ok('installed opencode');
      }
      return fail('unexpected');
    }, async () => store.text),
    userConfig: store.io
  });

  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(result.cli, 'installed');
  assert.equal(opencodeConfigHasZvecGrep(store.text ?? ''), true);
  assert.equal(calls.includes('npm install -g @zvec/zvec-grep'), true);
  assert.equal(calls.includes('zg install --target opencode --yes'), true);
});

test('enable skips npm when zg is already installed', async () => {
  const store = memoryConfig(CONFIGURED);
  const calls: string[] = [];
  const result = await applyZvecGrep(true, {
    io: io(
      'linux',
      async (command, args) => {
        calls.push(command);
        if (args[0] === '--version') {
          return ok('1.2.3');
        }
        return ok('installed');
      },
      async () => store.text
    ),
    userConfig: store.io
  });

  assert.equal(result.ok, true);
  assert.equal(calls.includes('npm'), false);
});

test('enable refuses Node older than 22 and does not install', async () => {
  const store = memoryConfig();
  const calls: string[] = [];
  const result = await applyZvecGrep(true, {
    io: io(
      'linux',
      async (command, args) => {
        calls.push([command, ...args].join(' '));
        if (command === 'node') {
          return ok('v21.7.0');
        }
        return missing();
      },
      async () => store.text
    ),
    userConfig: store.io
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /Node\.js 22/);
  assert.equal(calls.some((call) => call.startsWith('npm install')), false);
});

test('bundled enable installs into the sideCode prefix', async () => {
  const store = memoryConfig();
  const roots = { extensionPath: '/ext', globalStoragePath: '/storage' };
  const bin = bundledZvecGrepExecutable(roots, 'linux');
  const prefix = bundledZvecGrepPrefix(roots);
  let packageInstalled = false;
  const calls: string[] = [];
  const result = await applyZvecGrep(true, {
    source: 'bundled',
    roots,
    io: io(
      'linux',
      async (command, args) => {
        calls.push([command, ...args].join(' '));
        if (command === bin && args[0] === '--version') {
          return packageInstalled ? ok('1.0.0') : missing();
        }
        if (command === 'node') {
          return ok('v22.14.0');
        }
        if (command === 'npm' && args[0] === 'install') {
          packageInstalled = true;
          return ok('added');
        }
        if (args[0] === 'install') {
          return ok('ok');
        }
        return missing();
      },
      async () => store.text
    ),
    userConfig: store.io
  });

  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(calls.includes(`npm install -g --prefix ${prefix} @zvec/zvec-grep`), true);
  assert.match(store.text ?? '', /zvec_grep/);
});

test('disable removes the MCP entry and leaves the package installed', async () => {
  const store = memoryConfig(CONFIGURED);
  const calls: string[] = [];
  const result = await applyZvecGrep(false, {
    io: io(
      'linux',
      async (command, args) => {
        calls.push([command, ...args].join(' '));
        return ok('1.0.0');
      },
      async () => store.text
    ),
    userConfig: store.io
  });

  assert.equal(result.ok, true);
  assert.equal(result.enabled, false);
  assert.equal(result.cli, 'installed');
  assert.equal(opencodeConfigHasZvecGrep(store.text ?? ''), false);
  assert.equal(calls.some((call) => call.startsWith('npm')), false);
  assert.equal(calls.includes('zg uninstall --target opencode --yes'), true);
});

test('disable is a no-op when OpenCode is not configured', async () => {
  const store = memoryConfig();
  const calls: string[] = [];
  const result = await applyZvecGrep(false, {
    io: io(
      'linux',
      async (command, args) => {
        calls.push(args[0] ?? command);
        return missing();
      },
      async () => store.text
    ),
    userConfig: store.io
  });

  assert.equal(result.ok, true);
  assert.equal(result.enabled, false);
  assert.equal(calls.includes('--uninstall'), false);
});

test('detection requires both the CLI and the server entry', async () => {
  const store = memoryConfig(CONFIGURED);
  const present = await detectZvecGrep({
    io: io('linux', async () => ok('1.0.0'), async () => store.text),
    userConfig: store.io
  });
  assert.deepEqual(present, { enabled: true, cli: 'installed' });

  const noCli = await detectZvecGrep({
    io: io('linux', async () => missing(), async () => store.text),
    userConfig: store.io
  });
  assert.deepEqual(noCli, { enabled: false, cli: 'missing' });
});

test('detection verifies the MCP handshake, not only --version', async () => {
  const store = memoryConfig(CONFIGURED);
  let seen: string[] = [];
  const ready = await detectZvecGrep({
    io: io(
      'linux',
      async () => ok('0.2.2'),
      async () => store.text,
      async (server) => {
        seen = server.command;
        return { ok: true, tools: ['zvec_grep_search'], calls: [] };
      }
    ),
    userConfig: store.io
  });
  assert.deepEqual(seen, ['zg', 'server', '--stdio']);
  assert.equal(ready.enabled, true);
  assert.equal(ready.server, 'ready');

  const broken = await detectZvecGrep({
    io: io(
      'linux',
      async () => ok('0.2.2'),
      async () => store.text,
      async () => ({ ok: false, tools: [], calls: [], message: 'Error: Unknown command: --server.' })
    ),
    userConfig: store.io
  });
  assert.deepEqual(broken, {
    enabled: false,
    cli: 'installed',
    server: 'failed',
    message: 'Error: Unknown command: --server.'
  });
});

test('a failed enable reports the reason and rolls the new entry back', async () => {
  const original = `{
  // keep this comment
  "theme": "dark",
  "mcp": {
    "other": { "command": "echo" },
  },
}`;
  const store = memoryConfig(original);
  const result = await applyZvecGrep(true, {
    io: io(
      'linux',
      async (_command, args) => (args[0] === '--version' ? ok('0.2.2') : ok('ok')),
      async () => store.text,
      async () => ({ ok: false, tools: [], calls: [], message: 'The server exited before answering.' })
    ),
    userConfig: store.io
  });
  assert.equal(result.ok, false);
  assert.equal(result.enabled, false);
  assert.match(result.message, /exited before answering/);
  assert.equal(store.text, original);
  assert.equal(opencodeConfigHasZvecGrep(store.text ?? ''), false);
});

test('Windows starts cmd shims through cmd.exe', () => {
  assert.deepEqual(commandLaunch('win32', 'npm.cmd', ['install', '-g', '@zvec/zvec-grep']), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', '"npm.cmd install -g @zvec/zvec-grep"'],
    verbatim: true
  });
  assert.equal(commandLaunch('linux', 'npm', ['--version']).verbatim, false);
  assert.equal(
    commandNotFound({
      code: 1,
      stdout: '',
      stderr: "'zg' is not recognized as an internal or external command"
    }),
    true
  );
});

test('a global zg outside PATH is used after install', async () => {
  const prefix = 'C:\\home\\me\\.npm-global';
  const bin = zgGlobalBin(prefix, 'win32');
  let packageInstalled = false;
  const store = memoryConfig();
  const result = await applyZvecGrep(true, {
    io: io(
      'win32',
      async (command, args) => {
        if (command === 'zg.cmd' || command === 'zg') {
          return missing();
        }
        if (command === 'node') {
          return ok('v22.14.0');
        }
        if (command === 'npm.cmd' && args[0] === 'prefix') {
          return ok(prefix);
        }
        if (command === 'npm.cmd' && args[0] === 'install') {
          packageInstalled = true;
          return ok('added');
        }
        if (command === bin && args[0] === '--version') {
          return packageInstalled ? ok('1.0.0') : missing();
        }
        if (command === bin && args[0] === 'install') {
          return ok('installed');
        }
        return fail(`${command} ${args.join(' ')}`);
      },
      async () => store.text
    ),
    userConfig: store.io
  });

  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.match(result.message, /connected to OpenCode/);
});

test('a relative zg path with a separator is never run', async () => {
  // The child would run with the workspace as its working directory, so a
  // relative path would name a file inside the repository.
  const commands: string[] = [];
  const store = memoryConfig();
  const result = await detectZvecGrep({
    source: 'local',
    path: './evil',
    roots: { extensionPath: 'C:\\ext' },
    io: io(
      'linux',
      async (command, args) => {
        commands.push(`${command} ${args.join(' ')}`);
        return missing();
      },
      async () => store.text
    ),
    userConfig: store.io
  });
  assert.equal(commands.some((command) => command.includes('evil')), false);
  assert.deepEqual(result, { enabled: false, cli: 'missing' });
});

test('Windows EINVAL on the cmd shim still installs zg', async () => {
  let packageInstalled = false;
  const store = memoryConfig();
  const calls: string[] = [];
  const result = await applyZvecGrep(true, {
    io: io(
      'win32',
      async (command, args) => {
        calls.push([command, ...args].join(' '));
        if (command === 'zg.cmd') {
          return { code: null, stdout: '', stderr: '', error: 'failed' };
        }
        if (command === 'zg' && args[0] === '--version') {
          return packageInstalled ? ok('1.0.0') : missing();
        }
        if (command === 'node') {
          return ok('v22.1.0');
        }
        if (command === 'npm.cmd' && args[0] === 'prefix') {
          return missing();
        }
        if (command === 'npm.cmd') {
          packageInstalled = true;
          return ok('added');
        }
        if (command === 'zg' && args[0] === 'install') {
          return ok('installed');
        }
        return fail(command);
      },
      async () => store.text
    ),
    userConfig: store.io
  });

  assert.equal(result.ok, true);
  assert.equal(calls.includes('npm.cmd install -g @zvec/zvec-grep'), true);
});

test('Windows uses the npm shims', async () => {
  let packageInstalled = false;
  const store = memoryConfig();
  const calls: string[] = [];
  const result = await applyZvecGrep(true, {
    io: io(
      'win32',
      async (command, args) => {
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
        if (command === 'npm.cmd' && args[0] === 'prefix') {
          return missing();
        }
        if (command === 'npm.cmd') {
          packageInstalled = true;
          return ok('added');
        }
        if (command === 'zg' && args[0] === 'install') {
          return ok('installed');
        }
        return fail(command);
      },
      async () => store.text
    ),
    userConfig: store.io
  });
  assert.equal(result.ok, true);

  assert.equal(calls.includes('npm.cmd install -g @zvec/zvec-grep'), true);
  assert.equal(calls.includes('zg.cmd --version'), true);
  assert.equal(calls.includes('zg install --target opencode --yes'), true);
});

function memoryConfig(initial?: string): { text: string | undefined; io: OpencodeUserConfigIO } {
  const path = '/tmp/opencode/opencode.json';
  const store: { text: string | undefined; io: OpencodeUserConfigIO } = {
    text: initial,
    io: {
      platform: 'linux',
      homedir: '/home/me',
      exists: (candidate) => candidate === path && store.text !== undefined,
      readFile: async () => {
        if (store.text === undefined) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return store.text;
      },
      writeFile: async (_p, text) => {
        store.text = text;
      },
      mkdir: async () => undefined,
      opencodeConfig: path
    }
  };
  return store;
}

function io(
  platform: NodeJS.Platform,
  run: CommandRunner,
  readConfig: () => Promise<string | undefined>,
  probeServer?: (server: { command: string[] }) => Promise<{
    ok: boolean;
    tools: string[];
    calls: { ok: boolean; text?: string; error?: string }[];
    message?: string;
  }>
): ZvecGrepIO {
  return { platform, run, readConfig, ...(probeServer ? { probeServer } : {}) };
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
