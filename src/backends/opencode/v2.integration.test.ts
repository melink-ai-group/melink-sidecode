import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOpencodeConfig } from './config.ts';
import { runOpencodeTurn, type OpencodeRunOptions } from './runtime.ts';
import type { OpencodeEvent } from './events.ts';

// Explicit opt-in; never download a binary or call an external model from tests.
for (const major of [1, 2] as const) {
const executable = process.env[major === 2 ? 'OPENCODE_V2_BIN' : 'OPENCODE_V1_BIN'];
test(`real v${major} server completes, resumes, and asks for shell approval`, { skip: !executable, timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sidecode-v2-'));
  const previous = { ...process.env };
  const work = join(root, 'work');
  await mkdir(work);
  for (const key of Object.keys(process.env)) if (key.startsWith('OPENCODE_')) delete process.env[key];
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) process.env[key] = join(root, key);
  let requests = 0;
  let toolReply = false;
  let toolSent = false;
  let asked = 0;
  let questionReply = false;
  let todoReply = false;
  let answered = 0;
  let questionPrompt = '';
  const offered = new Set<string>();
  const provider = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture' };
      const parsed = JSON.parse(body);
      const tools = parsed.tools ?? [];
      for (const tool of tools) offered.add(tool.function?.name ?? tool.name);
      const toolName = todoReply ? 'todowrite' : questionReply ? 'question' : major === 2 ? 'shell' : 'bash';
      const useTool = toolReply && !toolSent && tools.some((tool: { function?: { name: string } }) => tool.function?.name === toolName);
      if (useTool) toolSent = true;
      const delta = useTool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-call', type: 'function',
        function: { name: toolName, arguments: JSON.stringify(todoReply ? { todos: [{ content: 'Run checks and build', status: 'completed', priority: 'high' }] } : questionReply ? { questions: [{ header: 'Choice', question: 'Which approach?', options: [{ label: 'Keep', description: 'Keep it' }], multiple: false }] }
          : { command: 'echo fixture-shell', description: 'Test shell approval' }) } }] }
        : { role: 'assistant', content: 'fixture response' };
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: useTool ? 'tool_calls' : 'stop' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  assert.ok(address && typeof address === 'object');
  let rejectShell = false;
  const mcpScript = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
    const message=JSON.parse(line); if(message.id===undefined)return;
    const result=message.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1.0.0'}}:
      message.method==='tools/list'?{tools:[{name:'echo',description:'Compatibility fixture',inputSchema:{type:'object',properties:{}}}]}:{};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
  });`;
  const run = async (sessionId?: string, overrides: Partial<OpencodeRunOptions> = {}, expected = 'completed') => {
    const built = buildOpencodeConfig({ baseUrl: `http://127.0.0.1:${address.port}`, modelIds: ['fixture'], modelId: 'fixture', permissionLevel: 'default', mode: 'agent',
      ...(major === 2 ? { skillMcp: { fixture: { type: 'local', command: [process.execPath, '-e', mcpScript], enabled: true } } } : {}) });
    const events: OpencodeEvent[] = [];
    const result = await runOpencodeTurn({ executable: executable!, cwd: work, ...built,
      token: 'fixture-key', prompt: 'Reply briefly.', sessionId, signal: AbortSignal.timeout(35_000),
      decidePermission: async (ask) => { if (ask.permission === 'bash') asked++; else assert.equal(ask.permission, 'question', 'Todo bookkeeping must not need a tool approval'); assert.ok(ask.patterns.length); return rejectShell ? 'reject' : 'once'; },
      questionPermission: 'ask',
      answerQuestion: async (ask) => { answered++; questionPrompt = ask.questions[0]?.prompt ?? ''; return [['Keep']]; },
      ...overrides }, (event) => events.push(event));
    assert.equal(result.outcome, expected, JSON.stringify(result));
    if (expected !== 'completed') return result.sessionId;
    assert.ok(events.some((event) => event.kind === 'text' && event.text.includes('fixture response')), JSON.stringify(events));
    assert.match(result.sessionId!, major === 2 ? /^v2:/ : /^ses/);
    if (todoReply) {
      assert.ok(events.some((event) => event.kind === 'tool' && event.status === 'completed' && event.todos?.[0]?.status === 'completed'), JSON.stringify(events));
      if (major === 2) assert.equal(events.filter((event) => event.kind === 'tool' && event.todos).length, 2,
        'The final persisted todo snapshot must reach the host before turn completion');
    } else if (toolReply && !questionReply) {
      assert.equal(asked, 1, JSON.stringify({ offered: [...offered], events }));
      assert.ok(events.some((event) => event.kind === 'tool' && event.status === (rejectShell ? 'error' : 'completed') &&
        (rejectShell || event.output?.includes('fixture-shell'))), JSON.stringify(events));
    }
    return result.sessionId;
  };
  try {
    const id = await run();
    assert.equal(await run(id), id);
    const beforeMigration = requests;
    await run(major === 2 ? 'ses_old_v1' : 'v2:ses_old_v2', {}, 'stale-session');
    assert.equal(requests, beforeMigration, 'switching majors must recover before sending another prompt');
    toolReply = true;
    await run();
    todoReply = true;
    toolSent = false;
    await run();
    todoReply = false;
    if (major === 2) {
      questionReply = true;
      toolSent = false;
      await run();
      assert.equal(answered, 1);
      assert.equal(questionPrompt, 'Which approach?');
      questionReply = false;
      toolSent = false;
      asked = 0;
      rejectShell = true;
      await run(undefined, {}, 'permission');
      assert.equal(asked, 1);
      toolSent = false;
      const cancel = new AbortController();
      await run(undefined, { signal: cancel.signal, decidePermission: async () => { cancel.abort(); return 'reject'; } }, 'canceled');
    }
    assert.ok(requests >= 2);
    if (major === 2) {
      assert.ok(!offered.has('execute'), 'Code Mode must not bypass sidebar permission checks');
      assert.ok(offered.has('fixture_echo'), JSON.stringify([...offered]));
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
}
