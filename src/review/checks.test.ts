import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CHECK_OUTPUT_LIMIT,
  checkOutputExcerpt,
  detectDefaultChecks,
  overallCheckStatus,
  resolveCheckPlan,
  runChecks,
  summarizeChecks,
  type CheckCommand,
  type CheckProcess,
  type CheckResult
} from './checks.ts';

function resolved(
  value: { code: number | null; stdout?: string; stderr?: string; error?: string },
  onKill?: () => void
): CheckProcess {
  return {
    promise: Promise.resolve({
      code: value.code,
      stdout: value.stdout ?? '',
      stderr: value.stderr ?? '',
      ...(value.error !== undefined ? { error: value.error } : {})
    }),
    kill: onKill ?? (() => undefined)
  };
}

function pending(onKill?: () => void): CheckProcess {
  return {
    promise: new Promise(() => undefined),
    kill: onKill ?? (() => undefined)
  };
}

function result(status: CheckResult['status'], name: string = status): CheckResult {
  return { name, command: `run ${name}`, status, durationMs: 1 };
}

test('default checks prefer typecheck over its lint fallback and include test once', () => {
  assert.deepEqual(detectDefaultChecks({ typecheck: 'tsc', test: 'node --test' }), [
    { name: 'typecheck', command: 'npm run typecheck' },
    { name: 'test', command: 'npm run test' }
  ]);
  assert.deepEqual(detectDefaultChecks({ typecheck: 'tsc', lint: 'eslint', test: 'node --test' }), [
    { name: 'typecheck', command: 'npm run typecheck' },
    { name: 'test', command: 'npm run test' }
  ]);
  assert.deepEqual(detectDefaultChecks({ lint: 'eslint', test: 'node --test' }), [
    { name: 'lint', command: 'npm run lint' },
    { name: 'test', command: 'npm run test' }
  ]);
  assert.deepEqual(detectDefaultChecks({ lint: 'eslint' }), [
    { name: 'lint', command: 'npm run lint' }
  ]);
  assert.deepEqual(detectDefaultChecks({}), []);
});

test('default checks use the package manager prefix, including a name@version alias', () => {
  assert.deepEqual(detectDefaultChecks({ test: 'x' }, 'yarn'), [
    { name: 'test', command: 'yarn run test' }
  ]);
  assert.deepEqual(detectDefaultChecks({ test: 'x' }, 'pnpm'), [
    { name: 'test', command: 'pnpm run test' }
  ]);
  assert.deepEqual(detectDefaultChecks({ test: 'x' }, 'bun'), [
    { name: 'test', command: 'bun run test' }
  ]);
  assert.deepEqual(detectDefaultChecks({ test: 'x' }, 'pnpm@9.1.0'), [
    { name: 'test', command: 'pnpm run test' }
  ]);
  assert.deepEqual(detectDefaultChecks({ test: 'x' }, 'npm@10.2.0+abcdef'), [
    { name: 'test', command: 'npm run test' }
  ]);
});

test('an explicit command list is used verbatim and never falls back to detection', () => {
  const scripts = { typecheck: 'tsc', test: 'node --test' };
  const plan = resolveCheckPlan(
    { enabled: true, commands: ['npm run build', 'npm test'], timeoutMs: 1000 },
    { trusted: true, scripts }
  );
  assert.deepEqual(plan, {
    status: 'run',
    commands: [
      { name: 'npm run build', command: 'npm run build' },
      { name: 'npm test', command: 'npm test' }
    ]
  });
});

test('an empty explicit command list turns checks off by configuration', () => {
  const plan = resolveCheckPlan(
    { enabled: true, commands: [], timeoutMs: 1000 },
    { trusted: true, scripts: { test: 'x' } }
  );
  assert.deepEqual(plan, { status: 'off', summary: 'Checks disabled by configuration.' });
});

test('settings and trust gate checks before any command is selected', () => {
  assert.deepEqual(
    resolveCheckPlan(
      { enabled: true, commands: ['npm test'], timeoutMs: 1000 },
      { trusted: false, scripts: { test: 'x' } }
    ),
    { status: 'untrusted', summary: 'Checks skipped: workspace is untrusted.' }
  );
  assert.deepEqual(
    resolveCheckPlan(
      { enabled: false, commands: ['npm test'], timeoutMs: 1000 },
      { trusted: true, scripts: { test: 'x' } }
    ),
    { status: 'off', summary: 'Checks are disabled.' }
  );
});

test('without explicit commands the plan detects scripts and reports none readably', () => {
  assert.deepEqual(
    resolveCheckPlan(
      { enabled: true, timeoutMs: 1000 },
      { trusted: true, scripts: { lint: 'eslint', test: 'node --test' }, packageManager: 'yarn@4.0.0' }
    ),
    {
      status: 'run',
      commands: [
        { name: 'lint', command: 'yarn run lint' },
        { name: 'test', command: 'yarn run test' }
      ]
    }
  );
  const none = resolveCheckPlan(
    { enabled: true, timeoutMs: 1000 },
    { trusted: true, scripts: { build: 'esbuild' } }
  );
  assert.equal(none.status, 'no-scripts');
  assert.match(none.status === 'no-scripts' ? none.summary : '', /no typecheck, lint, or test script/i);
});

test('checks pass, fail, time out, or error without throwing', async () => {
  const commands: CheckCommand[] = [
    { name: 'pass', command: 'pass' },
    { name: 'fail', command: 'fail' },
    { name: 'error', command: 'error' },
    { name: 'throw', command: 'throw' }
  ];
  const results = await runChecks(
    commands,
    (command) => {
      if (command === 'throw') {
        throw new Error('spawn refused');
      }
      if (command === 'error') {
        return resolved({ code: null, error: 'binary missing' });
      }
      return resolved({ code: command === 'pass' ? 0 : 2, stdout: `${command} out` });
    },
    { cwd: 'C:/repo', timeoutMs: 1000 }
  );

  assert.deepEqual(
    results.map((entry) => entry.status),
    ['passed', 'failed', 'error', 'error']
  );
  assert.equal(results[2]?.reason, 'binary missing');
  assert.equal(results[3]?.reason, 'spawn refused');
  assert.equal(results[0]?.output, 'pass out');
  assert.ok(results.every((entry) => entry.durationMs >= 0));
});

test('a timeout kills the child and marks that check timed out', async () => {
  let killed = false;
  const results = await runChecks(
    [{ name: 'slow', command: 'slow' }],
    () => pending(() => {
      killed = true;
    }),
    { cwd: 'C:/repo', timeoutMs: 5 }
  );

  assert.equal(killed, true);
  assert.equal(results[0]?.status, 'timed-out');
  assert.match(results[0]?.reason ?? '', /timed out after 5ms/i);
});

test('an aborted signal skips every remaining check before spawning', async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = 0;
  const commands: CheckCommand[] = [
    { name: 'one', command: 'one' },
    { name: 'two', command: 'two' }
  ];
  const results = await runChecks(commands, () => {
    spawned += 1;
    return resolved({ code: 0 });
  }, { cwd: 'C:/repo', timeoutMs: 1000, signal: controller.signal });

  assert.equal(spawned, 0);
  assert.deepEqual(
    results.map((entry) => entry.status),
    ['skipped', 'skipped']
  );
  assert.ok(results.every((entry) => entry.reason === 'Superseded by a newer turn'));
});

test('an abort during a check kills it, skips it and the checks after it', async () => {
  const controller = new AbortController();
  let killed = false;
  let spawned = 0;
  const commands: CheckCommand[] = [
    { name: 'one', command: 'one' },
    { name: 'two', command: 'two' }
  ];

  const run = runChecks(commands, (command) => {
    spawned += 1;
    if (command === 'one') {
      setTimeout(() => controller.abort(), 5);
      return pending(() => {
        killed = true;
      });
    }
    return resolved({ code: 0 });
  }, { cwd: 'C:/repo', timeoutMs: 1000, signal: controller.signal });

  const results = await run;
  assert.equal(killed, true);
  assert.equal(spawned, 1);
  assert.deepEqual(
    results.map((entry) => entry.status),
    ['skipped', 'skipped']
  );
  assert.ok(results.every((entry) => entry.reason === 'Superseded by a newer turn'));
});

test('checks run sequentially in command order with the workspace cwd', async () => {
  const events: string[] = [];
  const seenCwd: string[] = [];
  const commands: CheckCommand[] = [
    { name: 'first', command: 'first' },
    { name: 'second', command: 'second' }
  ];

  await runChecks(commands, (command, options) => {
    events.push(`spawn:${command}`);
    seenCwd.push(options.cwd);
    if (command === 'first') {
      return {
        kill: () => undefined,
        promise: new Promise((resolve) => {
          setTimeout(() => {
            events.push('resolve:first');
            resolve({ code: 0, stdout: '', stderr: '' });
          }, 5);
        })
      };
    }
    return resolved({ code: 0 });
  }, { cwd: 'C:/workspace', timeoutMs: 1000 });

  assert.deepEqual(seenCwd, ['C:/workspace', 'C:/workspace']);
  assert.deepEqual(events, ['spawn:first', 'resolve:first', 'spawn:second']);
});

test('stdout and stderr are captured together and the stored output stays bounded', async () => {
  const huge = 'x'.repeat(CHECK_OUTPUT_LIMIT * 3);
  const results = await runChecks(
    [
      { name: 'both', command: 'both' },
      { name: 'big', command: 'big' }
    ],
    (command) => (
      command === 'both'
        ? resolved({ code: 1, stdout: 'out', stderr: 'err' })
        : resolved({ code: 0, stdout: huge })
    ),
    { cwd: 'C:/repo', timeoutMs: 1000 }
  );

  assert.equal(results[0]?.output, 'out\nerr');
  assert.ok((results[1]?.output?.length ?? 0) <= CHECK_OUTPUT_LIMIT);
  assert.ok(results[1]?.output?.startsWith('…'));
  assert.ok(results[1]?.output?.endsWith('xxx'));
});

test('checkOutputExcerpt keeps the tail and counts the marker inside the limit', () => {
  const text = `${'a'.repeat(50)}TAIL`;
  const excerpt = checkOutputExcerpt(text, 10);
  assert.equal(excerpt.length, 10);
  assert.equal(excerpt, '…aaaaaTAIL');
  assert.ok(excerpt.endsWith('TAIL'));

  assert.equal(checkOutputExcerpt('short', 10), 'short');
  assert.equal(checkOutputExcerpt('abcdef', 1), '…');
  assert.equal(checkOutputExcerpt('abcdef', 0), '');
  assert.equal(checkOutputExcerpt('abcdef'), 'abcdef');
});

test('summaries count each outcome and pick the worst overall status', () => {
  const failed = summarizeChecks(
    [result('passed', 'a'), result('passed', 'b'), result('failed', 'c')],
    100,
    200
  );
  assert.equal(failed.status, 'failed');
  assert.equal(failed.summary, 'Checks: 2 passed · 1 failed');
  assert.equal(failed.startedAt, 100);
  assert.equal(failed.finishedAt, 200);

  assert.equal(
    summarizeChecks([result('timed-out'), result('error')], 1).summary,
    'Checks: 1 timed out · 1 errored'
  );
  assert.equal(overallCheckStatus([result('timed-out')]), 'failed');
  assert.equal(overallCheckStatus([result('error')]), 'failed');
  assert.equal(overallCheckStatus([result('passed'), result('skipped')]), 'passed');
  assert.equal(overallCheckStatus([]), 'skipped');
});

test('a skipped-only run is skipped and an empty run has a readable summary', () => {
  const skipped = summarizeChecks([result('skipped', 'a'), result('skipped', 'b')], 10);
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.summary, 'Checks: 2 skipped');
  assert.equal(skipped.finishedAt, undefined);

  const empty = summarizeChecks([], 10);
  assert.equal(empty.status, 'skipped');
  assert.equal(empty.summary, 'Checks: no checks');
});

test('summarizeChecks copies results so the caller cannot mutate the view', () => {
  const original = [result('passed', 'a')];
  const view = summarizeChecks(original, 1);
  view.results[0]!.status = 'failed';
  assert.equal(original[0]?.status, 'passed');
  assert.notEqual(view.results, original);
});

test('the checks core is host-free and has no logging side channel', async () => {
  const text = await readFile(join(process.cwd(), 'src', 'review', 'checks.ts'), 'utf8');
  assert.equal(/\bfrom\s+['"]vscode["']/.test(text), false);
  assert.equal(/\bfrom\s+['"](node:)?(fs|child_process|net|http|https)["']/.test(text), false);
  assert.equal(/\brequire\s*\(/.test(text), false);
  assert.equal(/\bconsole\./.test(text), false);
});
