import test from 'node:test';
import assert from 'node:assert/strict';
import {
  opencodeConfigHasMcpServer,
  parseOpencodeConfig,
  readOpencodeUserConfig,
  removeOpencodeMcpServer,
  stripTrailingCommas,
  upsertOpencodeMcpServer,
  type OpencodeUserConfigIO
} from './userConfig.ts';

/**
 * The OpenCode config is the user's own file. A trailing comma or a comment
 * used to make the reader return `{}`, and the next skill enable rewrote the
 * file with only the MCP map — losing `$schema`, `provider`, `theme` and every
 * other key. These tests pin the safe behaviour.
 */

test('mcp server key detection ignores comments and string mentions', () => {
  assert.equal(
    opencodeConfigHasMcpServer(
      `{
      // "ast_grep": {}
      "note": "ast_grep"
    }`,
      'ast_grep'
    ),
    false
  );
  assert.equal(
    opencodeConfigHasMcpServer(`{ "mcp": { "ast_grep": { "type": "local" } } }`, 'ast_grep'),
    true
  );
});

test('JSONC trailing commas and comments are accepted', () => {
  const parsed = parseOpencodeConfig(`{
    // keep me
    "$schema": "https://opencode.ai/config.json",
    "theme": "dark",
    "list": [1, 2,],
  }`);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.data.theme, 'dark');
  assert.deepEqual(parsed.data.list, [1, 2]);
  assert.equal(stripTrailingCommas('[1, 2, ]'), '[1, 2 ]');
  assert.equal(stripTrailingCommas('{"a": "x,}",}'), '{"a": "x,}"}');
});

test('an unparsable config is reported and never rewritten', async () => {
  const store = memoryStore('{ "theme": }');
  const read = await readOpencodeUserConfig(store.io);
  assert.ok(read.error);
  assert.equal(read.text, '{ "theme": }');
  await assert.rejects(
    upsertOpencodeMcpServer('ast_grep', { type: 'local', command: ['node', 'x.js'] }, store.io),
    /left unchanged/
  );
  assert.equal(store.files.get('/tmp/opencode/opencode.json'), '{ "theme": }');
  assert.equal(store.files.has('/tmp/opencode/opencode.json.bak'), false);
});

test('upsert preserves unrelated keys and keeps a backup', async () => {
  const original = `{
  // my own settings
  "$schema": "https://opencode.ai/config.json",
  "theme": "dark",
  "provider": { "custom": { "npm": "@ai-sdk/openai-compatible" } },
  "mcp": {
    "other": { "command": "echo" },
  },
}`;
  const store = memoryStore(original);

  await upsertOpencodeMcpServer(
    'ast_grep',
    { type: 'local', command: ['node', '/ext/dist/ast-grep-mcp.js'], enabled: true },
    store.io
  );

  const next = store.files.get('/tmp/opencode/opencode.json') ?? '';
  assert.equal(store.files.get('/tmp/opencode/opencode.json.bak'), original);
  assert.match(next, /\/\/ my own settings/);
  assert.match(next, /\}$/);
  const parsed = parseOpencodeConfig(next);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.data.$schema, 'https://opencode.ai/config.json');
  assert.equal(parsed.data.theme, 'dark');
  assert.deepEqual(parsed.data.provider, { custom: { npm: '@ai-sdk/openai-compatible' } });
  const mcp = parsed.data.mcp as Record<string, unknown>;
  assert.deepEqual(mcp.other, { command: 'echo' });
  assert.equal(opencodeConfigHasMcpServer(next, 'ast_grep'), true);
});

test('upsert and remove keep comments, trailing commas and other entries', async () => {
  const original = `{
  // keep this comment
  "theme": "dark",
  "mcp": {
    "other": { "command": "echo" }, // still here
    "zvec_grep": { "command": ["zg", "server", "--stdio"] },
  },
}`;
  const store = memoryStore(original);
  await upsertOpencodeMcpServer(
    'ast_grep',
    { type: 'local', command: ['node', '/ext/dist/ast-grep-mcp.js'], enabled: true },
    store.io
  );
  const next = store.files.get('/tmp/opencode/opencode.json') ?? '';
  assert.match(next, /\/\/ keep this comment/);
  assert.match(next, /\/\/ still here/);
  assert.equal(store.files.get('/tmp/opencode/opencode.json.bak'), original);
  const parsed = parseOpencodeConfig(next);
  assert.equal(parsed.error, undefined);
  assert.deepEqual((parsed.data.mcp as any).zvec_grep, {
    command: ['zg', 'server', '--stdio']
  });
  assert.equal(opencodeConfigHasMcpServer(next, 'ast_grep'), true);

  const removed = await removeOpencodeMcpServer('ast_grep', store.io);
  assert.equal(removed.removed, true);
  const afterRemove = store.files.get('/tmp/opencode/opencode.json') ?? '';
  assert.match(afterRemove, /\/\/ keep this comment/);
  assert.match(afterRemove, /\/\/ still here/);
  assert.equal(opencodeConfigHasMcpServer(afterRemove, 'ast_grep'), false);
  assert.equal(parseOpencodeConfig(afterRemove).error, undefined);
});

test('removing the only entry leaves the rest of the JSONC file untouched', async () => {
  const original = `{
  // before
  "theme": "dark",
  "mcp": {
    "ast_grep": { "command": ["node", "x.js"] }, // the only entry
  },
  // after
  "provider": { "custom": {} },
}`;
  const store = memoryStore(original);
  await removeOpencodeMcpServer('ast_grep', store.io);
  const next = store.files.get('/tmp/opencode/opencode.json') ?? '';
  assert.match(next, /\/\/ before/);
  assert.match(next, /\/\/ after/);
  assert.equal(next.includes('"mcp"'), false);
  assert.deepEqual(parseOpencodeConfig(next).data.provider, { custom: {} });
});

test('upsert and remove a fresh config still work', async () => {
  const store = memoryStore();
  await upsertOpencodeMcpServer(
    'ast_grep',
    { type: 'local', command: ['node', '/ext/dist/ast-grep-mcp.js'], enabled: true },
    store.io
  );
  assert.match(store.files.get('/tmp/opencode/opencode.json') ?? '', /"ast_grep"/);

  const removed = await removeOpencodeMcpServer('ast_grep', store.io);
  assert.equal(removed.removed, true);
  assert.equal(
    opencodeConfigHasMcpServer(store.files.get('/tmp/opencode/opencode.json') ?? '', 'ast_grep'),
    false
  );
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
  const io: OpencodeUserConfigIO = {
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
  };
  return { files, io };
}
