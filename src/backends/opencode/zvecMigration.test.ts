import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateLegacyZvecServer } from './zvecGrep.ts';
import { parseOpencodeConfig, type OpencodeUserConfigIO } from './userConfig.ts';

/**
 * The legacy entry older builds wrote was `[zg, '--server', '--stdio']`, which
 * zg 0.2.x rejects. Migration is idempotent, preserves unrelated keys, keeps a
 * backup, and never touches an unparsable file.
 */

const PATH = '/tmp/opencode/opencode.json';

function store(initial?: string): {
  files: Map<string, string>;
  writes: string[];
  io: OpencodeUserConfigIO;
} {
  const files = new Map<string, string>();
  if (initial !== undefined) {
    files.set(PATH, initial);
  }
  const writes: string[] = [];
  return {
    files,
    writes,
    io: {
      platform: 'linux',
      homedir: '/home/me',
      opencodeConfig: PATH,
      exists: (candidate) => files.has(candidate),
      readFile: async (candidate) => {
        const text = files.get(candidate);
        if (text === undefined) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return text;
      },
      writeFile: async (candidate, text) => {
        writes.push(candidate);
        files.set(candidate, text);
      },
      mkdir: async () => undefined
    }
  };
}

test('the legacy --server entry is rewritten once and keeps unrelated keys', async () => {
  const original = `{
  "$schema": "https://opencode.ai/config.json",
  "theme": "dark",
  "provider": { "custom": {} },
  "mcp": {
    "other": { "command": "echo" },
    "zvec_grep": { "type": "local", "command": ["C:\\\\tools\\\\zg.cmd", "--server", "--stdio", "--mcp-toolset", "full"], "enabled": true }
  }
}`;
  const current = store(original);
  const result = await migrateLegacyZvecServer(current.io);
  assert.equal(result.changed, true);
  assert.equal(current.files.get(`${PATH}.bak`), original);
  const parsed = JSON.parse(current.files.get(PATH) ?? '') as Record<string, any>;
  assert.equal(parsed.$schema, 'https://opencode.ai/config.json');
  assert.equal(parsed.theme, 'dark');
  assert.deepEqual(parsed.provider, { custom: {} });
  assert.deepEqual(parsed.mcp.other, { command: 'echo' });
  assert.deepEqual(parsed.mcp.zvec_grep.command, [
    'C:\\tools\\zg.cmd',
    'server',
    '--stdio',
    '--mcp-toolset',
    'full'
  ]);
});

test('migration is idempotent: a canonical entry is not rewritten', async () => {
  const canonical = `{
  "mcp": { "zvec_grep": { "type": "local", "command": ["zg", "server", "--stdio"] } }
}`;
  const current = store(canonical);
  const result = await migrateLegacyZvecServer(current.io);
  assert.equal(result.changed, false);
  assert.deepEqual(current.writes, []);
});

test('a JSONC config keeps comments, formatting and unrelated keys byte-for-byte', async () => {
  const original = `{
  // my own settings
  "theme": "dark", /* keep this block comment */
  "provider": {
    // provider comments stay too
    "custom": {}
  },
  "mcp": {
    "other": { "command": "echo" },
    "zvec_grep": {
      "type": "local",
      "command": ["C:\\\\tools\\\\zg.cmd", "--server", "--stdio", "--mcp-toolset", "full"], // legacy argv
      "enabled": true,
    },
  },
}`;
  const current = store(original);
  const result = await migrateLegacyZvecServer(current.io);
  assert.equal(result.changed, true);
  assert.equal(result.mode, 'textual');
  assert.equal(current.files.get(`${PATH}.bak`), original);

  // Only the one argument token changed; comments, indentation, trailing
  // commas and every other key remain byte-for-byte.
  const expected = original.replace('"--server"', '"server"');
  assert.equal(current.files.get(PATH), expected);
  assert.match(current.files.get(PATH) ?? '', /\/\/ my own settings/);
  assert.match(current.files.get(PATH) ?? '', /\/\* keep this block comment \*\//);
  assert.match(current.files.get(PATH) ?? '', /\/\/ legacy argv/);

  const parsed = parseOpencodeConfig(current.files.get(PATH) ?? '');
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.data.theme, 'dark');
  assert.deepEqual(parsed.data.provider, { custom: {} });
  assert.deepEqual((parsed.data.mcp as any).other, { command: 'echo' });
  assert.deepEqual((parsed.data.mcp as any).zvec_grep.command, [
    'C:\\tools\\zg.cmd',
    'server',
    '--stdio',
    '--mcp-toolset',
    'full'
  ]);
});

test('ambiguous duplicate entries are refused instead of guessed at', async () => {
  const original = `{
  "mcp": {
    "zvec_grep": { "command": ["zg", "--server", "--stdio"] },
    "zvec_grep": { "command": ["zg", "--server", "--stdio", "--other"] }
  }
}`;
  const current = store(original);
  const result = await migrateLegacyZvecServer(current.io);
  assert.equal(result.changed, false);
  assert.match(result.message ?? '', /more than one "zvec_grep"/);
  assert.deepEqual(current.writes, []);
  assert.equal(current.files.get(PATH), original);
});

test('an unparsable config is never written', async () => {
  const current = store('{ "theme": }');
  const result = await migrateLegacyZvecServer(current.io);
  assert.equal(result.changed, false);
  assert.deepEqual(current.writes, []);
  assert.equal(current.files.get(PATH), '{ "theme": }');
});

test('no entry or no file is a no-op', async () => {
  const empty = store('{ "theme": "dark" }');
  assert.equal((await migrateLegacyZvecServer(empty.io)).changed, false);
  assert.deepEqual(empty.writes, []);

  const none = store();
  assert.equal((await migrateLegacyZvecServer(none.io)).changed, false);
  assert.deepEqual(none.writes, []);
});
