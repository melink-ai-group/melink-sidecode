import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MODE_PROMPT_VERSION } from '../backends/modes.ts';
import {
  FAILURE_LOG_ISSUE_CLASSES,
  FAILURE_LOG_SUMMARY_MAX,
  recordFailureEntry,
  type FailureLogDraft,
  type FailureLogSink
} from './failureLog.ts';
import { createFailureLogHost, failureLogFilePath } from './failureLogHost.ts';

const validDraft: FailureLogDraft = {
  issueClass: 'missed-fe-detail',
  modelId: 'qwen3-coder',
  providerId: 'ollama',
  summary: 'The reply omitted the empty state.'
};

function sinkWith(overrides: Partial<FailureLogSink> = {}): {
  sink: FailureLogSink;
  appends: string[];
  nowCalls: () => number;
} {
  const appends: string[] = [];
  let nowCalls = 0;
  const sink: FailureLogSink = {
    enabled: () => true,
    now: () => {
      nowCalls += 1;
      return '2026-10-21T12:00:00.000Z';
    },
    append: async (line) => {
      appends.push(line);
    },
    ...overrides
  };
  return { sink, appends, nowCalls: () => nowCalls };
}

test('disabled writes nothing, reads no clock, and reports disabled', async () => {
  const { sink, appends, nowCalls } = sinkWith({ enabled: () => false });
  const result = await recordFailureEntry(sink, validDraft);
  assert.deepEqual(result, { ok: false, reason: 'disabled' });
  assert.equal(appends.length, 0);
  assert.equal(nowCalls(), 0);
});

test('enabled writes exactly one compact JSONL entry with only the fixed fields', async () => {
  const { sink, appends } = sinkWith();
  const result = await recordFailureEntry(sink, validDraft);
  assert.equal(result.ok, true);
  assert.equal(appends.length, 1);

  const written = appends[0];
  assert.ok(written.endsWith('\n'));
  assert.equal(written.indexOf('\n'), written.length - 1);
  const parsed = JSON.parse(written) as Record<string, unknown>;
  assert.deepEqual(parsed, {
    timestamp: '2026-10-21T12:00:00.000Z',
    issueClass: 'missed-fe-detail',
    modelId: 'qwen3-coder',
    providerId: 'ollama',
    promptVersion: MODE_PROMPT_VERSION,
    summary: 'The reply omitted the empty state.'
  });
  assert.deepEqual(Object.keys(parsed).sort(), [
    'issueClass',
    'modelId',
    'promptVersion',
    'providerId',
    'summary',
    'timestamp'
  ]);
  if (result.ok) {
    assert.deepEqual(parsed, result.entry);
    assert.equal(JSON.stringify(result.entry), written.trim());
  }
});

test('the documented taxonomy is the only accepted set of issue classes', async () => {
  assert.deepEqual(FAILURE_LOG_ISSUE_CLASSES, [
    'missed-fe-detail',
    'missed-requirement',
    'wrong-command',
    'bad-decision',
    'tool-misuse',
    'other'
  ]);
  const { sink, appends } = sinkWith();
  const result = await recordFailureEntry(sink, { ...validDraft, issueClass: 'invented-class' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'invalid');
    assert.match(result.message ?? '', /missed-fe-detail/);
  }
  assert.equal(appends.length, 0);
});

test('an empty or control-only summary is rejected and nothing is appended', async () => {
  const { sink, appends } = sinkWith();
  for (const summary of ['', '   ', '\n\t\r']) {
    const result = await recordFailureEntry(sink, { ...validDraft, summary });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'invalid');
    }
  }
  assert.equal(appends.length, 0);
});

test('empty model, provider, or prompt version is rejected', async () => {
  const { sink, appends } = sinkWith();
  for (const draft of [
    { ...validDraft, modelId: '  ' },
    { ...validDraft, providerId: '' },
    { ...validDraft, promptVersion: '' }
  ]) {
    const result = await recordFailureEntry(sink, draft);
    assert.equal(result.ok, false);
  }
  assert.equal(appends.length, 0);
});

test('extra content, prompt, stderr, code and secret fields never reach the entry', async () => {
  const { sink, appends } = sinkWith();
  const draft = {
    ...validDraft,
    content: 'CONTENT-MUST-NOT-APPEAR',
    prompt: 'PROMPT-MUST-NOT-APPEAR',
    stderr: 'STDERR-MUST-NOT-APPEAR',
    code: 'CODE-MUST-NOT-APPEAR',
    secret: 'SECRET-MUST-NOT-APPEAR'
  } as unknown as FailureLogDraft;
  const result = await recordFailureEntry(sink, draft);
  assert.equal(result.ok, true);
  const written = appends.join('');
  for (const marker of ['CONTENT-', 'PROMPT-', 'STDERR-', 'CODE-', 'SECRET-']) {
    assert.equal(written.includes(marker), false);
  }
  if (result.ok) {
    assert.deepEqual(Object.keys(result.entry).sort(), [
      'issueClass',
      'modelId',
      'promptVersion',
      'providerId',
      'summary',
      'timestamp'
    ]);
  }
});

test('secret-like summary values are redacted', async () => {
  const { sink, appends } = sinkWith();
  const summary =
    'saw sk-abcdefghijklmnop and ghp_abcdefghijklmnop plus Bearer abc.def-123 then token=abc123 password=hunter2 AKIAIOSFODNN7EXAMPLE';
  const result = await recordFailureEntry(sink, { ...validDraft, summary });
  assert.equal(result.ok, true);
  const written = appends.join('');
  for (const raw of [
    'sk-abcdefghijklmnop',
    'ghp_abcdefghijklmnop',
    'abc.def-123',
    'abc123',
    'hunter2',
    'AKIAIOSFODNN7EXAMPLE'
  ]) {
    assert.equal(written.includes(raw), false, `${raw} was not redacted`);
  }
  assert.equal((written.match(/<redacted>/g) ?? []).length, 6);
});

test('newlines and control characters become spaces, and the summary is capped', async () => {
  const { sink } = sinkWith();
  const multiline = await recordFailureEntry(sink, {
    ...validDraft,
    summary: 'first line\nsecond\tline\r\nthird'
  });
  assert.equal(multiline.ok, true);
  if (multiline.ok) {
    assert.equal(multiline.entry.summary, 'first line second line third');
  }

  const long = await recordFailureEntry(sink, { ...validDraft, summary: 'a'.repeat(500) });
  assert.equal(long.ok, true);
  if (long.ok) {
    assert.equal(long.entry.summary.length, FAILURE_LOG_SUMMARY_MAX);
  }
});

test('model, provider, and prompt version fields are capped', async () => {
  const { sink } = sinkWith();
  const result = await recordFailureEntry(sink, {
    ...validDraft,
    modelId: 'm'.repeat(500),
    providerId: 'p'.repeat(500),
    promptVersion: 'v'.repeat(500)
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.entry.modelId.length <= 120);
    assert.ok(result.entry.providerId.length <= 64);
    assert.ok(result.entry.promptVersion.length <= 64);
  }
});

test('the prompt version constant is used by default and can be overridden explicitly', async () => {
  assert.equal(MODE_PROMPT_VERSION, '2026-10-21');
  const { sink } = sinkWith();
  const fallback = await recordFailureEntry(sink, { ...validDraft, promptVersion: undefined });
  assert.equal(fallback.ok, true);
  if (fallback.ok) {
    assert.equal(fallback.entry.promptVersion, MODE_PROMPT_VERSION);
  }
  const explicit = await recordFailureEntry(sink, { ...validDraft, promptVersion: 'prompt-42' });
  assert.equal(explicit.ok, true);
  if (explicit.ok) {
    assert.equal(explicit.entry.promptVersion, 'prompt-42');
  }
});

test('the extension gate reads only the application-scoped user value', async () => {
  const source = await readFile(join(process.cwd(), 'src', 'extension.ts'), 'utf8');
  assert.match(source, /\.inspect<boolean>\(\s*'telemetry\.failureLog'\s*\)/);
  assert.match(source, /globalValue === true/);
  // A workspace value must never opt the log in, and a generic merged read
  // would silently allow one.
  assert.equal(source.includes('workspaceValue'), false);
  assert.equal(/get<boolean>\(\s*'telemetry\.failureLog'/.test(source), false);
});

test('the view reports unknown identity when no chat is open', async () => {
  const source = await readFile(join(process.cwd(), 'src', 'sidebarView.ts'), 'utf8');
  assert.match(source, /providerId \?\? 'unknown'/);
  assert.match(source, /modelId \?\? 'unknown'/);
});

test('identity fields are redacted as well as the summary', async () => {
  const { sink } = sinkWith();
  const result = await recordFailureEntry(sink, {
    ...validDraft,
    modelId: 'sk-abcdefghijklmnop',
    providerId: 'token=abc123',
    promptVersion: 'AKIAIOSFODNN7EXAMPLE'
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.entry.modelId, '<redacted>');
    assert.equal(result.entry.providerId, '<redacted>');
    assert.equal(result.entry.promptVersion, '<redacted>');
  }
});

test('identity redaction runs before the field cap', async () => {
  const { sink } = sinkWith();
  // The secret starts before the 64-char cap but ends after it, so a
  // cap-then-redact order would leave a truncated credential behind.
  const prefix = `${'p'.repeat(49)} `;
  const result = await recordFailureEntry(sink, {
    ...validDraft,
    providerId: `${prefix}sk-abcdefghijklmnop`
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.entry.providerId, `${prefix}<redacted>`);
    assert.equal(result.entry.providerId.includes('sk-'), false);
  }
});

test('the host path is extension global storage and the off state touches no file', async () => {
  const globalStorage = join('C:', 'storage', 'melink.melink-sidecode');
  const expectedPath = join(globalStorage, 'failure-log.jsonl');
  assert.equal(failureLogFilePath(globalStorage), expectedPath);

  const mkdirs: string[] = [];
  const writes: string[] = [];
  const ops = {
    mkdir: async (path: string, _options: { recursive: true }) => {
      mkdirs.push(path);
    },
    appendFile: async (path: string, data: string, _encoding: 'utf8') => {
      writes.push(`${path}\n${data}`);
    }
  };

  const off = createFailureLogHost(
    { enabled: () => false, globalStoragePath: globalStorage, now: () => '2026-10-21T00:00:00.000Z' },
    ops
  );
  assert.equal(off.path, expectedPath);
  const disabled = await recordFailureEntry(off.sink, validDraft);
  assert.deepEqual(disabled, { ok: false, reason: 'disabled' });
  assert.equal(mkdirs.length, 0);
  assert.equal(writes.length, 0);

  const on = createFailureLogHost(
    { enabled: () => true, globalStoragePath: globalStorage, now: () => '2026-10-21T00:00:00.000Z' },
    ops
  );
  await recordFailureEntry(on.sink, validDraft);
  await recordFailureEntry(on.sink, { ...validDraft, issueClass: 'other' });
  assert.deepEqual(mkdirs, [dirname(expectedPath)]);
  assert.equal(writes.length, 2);
  assert.equal(writes[0]?.startsWith(`${expectedPath}\n{`), true);
  assert.equal(writes[1]?.startsWith(`${expectedPath}\n{`), true);
});
