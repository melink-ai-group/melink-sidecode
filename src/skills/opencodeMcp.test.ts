import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  AST_GREP_BIN_ENV,
  AST_GREP_MCP_SERVER,
  AST_GREP_WORKSPACE_ENV,
  ELECTRON_RUN_AS_NODE_ENV,
  ZVEC_GREP_MCP_SERVER,
  astGrepMcpScriptPath,
  astGrepOpencodeServer,
  mergeSkillOpencodeMcp,
  skillPermissionKeys,
  zvecGrepOpencodeServer,
  zvecGrepServerArgs
} from './opencodeMcp.ts';

/**
 * These entries are the ones OpenCode actually spawns. They were untested while
 * both shipped broken: zvec used `--server` (rejected by zg 0.2.x) and ast-grep
 * used the extension host binary without `ELECTRON_RUN_AS_NODE`.
 */

test('zvec-grep uses the 0.2.x server subcommand', () => {
  assert.deepEqual(zvecGrepServerArgs(), ['server', '--stdio']);
  assert.deepEqual(zvecGrepOpencodeServer('/opt/zg/zg'), {
    type: 'local',
    command: ['/opt/zg/zg', 'server', '--stdio'],
    enabled: true
  });
  assert.equal(zvecGrepOpencodeServer('/opt/zg/zg').command.includes('--server'), false);
});

test('ast-grep runs the shim under Node with the CLI path in the environment', () => {
  const script = astGrepMcpScriptPath('/ext');
  assert.equal(script, join('/ext', 'dist', 'ast-grep-mcp.js'));

  const server = astGrepOpencodeServer({
    mcpScriptPath: script,
    astGrepExecutable: 'C:\\tools\\ast-grep.exe'
  });
  assert.equal(server.type, 'local');
  assert.deepEqual(server.command, [process.execPath, script]);
  assert.equal(server.environment?.[AST_GREP_BIN_ENV], 'C:\\tools\\ast-grep.exe');
  // Code.exe + this flag is a Node process; a real node ignores the flag.
  assert.equal(server.environment?.[ELECTRON_RUN_AS_NODE_ENV], '1');
  assert.equal(server.environment?.[AST_GREP_WORKSPACE_ENV], undefined);
});

test('ast-grep records the workspace root for path confinement', () => {
  const server = astGrepOpencodeServer({
    nodeExecutable: '/usr/bin/node',
    mcpScriptPath: '/ext/dist/ast-grep-mcp.js',
    astGrepExecutable: 'ast-grep',
    workspaceRoot: 'C:\\work\\repo'
  });
  assert.deepEqual(server.command, ['/usr/bin/node', '/ext/dist/ast-grep-mcp.js']);
  assert.equal(server.environment?.[AST_GREP_WORKSPACE_ENV], 'C:\\work\\repo');
});

test('merging skill servers keeps unrelated MCP entries', () => {
  const merged = mergeSkillOpencodeMcp(
    { browser: { type: 'local', command: ['node', 'browser.js'], enabled: true }, custom: {} },
    {
      zvecGrep: zvecGrepOpencodeServer('/opt/zg/zg'),
      astGrep: astGrepOpencodeServer({
        nodeExecutable: '/usr/bin/node',
        mcpScriptPath: '/ext/ast.js',
        astGrepExecutable: 'ast-grep'
      })
    }
  );
  assert.deepEqual(Object.keys(merged ?? {}).sort(), ['ast_grep', 'browser', 'custom', 'zvec_grep']);
  assert.deepEqual(mergeSkillOpencodeMcp(undefined, {}), undefined);
});

test('permission keys use the names OpenCode resolves and never pre-allow replace', () => {
  assert.deepEqual(skillPermissionKeys({ zvecGrep: true, astGrep: true }), {
    zvec_grep_zvec_grep_search: 'allow',
    ast_grep_search: 'allow'
  });
  // A bare server key would cover `replace` too; it must never be pre-allowed.
  const permissions = skillPermissionKeys({ zvecGrep: true, astGrep: true });
  assert.equal(permissions[AST_GREP_MCP_SERVER], undefined);
  assert.equal(permissions[ZVEC_GREP_MCP_SERVER], undefined);
  // OpenCode asks for `ast_grep_replace`; the bare tool name never matched.
  assert.equal(permissions.replace, undefined);
  assert.equal(permissions.ast_grep_replace, undefined);
  assert.equal(permissions.search, undefined);
  assert.deepEqual(skillPermissionKeys({}), {});
});
