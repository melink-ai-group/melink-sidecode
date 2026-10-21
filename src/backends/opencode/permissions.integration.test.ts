import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { astGrepMcpScriptPath, astGrepOpencodeServer } from '../../skills/opencodeMcp.ts';

/**
 * Real OpenCode 1.19.x permission proof.
 *
 * OpenCode registers an MCP tool as `<server>_<tool>` and asks for that exact
 * permission key. Unit tests alone cannot catch a key mismatch: a wrong key
 * silently falls through to OpenCode's permissive `*` default. These tests run
 * the bundled CLI against a mock OpenAI-compatible provider, so they observe
 * the tools OpenCode actually exposes and whether a write reaches disk.
 *
 * The provider is local; no model, token, or network is used. They skip when
 * the CLI, ast-grep, or the built shim is unavailable.
 */

const shim = astGrepMcpScriptPath(process.cwd());

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
    const version = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    // The `<server>_<tool>` permission naming was verified on 1.19.x.
    if (result.status === 0 && /^1\.(1[9]|[2-9]\d)\./m.test(version)) {
      return candidate;
    }
  }
  return undefined;
}

function findAstGrep(): string | undefined {
  const explicit = process.env.AST_GREP_BIN;
  if (explicit && existsSync(explicit)) {
    return explicit;
  }
  const lookup =
    process.platform === 'win32'
      ? spawnSync('where.exe', ['ast-grep'], { encoding: 'utf8', timeout: 15_000 })
      : spawnSync('which', ['ast-grep'], { encoding: 'utf8', timeout: 15_000 });
  const lines = (lookup.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && existsSync(line));
  if (process.platform !== 'win32') {
    return lines[0];
  }
  // `where` lists the extensionless shell shim before the `.cmd`; only the
  // `.cmd`/`.exe` can be spawned directly on Windows.
  return lines.find((line) => /\.(cmd|exe)$/i.test(line)) ?? lines[0];
}

const opencode = findOpencode();
const astGrep = findAstGrep();
const available = Boolean(opencode && astGrep && existsSync(shim));

/** The environment OpenCode's own process must not inherit from a SideCode turn. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^OPENCODE_|^XDG_/.test(key))
  );
  return { ...base, ...extra };
}

interface ProviderReply {
  toolCall?: { name: string; arguments: Record<string, unknown> };
  text: string;
}

interface ScenarioResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Tools OpenCode offered to the model on each request. */
  offeredTools: string[][];
  file: string;
}

async function runScenario(options: {
  deny: string;
  file: string;
  mcp: Record<string, unknown>;
  reply: ProviderReply;
  work: string;
  home: string;
}): Promise<ScenarioResult> {
  const offeredTools: string[][] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      let parsed: {
        tools?: { function?: { name?: string }; name?: string }[];
        messages?: { role?: string }[];
      } = {};
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        // A malformed request is answered like an empty one.
      }
      const tools = (parsed.tools ?? [])
        .map((tool) => tool.function?.name ?? tool.name)
        .filter((name): name is string => typeof name === 'string');
      const mainRequest = tools.length > 0;
      if (mainRequest) {
        offeredTools.push(tools);
      }
      const hasToolResult = (parsed.messages ?? []).some((message) => message.role === 'tool');
      const send = (payload: unknown): void => {
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      const base = {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model'
      };
      if (mainRequest && !hasToolResult && options.reply.toolCall) {
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: options.reply.toolCall.name,
                      arguments: JSON.stringify(options.reply.toolCall.arguments)
                    }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: options.reply.text },
              finish_reason: null
            }
          ]
        });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const configPath = join(options.home, 'opencode.json');
  const permission = {
    '*': 'allow',
    // The read-only defaults SideCode emits, plus the skill's search tool.
    edit: 'deny',
    write: 'deny',
    patch: 'deny',
    bash: 'deny',
    external_directory: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
    task: 'deny',
    ast_grep_search: 'allow',
    [options.deny]: 'deny'
  };
  const config = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      mock: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Mock',
        options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test' },
        models: { 'mock-model': { name: 'mock-model', tool_call: true } }
      }
    },
    small_model: 'mock/mock-model',
    permission,
    // A custom agent, like SideCode's per-turn agent: OpenCode evaluates the
    // agent-level permission block, so a key mismatch is not hidden by the
    // global map.
    agent: {
      'melink-agent-test': {
        disable: false,
        description: 'Permission fixture',
        mode: 'primary',
        prompt: 'Use only the actions the permission rules allow.',
        tools: { task: false },
        permission
      }
    },
    mcp: options.mcp
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn(
          opencode as string,
          ['run', '--model', 'mock/mock-model', '--agent', 'melink-agent-test', '--format', 'json', 'use the tool'],
          {
            cwd: options.work,
            env: childEnv({
              OPENCODE_CONFIG: configPath,
              HOME: options.home,
              USERPROFILE: options.home,
              XDG_CONFIG_HOME: join(options.home, 'config'),
              XDG_DATA_HOME: join(options.home, 'data'),
              XDG_CACHE_HOME: join(options.home, 'cache'),
              ...(astGrep ? { AST_GREP_BIN: astGrep } : {})
            }),
            // `opencode run` reads piped stdin; leaving it open hangs the turn.
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
          }
        );
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
        child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
        const timer = setTimeout(() => child.kill(), 60_000);
        child.on('exit', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      }
    );
    return {
      ...result,
      offeredTools,
      file: await readFile(join(options.work, options.file), 'utf8')
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const replacementArgs = {
  pattern: 'console.log($$$A)',
  rewrite: 'console.info($$$A)',
  lang: 'javascript',
  paths: ['sample.js'],
  dryRun: false,
  approve: true
};

async function workspace(): Promise<{ root: string; home: string; work: string }> {
  const root = await mkdtemp(join(tmpdir(), 'melink-opencode-permission-'));
  const home = join(root, 'home');
  const work = join(root, 'work');
  await mkdir(home, { recursive: true });
  await mkdir(work, { recursive: true });
  await writeFile(join(work, 'sample.js'), 'console.log("hello");\n', 'utf8');
  return { root, home, work };
}

test(
  'OpenCode denies ast_grep_replace in read-only and leaves the file unchanged',
  { skip: available ? false : 'opencode 1.19.x, ast-grep or dist/ast-grep-mcp.js is unavailable' },
  async () => {
    const dirs = await workspace();
    try {
      const result = await runScenario({
        ...dirs,
        deny: 'ast_grep_replace',
        file: 'sample.js',
        mcp: {
          ast_grep: astGrepOpencodeServer({
            mcpScriptPath: shim,
            astGrepExecutable: astGrep as string,
            workspaceRoot: dirs.work
          })
        },
        reply: { toolCall: { name: 'ast_grep_replace', arguments: replacementArgs }, text: 'done' }
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.file, 'console.log("hello");\n', 'the denied tool must not write');
      assert.ok(result.offeredTools.length > 0, result.stderr);
      for (const tools of result.offeredTools) {
        assert.equal(tools.includes('ast_grep_replace'), false, tools.join(','));
        // The read-only search tool stays available when the skill is on.
        assert.equal(tools.includes('ast_grep_search'), true, tools.join(','));
      }
      // A model call to the unavailable tool is rejected, not executed.
      assert.match(result.stdout, /unavailable tool 'ast_grep_replace'/);
    } finally {
      await rm(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
);

test(
  'the legacy bare `replace` key does not match and the tool still writes (regression proof)',
  { skip: available ? false : 'opencode 1.19.x, ast-grep or dist/ast-grep-mcp.js is unavailable' },
  async () => {
    const dirs = await workspace();
    try {
      const result = await runScenario({
        ...dirs,
        deny: 'replace',
        file: 'sample.js',
        mcp: {
          ast_grep: astGrepOpencodeServer({
            mcpScriptPath: shim,
            astGrepExecutable: astGrep as string,
            workspaceRoot: dirs.work
          })
        },
        reply: { toolCall: { name: 'ast_grep_replace', arguments: replacementArgs }, text: 'done' }
      });
      assert.equal(result.code, 0, result.stderr);
      assert.ok(result.offeredTools.some((tools) => tools.includes('ast_grep_replace')));
      assert.equal(result.file, 'console.info("hello");\n');
    } finally {
      await rm(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
);

test(
  'OpenCode resolves zvec_grep_zvec_grep_search, not zvec_grep_search',
  { skip: available ? false : 'opencode 1.19.x is unavailable' },
  async () => {
    const dirs = await workspace();
    const fakeServer = join(dirs.root, 'fake-zvec-mcp.mjs');
    await writeFile(
      fakeServer,
      [
        "let buffer = '';",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk.toString("utf8");',
        '  let newline = buffer.indexOf("\\n");',
        '  while (newline >= 0) {',
        '    const line = buffer.slice(0, newline).trim();',
        '    buffer = buffer.slice(newline + 1);',
        '    newline = buffer.indexOf("\\n");',
        '    if (!line) continue;',
        '    let message;',
        '    try { message = JSON.parse(line); } catch { continue; }',
        '    if (message.id === undefined || message.id === null) continue;',
        "    let result = {};",
        "    if (message.method === 'initialize') {",
        "      result = { protocolVersion: message.params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake-zvec', version: '1.0.0' } };",
        "    } else if (message.method === 'tools/list') {",
        "      result = { tools: [{ name: 'zvec_grep_search', description: 'fake', inputSchema: { type: 'object', properties: { root: { type: 'string' } }, required: ['root'] } }] };",
        '    }',
        "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');",
        '  }',
        '});',
        ''
      ].join('\n'),
      'utf8'
    );
    const mcp = {
      zvec_grep: {
        type: 'local',
        command: [process.execPath, fakeServer],
        enabled: true
      }
    };
    try {
      const denied = await runScenario({
        ...dirs,
        deny: 'zvec_grep_zvec_grep_search',
        file: 'sample.js',
        mcp,
        reply: { text: 'done' }
      });
      assert.equal(denied.code, 0, denied.stderr);
      assert.ok(denied.offeredTools.length > 0, denied.stderr);
      for (const tools of denied.offeredTools) {
        assert.equal(tools.includes('zvec_grep_zvec_grep_search'), false, tools.join(','));
        assert.equal(tools.includes('zvec_grep_search'), false, tools.join(','));
      }

      const allowed = await runScenario({
        ...dirs,
        deny: 'zvec_grep_zvec_grep_search_NOT_DENIED',
        file: 'sample.js',
        mcp,
        reply: { text: 'done' }
      });
      assert.equal(allowed.code, 0, allowed.stderr);
      assert.ok(allowed.offeredTools.some((tools) => tools.includes('zvec_grep_zvec_grep_search')));
    } finally {
      await rm(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
);
