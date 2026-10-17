import test from 'node:test';
import assert from 'node:assert/strict';
import {
  opencodeConfigHasMcpServer,
  removeOpencodeMcpServer,
  upsertOpencodeMcpServer,
  type OpencodeUserConfigIO
} from './userConfig.ts';

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

test('upsert and remove rewrite the MCP map', async () => {
  const store: { text?: string } = {};
  const path = '/tmp/opencode.json';
  const io: OpencodeUserConfigIO = {
    platform: 'linux',
    homedir: '/home/me',
    opencodeConfig: path,
    exists: (candidate) => candidate === path && store.text !== undefined,
    readFile: async () => {
      if (!store.text) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return store.text;
    },
    writeFile: async (_p, text) => {
      store.text = text;
    },
    mkdir: async () => undefined
  };

  await upsertOpencodeMcpServer(
    'ast_grep',
    { type: 'local', command: ['node', '/ext/dist/ast-grep-mcp.js'], enabled: true },
    io
  );
  assert.match(store.text ?? '', /"ast_grep"/);
  assert.equal(opencodeConfigHasMcpServer(store.text ?? '', 'ast_grep'), true);

  const removed = await removeOpencodeMcpServer('ast_grep', io);
  assert.equal(removed.removed, true);
  assert.equal(opencodeConfigHasMcpServer(store.text ?? '', 'ast_grep'), false);
});
