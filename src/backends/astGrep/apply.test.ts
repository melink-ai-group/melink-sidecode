import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAstGrep, detectAstGrep, migrateLegacyAstGrepEntry } from './apply.ts';
import { parseOpencodeConfig, type OpencodeUserConfigIO } from '../opencode/userConfig.ts';
import type { SpawnOutcome } from '../opencode/zvecGrep.ts';

const CONFIGURED = `{
  "mcp": {
    "ast_grep": { "type": "local", "command": ["old", "shim.js"] }
  }
}`;

async function withShim(run: (shim: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'melink-ast-apply-'));
  const shim = join(dir, 'ast-grep-mcp.js');
  await writeFile(shim, '', 'utf8');
  try {
    await run(shim);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('detection probes the real shim entry, not just --version', async () => {
  await withShim(async (shim) => {
    const store = memoryStore(CONFIGURED);
    let probed: { command: string[]; environment?: Record<string, string> } | undefined;
    const ready = await detectAstGrep({
      source: 'local',
      path: 'ast-grep',
      roots: { extensionPath: '/ext' },
      mcpScriptPath: shim,
      run: async () => ok('ast-grep 0.51.0'),
      probeServer: async (server) => {
        probed = server;
        return { ok: true, tools: ['search', 'replace'], calls: [] };
      },
      userConfig: store.io
    });
    assert.equal(ready.enabled, true);
    assert.equal(ready.server, 'ready');
    assert.equal(probed?.command[0], process.execPath);
    assert.equal(probed?.command[1], shim);
    assert.equal(probed?.environment?.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(probed?.environment?.AST_GREP_BIN, 'ast-grep');

    const broken = await detectAstGrep({
      source: 'local',
      path: 'ast-grep',
      roots: { extensionPath: '/ext' },
      mcpScriptPath: shim,
      run: async () => ok('ast-grep 0.51.0'),
      probeServer: async () => ({ ok: false, tools: [], calls: [], message: 'Unknown command: --server.' }),
      userConfig: store.io
    });
    assert.equal(broken.enabled, false);
    assert.equal(broken.server, 'failed');
    assert.equal(broken.message, 'Unknown command: --server.');
  });
});

test('detection reports a missing shim before claiming connected', async () => {
  await withShim(async () => {
    const store = memoryStore(CONFIGURED);
    const status = await detectAstGrep({
      source: 'local',
      path: 'ast-grep',
      roots: { extensionPath: '/ext' },
      mcpScriptPath: '/does/not/exist/ast-grep-mcp.js',
      run: async () => ok('ast-grep 0.51.0'),
      userConfig: store.io
    });
    assert.equal(status.enabled, false);
    assert.equal(status.server, 'failed');
    assert.match(status.message ?? '', /shim is missing/);
  });
});

test('detection reports a missing CLI', async () => {
  await withShim(async (shim) => {
    const store = memoryStore(CONFIGURED);
    const status = await detectAstGrep({
      source: 'local',
      path: 'ast-grep',
      roots: { extensionPath: '/ext' },
      mcpScriptPath: shim,
      run: async () => missing(),
      userConfig: store.io
    });
    assert.deepEqual(status, { enabled: false, cli: 'missing', path: 'ast-grep' });
  });
});

test('enable refuses to wipe an unparsable OpenCode config', async () => {
  await withShim(async (shim) => {
    const store = memoryStore('{ "theme": }');
    const result = await applyAstGrep({
      enabled: true,
      source: 'local',
      path: 'ast-grep',
      roots: { extensionPath: '/ext' },
      mcpScriptPath: shim,
      run: async () => ok('ast-grep 0.51.0'),
      userConfig: store.io
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /left unchanged/);
    assert.equal(store.files.get('/tmp/opencode/opencode.json'), '{ "theme": }');
  });
});

test('a failed enable rolls the config back instead of leaving a live entry', async () => {
  await withShim(async (shim) => {
    const original = `{
  // keep this comment
  "theme": "dark",
  "mcp": {
    "other": { "command": "echo" },
  },
}`;
    const store = memoryStore(original);
    const result = await applyAstGrep({
      enabled: true,
      source: 'local',
      path: 'ast-grep',
      roots: { extensionPath: '/ext' },
      mcpScriptPath: shim,
      run: async () => ok('ast-grep 0.51.0'),
      probeServer: async () => ({
        ok: false,
        tools: [],
        calls: [],
        message: 'The ast-grep MCP server did not answer.'
      }),
      userConfig: store.io
    });
    assert.equal(result.ok, false);
    assert.equal(result.enabled, false);
    assert.match(result.message, /did not answer/);
    assert.equal(store.files.get('/tmp/opencode/opencode.json'), original);
  });
});

test('a stale ast-grep entry is migrated to the Node runtime and stays idempotent', async () => {
  await withShim(async (shim) => {
    const original = `{
  // user comment
  "mcp": {
    "ast_grep": {
      "type": "local",
      "command": ["C:\\\\Program Files\\\\Microsoft VS Code\\\\Code.exe", "${shim.replace(/\\/g, '\\\\')}"],
      "environment": { "AST_GREP_BIN": "C:\\\\tools\\\\ast-grep.exe" },
      "enabled": true,
    },
  },
}`;
    const store = memoryStore(original);
    const result = await migrateLegacyAstGrepEntry({ mcpScriptPath: shim, userConfig: store.io });
    assert.equal(result.changed, true);
    const next = store.files.get('/tmp/opencode/opencode.json') ?? '';
    assert.match(next, /\/\/ user comment/);
    assert.equal(store.files.get('/tmp/opencode/opencode.json.bak'), original);
    const parsed = parseOpencodeConfig(next);
    assert.equal(parsed.error, undefined);
    const migrated = parsed.data.mcp as Record<string, any>;
    assert.equal(migrated.ast_grep.command[0], process.execPath);
    assert.equal(migrated.ast_grep.command[1], shim);
    assert.equal(migrated.ast_grep.environment.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(migrated.ast_grep.environment.AST_GREP_BIN, 'C:\\tools\\ast-grep.exe');

    const again = await migrateLegacyAstGrepEntry({ mcpScriptPath: shim, userConfig: store.io });
    assert.equal(again.changed, false);
  });
});

test('a canonical ast-grep entry is not rewritten', async () => {
  await withShim(async (shim) => {
    const canonical = JSON.stringify({
      mcp: {
        ast_grep: {
          type: 'local',
          command: [process.execPath, shim],
          environment: { AST_GREP_BIN: 'ast-grep', ELECTRON_RUN_AS_NODE: '1' },
          enabled: true
        }
      }
    });
    const store = memoryStore(canonical);
    const result = await migrateLegacyAstGrepEntry({ mcpScriptPath: shim, userConfig: store.io });
    assert.equal(result.changed, false);
    assert.equal(store.files.get('/tmp/opencode/opencode.json'), canonical);
  });
});

function memoryStore(initial?: string): {
  files: Map<string, string>;
  io: OpencodeUserConfigIO;
} {
  const path = '/tmp/opencode/opencode.json';
  const files = new Map<string, string>();
  if (initial !== undefined) {
    files.set(path, initial);
  }
  return {
    files,
    io: {
      platform: 'linux',
      homedir: '/home/me',
      opencodeConfig: path,
      exists: (candidate) => files.has(candidate),
      readFile: async (candidate) => {
        const text = files.get(candidate);
        if (text === undefined) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return text;
      },
      writeFile: async (candidate, text) => {
        files.set(candidate, text);
      },
      mkdir: async () => undefined
    }
  };
}

function ok(stdout: string): SpawnOutcome {
  return { code: 0, stdout, stderr: '' };
}

function missing(): SpawnOutcome {
  return { code: null, stdout: '', stderr: '', error: 'missing' };
}
