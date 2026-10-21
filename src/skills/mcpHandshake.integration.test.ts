import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { astGrepMcpScriptPath, astGrepOpencodeServer, zvecGrepOpencodeServer } from './opencodeMcp.ts';
import { probeOpencodeServer } from './mcpProbe.ts';
import { commandLaunch } from '../backends/launch.ts';

/**
 * Real-binary, read-only end-to-end checks. They skip when the machine does
 * not have the CLI (or the built shim), so `npm test` still passes on a clean
 * checkout. Nothing here writes files, restarts VS Code, or touches the user's
 * OpenCode config.
 */

const shim = astGrepMcpScriptPath(process.cwd());

function findCli(names: readonly string[]): string | undefined {
  for (const name of names) {
    const launched = commandLaunch(process.platform, name, ['--version']);
    const result = spawnSync(launched.command, launched.args, {
      encoding: 'utf8',
      windowsHide: true,
      ...(launched.verbatim ? { windowsVerbatimArguments: true } : {})
    });
    if (result.status === 0) {
      return name;
    }
  }
  return undefined;
}

const astGrep = findCli(process.platform === 'win32' ? ['ast-grep.cmd', 'ast-grep.exe'] : ['ast-grep']);
const zg = findCli(process.platform === 'win32' ? ['zg.cmd', 'zg'] : ['zg']);

test('zvec-grep server answers initialize + tools/list', { skip: zg ? false : 'zg is not installed' }, async () => {
  const result = await probeOpencodeServer(zvecGrepOpencodeServer(zg as string), { timeoutMs: 20_000 });
  assert.equal(result.ok, true, result.message);
  assert.ok(result.tools.includes('zvec_grep_search'), result.tools.join(','));
});

test(
  'ast-grep shim answers a line-framed initialize with line-delimited JSON',
  { skip: astGrep && existsSync(shim) ? false : 'ast-grep or dist/ast-grep-mcp.js is not available' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'melink-ast-line-'));
    try {
      const server = astGrepOpencodeServer({
        mcpScriptPath: shim,
        astGrepExecutable: astGrep as string,
        workspaceRoot: dir
      });
      const launched = commandLaunch(process.platform, server.command[0] as string, server.command.slice(1));
      const child = spawn(launched.command, launched.args, {
        cwd: dir,
        env: { ...process.env, ...(server.environment ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        ...(launched.verbatim ? { windowsVerbatimArguments: true } : {})
      });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      const reply = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no line reply: ${stdout}`)), 15_000);
        child.stdout.on('data', () => {
          if (stdout.includes('\n')) {
            clearTimeout(timer);
            resolve(stdout);
          }
        });
        child.on('error', reject);
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'line-test' } }
          })}\n`
        );
      });
      child.kill();
      // OpenCode 1.19.x ignores a header reply here and times out.
      assert.match(reply.trimStart(), /^\{/);
      assert.doesNotMatch(reply, /Content-Length/i);
      const parsed = JSON.parse(reply.split('\n')[0] ?? '') as { id?: number; result?: unknown };
      assert.equal(parsed.id, 0);
      assert.ok(parsed.result);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
);

function findOpencode(): string | undefined {
  const candidates = [
    process.env.OPENCODE_BIN,
    process.env.APPDATA
      ? join(
          process.env.APPDATA,
          'Code',
          'User',
          'globalStorage',
          'melink.melink-sidecode',
          'opencode',
          'bin',
          'opencode.exe'
        )
      : undefined
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 15_000 });
    if (result.status === 0) {
      return candidate;
    }
  }
  return undefined;
}

const opencode = findOpencode();

test(
  'opencode mcp list connects the ast-grep entry (newline framing)',
  { skip: opencode && astGrep && existsSync(shim) ? false : 'opencode, ast-grep or the shim is not available' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'melink-opencode-mcp-'));
    const configPath = join(dir, 'opencode.json');
    try {
      const server = astGrepOpencodeServer({
        mcpScriptPath: shim,
        astGrepExecutable: astGrep as string,
        workspaceRoot: dir
      });
      await writeFile(
        configPath,
        `${JSON.stringify({ mcp: { ast_grep: server } }, null, 2)}\n`,
        'utf8'
      );
      const result = spawnSync(opencode as string, ['mcp', 'list'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
        env: {
          ...process.env,
          OPENCODE_CONFIG: configPath,
          HOME: dir,
          USERPROFILE: dir,
          XDG_CONFIG_HOME: dir
        }
      });
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/g, '');
      assert.equal(result.status, 0, output);
      assert.match(output, /ast_grep[\s\S]*connected/i);
      assert.doesNotMatch(output, /timed out/i);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
);

test(
  'ast-grep shim also answers Content-Length framed clients',
  { skip: astGrep && existsSync(shim) ? false : 'ast-grep or dist/ast-grep-mcp.js is not available' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'melink-ast-e2e-'));
    await writeFile(join(dir, 'sample.js'), 'console.log("hello");\n', 'utf8');
    try {
      const server = astGrepOpencodeServer({
        mcpScriptPath: shim,
        astGrepExecutable: astGrep as string,
        workspaceRoot: dir
      });
      const result = await probeOpencodeServer(server, {
        cwd: dir,
        framing: 'header',
        timeoutMs: 20_000,
        calls: [{ name: 'search', arguments: { pattern: 'console.log($$$A)', paths: ['.'] } }]
      });
      assert.equal(result.ok, true, result.message);
      assert.equal(result.calls[0]?.ok, true, result.calls[0]?.error);
      assert.match(result.calls[0]?.text ?? '', /sample\.js/);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
);

test(
  'ast-grep shim runs under Node and answers tools/list + a real search',
  { skip: astGrep && existsSync(shim) ? false : 'ast-grep or dist/ast-grep-mcp.js is not available' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'melink-ast-e2e-'));
    await writeFile(join(dir, 'sample.js'), 'const value = 1;\nconsole.log("hello", value);\n', 'utf8');
    try {
      const server = astGrepOpencodeServer({
        mcpScriptPath: shim,
        astGrepExecutable: astGrep as string,
        workspaceRoot: dir
      });
      const result = await probeOpencodeServer(server, {
        cwd: dir,
        timeoutMs: 30_000,
        calls: [
          {
            name: 'search',
            arguments: { pattern: 'console.log($$$ARGS)', lang: 'javascript', paths: ['.'] }
          }
        ]
      });
      assert.equal(result.ok, true, result.message);
      assert.ok(result.tools.includes('search'), result.tools.join(','));
      assert.ok(result.tools.includes('replace'), result.tools.join(','));
      assert.equal(result.calls[0]?.ok, true, result.calls[0]?.error);
      assert.match(result.calls[0]?.text ?? '', /sample\.js/);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
);

test(
  'ast-grep shim refuses a path outside the workspace and an unapproved write',
  { skip: astGrep && existsSync(shim) ? false : 'ast-grep or dist/ast-grep-mcp.js is not available' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'melink-ast-e2e-'));
    await writeFile(join(dir, 'sample.js'), 'console.log("hello");\n', 'utf8');
    try {
      const server = astGrepOpencodeServer({
        mcpScriptPath: shim,
        astGrepExecutable: astGrep as string,
        workspaceRoot: dir
      });
      const escaped = await probeOpencodeServer(server, {
        cwd: dir,
        timeoutMs: 20_000,
        calls: [{ name: 'search', arguments: { pattern: 'console.log($$$A)', paths: ['..'] } }]
      });
      assert.equal(escaped.calls[0]?.ok, false);
      assert.match(escaped.calls[0]?.error ?? '', /outside the workspace/);

      const write = await probeOpencodeServer(server, {
        cwd: dir,
        timeoutMs: 20_000,
        calls: [
          {
            name: 'replace',
            arguments: {
              pattern: 'console.log($$$A)',
              rewrite: 'console.info($$$A)',
              dryRun: false,
              paths: ['sample.js']
            }
          }
        ]
      });
      assert.equal(write.calls[0]?.ok, false);
      assert.match(write.calls[0]?.error ?? '', /approve: true/);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
);
