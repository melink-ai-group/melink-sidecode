import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BROWSER_MCP_SERVER,
  BROWSER_TOOL_NAMES,
  browserPermissionKeys,
  opencodeBrowserServer
} from './config.ts';

/**
 * Real OpenCode 1.19.x proof for the browser MCP shim.
 *
 * Two defects cannot be caught by unit tests alone: OpenCode speaks line-framed
 * JSON-RPC (a header-only shim answers nothing, so no tools are offered), and
 * it resolves an MCP tool to `<server>_<tool>` (a bare `browser_navigate` or
 * `melink_browser` key never matches). These tests run the bundled CLI against
 * a mock OpenAI-compatible provider, so they observe the tools OpenCode really
 * offers and the call that really reaches the bridge.
 *
 * The provider and browser bridge are local; no model, token, or network is
 * used. They skip when the CLI is unavailable.
 */

const shim = join(process.cwd(), 'src', 'browser', 'mcp.ts');

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
    if (result.status === 0 && /^1\.(1[9]|[2-9]\d)\./m.test(version)) {
      return candidate;
    }
  }
  return undefined;
}

const opencode = findOpencode();
const available = Boolean(opencode && existsSync(shim));

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
  offeredTools: string[][];
  bridgeCalls: { name?: unknown; arguments?: unknown; provider?: unknown }[];
}

interface BridgeFixture {
  url: string;
  token: string;
  calls: { name?: unknown; arguments?: unknown; provider?: unknown }[];
  close: () => Promise<void>;
}

async function startBridge(): Promise<BridgeFixture> {
  const calls: BridgeFixture['calls'] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      try {
        calls.push(JSON.parse(body) as BridgeFixture['calls'][number]);
      } catch {
        calls.push({});
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ content: [{ type: 'text', text: 'browser bridge answered' }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/call`,
    token: 'browser-integration-token',
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

async function runScenario(options: {
  permission: Record<string, string>;
  reply: ProviderReply;
  work: string;
  home: string;
  endpointFile: string;
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
            { index: 0, delta: { role: 'assistant', content: options.reply.text }, finish_reason: null }
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
    permission: options.permission,
    // A custom agent, like sideCode's per-turn agent: OpenCode evaluates the
    // agent-level permission block, so a key mismatch is not hidden by the
    // global map.
    agent: {
      'melink-agent-test': {
        disable: false,
        description: 'Browser permission fixture',
        mode: 'primary',
        prompt: 'Use only the actions the permission rules allow.',
        tools: { task: false },
        permission: options.permission
      }
    },
    mcp: {
      [BROWSER_MCP_SERVER]: opencodeBrowserServer({
        command: process.execPath,
        args: ['--experimental-strip-types', shim, '--endpoint-file', options.endpointFile, '--provider', 'opencode'],
        env: {}
      })
    }
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
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
            XDG_CACHE_HOME: join(options.home, 'cache')
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
    });
    return { ...result, offeredTools, bridgeCalls: [] };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function workspace(): Promise<{ root: string; home: string; work: string }> {
  const root = await mkdtemp(join(tmpdir(), 'melink-browser-opencode-'));
  const home = join(root, 'home');
  const work = join(root, 'work');
  await mkdir(home, { recursive: true });
  await mkdir(work, { recursive: true });
  return { root, home, work };
}

const resolved = (name: string): string => `${BROWSER_MCP_SERVER}_${name}`;

const basePermission = {
  edit: 'deny',
  write: 'deny',
  patch: 'deny',
  bash: 'deny',
  external_directory: 'deny',
  webfetch: 'deny',
  websearch: 'deny',
  task: 'deny'
};

test(
  'OpenCode offers the browser tools and a navigate call reaches the bridge (line framing)',
  { skip: available ? false : 'opencode 1.19.x or src/browser/mcp.ts is unavailable' },
  async () => {
    const dirs = await workspace();
    const bridge = await startBridge();
    const endpointFile = join(dirs.root, 'browser-endpoint-a.json');
    await writeFile(endpointFile, JSON.stringify({ url: bridge.url, token: bridge.token }), 'utf8');
    try {
      const result = await runScenario({
        ...dirs,
        endpointFile,
        permission: { '*': 'allow', ...basePermission, ...browserPermissionKeys() },
        reply: {
          toolCall: { name: resolved('browser_navigate'), arguments: { url: 'http://localhost:3000/' } },
          text: 'done'
        }
      });
      assert.equal(result.code, 0, result.stderr);
      assert.ok(result.offeredTools.length > 0, result.stderr);
      for (const offered of result.offeredTools) {
        for (const name of BROWSER_TOOL_NAMES) {
          assert.ok(offered.includes(resolved(name)), `${resolved(name)} in ${offered.join(',')}`);
        }
      }
      assert.equal(result.stdout.includes("unavailable tool"), false, result.stdout);
      assert.deepEqual(
        bridge.calls.map((call) => ({ name: call.name, arguments: call.arguments, provider: call.provider })),
        [{ name: 'browser_navigate', arguments: { url: 'http://localhost:3000/' }, provider: 'opencode' }]
      );
    } finally {
      await bridge.close();
      await rm(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
);

test(
  'OpenCode resolves the resolved permission keys, not bare ones',
  { skip: available ? false : 'opencode 1.19.x or src/browser/mcp.ts is unavailable' },
  async () => {
    const dirs = await workspace();
    try {
      // Allow direction: deny everything by wildcard, then allow exactly the
      // resolved keys. A bare key would leave every browser tool hidden.
      const allowed = await runScenario({
        ...dirs,
        endpointFile: join(dirs.root, 'endpoint-allowed.json'),
        permission: { '*': 'deny', ...basePermission, ...browserPermissionKeys() },
        reply: { text: 'done' }
      });
      assert.equal(allowed.code, 0, allowed.stderr);
      assert.ok(allowed.offeredTools.length > 0, allowed.stderr);
      for (const offered of allowed.offeredTools) {
        for (const name of BROWSER_TOOL_NAMES) {
          assert.ok(offered.includes(resolved(name)), `allowed ${resolved(name)} in ${offered.join(',')}`);
        }
      }

      // Deny direction: the resolved navigate key hides only that tool, while
      // a bare `browser_click` rule has no effect on `melink_browser_browser_click`.
      const denied = await runScenario({
        ...dirs,
        endpointFile: join(dirs.root, 'endpoint-denied.json'),
        permission: {
          '*': 'allow',
          ...basePermission,
          ...browserPermissionKeys(),
          [resolved('browser_navigate')]: 'deny',
          browser_click: 'deny'
        },
        reply: { text: 'done' }
      });
      assert.equal(denied.code, 0, denied.stderr);
      assert.ok(denied.offeredTools.length > 0, denied.stderr);
      for (const offered of denied.offeredTools) {
        assert.equal(offered.includes(resolved('browser_navigate')), false, offered.join(','));
        assert.ok(offered.includes(resolved('browser_click')), `bare browser_click rule leaked: ${offered.join(',')}`);
        assert.ok(offered.includes(resolved('browser_snapshot')), offered.join(','));
      }
    } finally {
      await rm(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
);
