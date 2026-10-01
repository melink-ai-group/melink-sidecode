import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isFileTool,
  isTerminalStepReason,
  parseOpencodeEvent,
  reportedChangeOfTool,
  sessionIdOf
} from './events.ts';

// Real captured lines from `opencode run --format json` (opencode 1.1.65).
const STEP_START =
  '{"type":"step_start","timestamp":1790347496436,"sessionID":"ses_f26f93a8fffeAnF7GxtfsLs01v","part":{"id":"prt_0d906cbf2001KFAaIHmDmfsWXE","sessionID":"ses_f26f93a8fffeAnF7GxtfsLs01v","messageID":"msg_0d906c5df001U4knPZrtgjHL0X","type":"step-start"}}';
const TEXT =
  '{"type":"text","timestamp":1790347496523,"sessionID":"ses_f26f93a8fffeAnF7GxtfsLs01v","part":{"id":"prt_0d906cbf30017YZQQF6liOcUTb","sessionID":"ses_f26f93a8fffeAnF7GxtfsLs01v","messageID":"msg_0d906c5df001U4knPZrtgjHL0X","type":"text","text":"Hi","time":{"start":1790347496520,"end":1790347496520}}}';
const STEP_FINISH =
  '{"type":"step_finish","timestamp":1790347496523,"sessionID":"ses_f26f93a8fffeAnF7GxtfsLs01v","part":{"id":"prt_0d906cc4a0018MhRsumCWdxucX","sessionID":"ses_f26f93a8fffeAnF7GxtfsLs01v","messageID":"msg_0d906c5df001U4knPZrtgjHL0X","type":"step-finish","reason":"stop","cost":0,"tokens":{"total":11479,"input":1108,"output":3,"reasoning":0,"cache":{"read":10368,"write":0}}}}';
const TOOL_BASH =
  '{"type":"tool_use","timestamp":1790347502714,"sessionID":"ses_f26f92032ffeztVlY0k6cvWN4J","part":{"id":"prt_1","sessionID":"ses_f26f92032ffeztVlY0k6cvWN4J","messageID":"msg_1","type":"tool","callID":"call_2mlcy2dj","tool":"bash","state":{"status":"completed","input":{"command":"ls","description":"Lists files in current directory"},"output":"a.txt\\n","title":"Lists files in current directory","metadata":{"output":"a.txt\\n","exit":0}}}}';
const TOOL_WRITE =
  '{"type":"tool_use","timestamp":1790347832017,"sessionID":"ses_f26f41b6cffed1xrDyCkRU8hvd","part":{"id":"prt_2","sessionID":"ses_f26f41b6cffed1xrDyCkRU8hvd","messageID":"msg_2","type":"tool","callID":"call_dypehnjx","tool":"write","state":{"status":"completed","input":{"filePath":"C:\\\\work\\\\e.txt","content":"hello"},"output":"Wrote file successfully.","title":"e.txt","metadata":{"filepath":"C:\\\\work\\\\e.txt","exists":false}}}}';
const REASONING =
  '{"type":"reasoning","timestamp":1790347831433,"sessionID":"ses_f26f41b6cffeZMaYSRZBVaerx6","part":{"id":"prt_3","type":"reasoning","text":"17*23 = 391."}}';
const ERROR =
  '{"type":"error","timestamp":1790347584947,"sessionID":"ses_f26f7dce3ffesJTHCyIMLLLiqZ","error":{"name":"APIError","data":{"message":"Unauthorized: bad token","statusCode":401,"isRetryable":false}}}';

test('a step_start line is parsed with its session id', () => {
  const event = parseOpencodeEvent(STEP_START);
  assert.equal(event.kind, 'step-start');
  assert.equal(sessionIdOf(event), 'ses_f26f93a8fffeAnF7GxtfsLs01v');
});

test('a text part is parsed with its part id and text', () => {
  const event = parseOpencodeEvent(TEXT);
  assert.equal(event.kind, 'text');
  if (event.kind === 'text') {
    assert.equal(event.text, 'Hi');
    assert.equal(event.partId, 'prt_0d906cbf30017YZQQF6liOcUTb');
  }
});

test('a reasoning part is parsed distinctly from assistant text', () => {
  const event = parseOpencodeEvent(REASONING);
  assert.equal(event.kind, 'reasoning');
  if (event.kind === 'reasoning') {
    assert.equal(event.text, '17*23 = 391.');
  }
});

test('a terminal step_finish is recognized, a non-terminal one is not', () => {
  const stop = parseOpencodeEvent(STEP_FINISH);
  assert.equal(stop.kind, 'step-finish');
  if (stop.kind === 'step-finish') {
    assert.equal(stop.reason, 'stop');
    assert.equal(stop.usedTokens, 11479);
    assert.equal(isTerminalStepReason(stop.reason), true);
  }
  assert.equal(isTerminalStepReason('tool-calls'), false);
  assert.equal(isTerminalStepReason('unknown'), false);
});

test('a bash tool call carries its command and status', () => {
  const event = parseOpencodeEvent(TOOL_BASH);
  assert.equal(event.kind, 'tool');
  if (event.kind === 'tool') {
    assert.equal(event.tool, 'bash');
    assert.equal(event.status, 'completed');
    assert.equal(event.command, 'ls');
    assert.equal(event.callId, 'call_2mlcy2dj');
  }
  assert.equal(isFileTool('bash'), false);
});

test('a write tool call carries its changed file and is a file tool', () => {
  const event = parseOpencodeEvent(TOOL_WRITE);
  assert.equal(event.kind, 'tool');
  if (event.kind === 'tool') {
    assert.equal(event.tool, 'write');
    assert.equal(event.filePath, 'C:\\work\\e.txt');
  }
  assert.equal(isFileTool('write'), true);
  assert.equal(isFileTool('edit'), true);
  assert.equal(isFileTool('patch'), true);
});

test('an error line carries its message and status code', () => {
  const event = parseOpencodeEvent(ERROR);
  assert.equal(event.kind, 'error');
  if (event.kind === 'error') {
    assert.match(event.message, /Unauthorized/);
    assert.equal(event.statusCode, 401);
  }
});

test('an unknown event type is tolerated as unknown, not a failure', () => {
  const event = parseOpencodeEvent('{"type":"future_thing","sessionID":"ses_x","part":{}}');
  assert.equal(event.kind, 'unknown');
  assert.equal(sessionIdOf(event), 'ses_x');
});

test('a non-JSON line is malformed rather than throwing', () => {
  const event = parseOpencodeEvent('\u001b[93m! permission requested: bash; auto-rejecting');
  assert.equal(event.kind, 'malformed');
  assert.equal(sessionIdOf(event), undefined);
});

test('a blank line is malformed and never an event', () => {
  assert.equal(parseOpencodeEvent('   ').kind, 'malformed');
  assert.equal(parseOpencodeEvent('').kind, 'malformed');
});

test('a tool call with a missing tool name is unknown rather than misread', () => {
  const event = parseOpencodeEvent('{"type":"tool_use","part":{"callID":"c1","state":{}}}');
  assert.equal(event.kind, 'unknown');
});

test('a write tool reports a created file when the tool says it did not exist', () => {
  const event = parseOpencodeEvent(TOOL_WRITE);
  assert.equal(event.kind, 'tool');
  if (event.kind !== 'tool') {
    return;
  }
  assert.equal(event.fileExists, false);
  assert.deepEqual(reportedChangeOfTool(event), { absPath: 'C:\\work\\e.txt', status: 'created' });
});

test('a write tool reports a modification when the file already existed', () => {
  const line =
    '{"type":"tool_use","sessionID":"s","part":{"callID":"c","tool":"write","state":{"status":"completed","input":{"filePath":"/ws/a.ts"},"metadata":{"filepath":"/ws/a.ts","exists":true}}}}';
  const event = parseOpencodeEvent(line);
  assert.equal(event.kind, 'tool');
  if (event.kind !== 'tool') {
    return;
  }
  assert.deepEqual(reportedChangeOfTool(event), { absPath: '/ws/a.ts', status: 'modified' });
});

test('an edit tool carries the old/new pair and a unified diff', () => {
  const line =
    '{"type":"tool_use","sessionID":"s","part":{"callID":"c","tool":"edit","state":{"status":"completed","input":{"filePath":"/ws/b.ts","oldString":"gamma","newString":"GAMMA"},"metadata":{"filepath":"/ws/b.ts","diff":"@@ -3,1 +3,1 @@\\n-gamma\\n+GAMMA\\n"}}}}';
  const event = parseOpencodeEvent(line);
  assert.equal(event.kind, 'tool');
  if (event.kind !== 'tool') {
    return;
  }
  const reported = reportedChangeOfTool(event);
  assert.equal(reported?.status, 'modified');
  assert.equal(reported?.replacement?.before, 'gamma');
  assert.equal(reported?.replacement?.after, 'GAMMA');
  assert.match(reported?.diff ?? '', /\+GAMMA/);
});

test('an edit tool reports a modification and a bash tool reports nothing', () => {
  const edit =
    '{"type":"tool_use","sessionID":"s","part":{"callID":"c","tool":"edit","state":{"status":"completed","metadata":{"filepath":"/ws/b.ts"}}}}';
  const editEvent = parseOpencodeEvent(edit);
  assert.equal(editEvent.kind, 'tool');
  if (editEvent.kind === 'tool') {
    assert.deepEqual(reportedChangeOfTool(editEvent), { absPath: '/ws/b.ts', status: 'modified' });
  }
  const bash = parseOpencodeEvent(TOOL_BASH);
  assert.equal(bash.kind, 'tool');
  if (bash.kind === 'tool') {
    // A shell command's writes are deliberately not inferred; the watcher is
    // what catches those, marked `watched`.
    assert.equal(reportedChangeOfTool(bash), undefined);
  }
});

test('glob, read, and grep expose the pattern, path, or query as the target', () => {
  const glob = parseOpencodeEvent(
    '{"type":"tool_use","sessionID":"s","part":{"callID":"g","tool":"glob","state":{"status":"completed","input":{"pattern":"**/*.ts"},"title":"completed"}}}'
  );
  assert.equal(glob.kind, 'tool');
  if (glob.kind === 'tool') {
    assert.equal(glob.target, '**/*.ts');
    assert.equal(glob.command, undefined);
  }

  const read = parseOpencodeEvent(
    '{"type":"tool_use","sessionID":"s","part":{"callID":"r","tool":"read","state":{"status":"completed","input":{"filePath":"src/webview/App.tsx"}}}}'
  );
  assert.equal(read.kind, 'tool');
  if (read.kind === 'tool') {
    assert.equal(read.target, 'src/webview/App.tsx');
    assert.equal(read.filePath, 'src/webview/App.tsx');
  }

  const grep = parseOpencodeEvent(
    '{"type":"tool_use","sessionID":"s","part":{"callID":"p","tool":"grep","state":{"status":"completed","input":{"pattern":"transcriptRef","path":"src"}}}}'
  );
  assert.equal(grep.kind, 'tool');
  if (grep.kind === 'tool') {
    assert.equal(grep.target, 'transcriptRef');
  }
});

test('a file tool with no reported path yields no change rather than a blank path', () => {
  const line = '{"type":"tool_use","sessionID":"s","part":{"callID":"c","tool":"write","state":{"status":"completed"}}}';
  const event = parseOpencodeEvent(line);
  assert.equal(event.kind, 'tool');
  if (event.kind === 'tool') {
    assert.equal(reportedChangeOfTool(event), undefined);
  }
});
