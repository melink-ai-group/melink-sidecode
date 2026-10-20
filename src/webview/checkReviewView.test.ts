import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_EXCERPT_LIMIT,
  boundedExcerpt,
  checkRows,
  checkSummary,
  formatDuration,
  keepGate
} from './checkReviewView.ts';
import type { CheckResult, CheckRunView } from '../review/checks.ts';

function result(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    name: 'typecheck',
    command: 'npm run typecheck',
    status: 'passed',
    durationMs: 1200,
    ...overrides
  };
}

function view(status: CheckRunView['status'], results: CheckResult[] = []): CheckRunView {
  return { status, summary: `Checks: ${status}`, results, startedAt: 1 };
}

test('the header summary is one line with a clear overall state', () => {
  assert.equal(checkSummary(undefined), undefined);
  assert.equal(checkSummary(view('running')), 'Checks running…');
  assert.equal(checkSummary(view('passed', [result(), result({ name: 'test' })])), 'Checks: 2 passed');
  assert.equal(
    checkSummary(view('failed', [result(), result({ name: 'test', status: 'failed' })])),
    'Checks: 1 failed · 1 passed'
  );
  assert.equal(
    checkSummary({
      status: 'skipped',
      summary: 'Checks skipped: package.json has no typecheck, lint, or test script.',
      results: [],
      startedAt: 1
    }),
    'Checks skipped: package.json has no typecheck, lint, or test script.'
  );
  assert.equal(
    checkSummary({
      status: 'untrusted',
      summary: 'Checks skipped: workspace is untrusted.',
      results: [],
      startedAt: 1
    }),
    'Checks skipped: workspace is untrusted.'
  );
  assert.equal(
    checkSummary({ status: 'skipped', summary: 'Checks are disabled.', results: [], startedAt: 1 }),
    'Checks are disabled.'
  );
});

test('a terminal run without a host summary falls back to the fixed wording', () => {
  assert.equal(checkSummary({ status: 'skipped', summary: '', results: [], startedAt: 1 }), 'Checks skipped');
  assert.equal(
    checkSummary({ status: 'untrusted', summary: '', results: [], startedAt: 1 }),
    'Checks skipped (untrusted workspace)'
  );
});

test('a timed-out or errored check counts as a failure in the header', () => {
  assert.equal(
    checkSummary(view('failed', [result({ status: 'timed-out' }), result({ status: 'error' })])),
    'Checks: 2 failed'
  );
  assert.equal(checkSummary(view('failed', [])), 'Checks failed');
});

test('rows carry a status word, duration, failure excerpt, and skipped reason', () => {
  const rows = checkRows(
    view('failed', [
      result({ status: 'passed', durationMs: 12 }),
      result({
        name: 'test',
        status: 'failed',
        durationMs: 2400,
        output: 'AssertionError: expected 1 to equal 2'
      }),
      result({ name: 'lint', status: 'skipped', durationMs: 0, reason: 'Superseded by a newer turn' })
    ])
  );

  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.statusLabel),
    ['Passed', 'Failed', 'Skipped']
  );
  assert.deepEqual(
    rows.map((row) => row.durationLabel),
    ['12 ms', '2.4 s', '0 ms']
  );
  assert.equal(rows[0]?.failed, false);
  assert.equal(rows[1]?.failed, true);
  assert.equal(rows[1]?.excerpt, 'AssertionError: expected 1 to equal 2');
  assert.equal(rows[2]?.reason, 'Superseded by a newer turn');
  assert.equal(rows[2]?.excerpt, undefined);
});

test('only failed, timed-out, and errored rows expose output', () => {
  const rows = checkRows(
    view('failed', [
      result({ status: 'passed', output: 'ignored' }),
      result({ status: 'timed-out', output: 'timed out' }),
      result({ status: 'error', reason: 'The check failed to start.' }),
      result({ status: 'skipped', output: 'ignored', reason: 'off' })
    ])
  );
  assert.equal(rows[0]?.excerpt, undefined);
  assert.equal(rows[1]?.excerpt, 'timed out');
  assert.equal(rows[2]?.excerpt, undefined);
  assert.equal(rows[2]?.reason, 'The check failed to start.');
  assert.equal(rows[3]?.excerpt, undefined);
  assert.equal(rows[3]?.reason, 'off');
});

test('an errored check keeps the host reason separate from its output excerpt', () => {
  const rows = checkRows(
    view('failed', [
      result({
        status: 'error',
        reason: 'spawn failed: ENOENT',
        output: 'line one\nline two'
      })
    ])
  );
  assert.equal(rows[0]?.reason, 'spawn failed: ENOENT');
  assert.equal(rows[0]?.excerpt, 'line one\nline two');
});

test('a terminal skipped or untrusted run with no results shows one reason row', () => {
  const noScripts = checkRows({
    status: 'skipped',
    summary: 'Checks skipped: package.json has no typecheck, lint, or test script.',
    results: [],
    startedAt: 1
  });
  assert.equal(noScripts.length, 1);
  assert.equal(noScripts[0]?.statusLabel, 'Skipped');
  assert.equal(noScripts[0]?.reason, 'package.json has no typecheck, lint, or test script.');

  const untrusted = checkRows({
    status: 'untrusted',
    summary: 'Checks skipped: workspace is untrusted.',
    results: [],
    startedAt: 1
  });
  assert.equal(untrusted[0]?.reason, 'workspace is untrusted.');

  const disabled = checkRows({
    status: 'skipped',
    summary: 'Checks are disabled.',
    results: [],
    startedAt: 1
  });
  assert.equal(disabled[0]?.reason, 'Checks are disabled.');
});

test('a running view shows a spinner row before check names exist', () => {
  const rows = checkRows(view('running'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, 'running');
  assert.equal(rows[0]?.statusLabel, 'Running');
  assert.equal(checkRows(undefined).length, 0);
});

test('a long failure excerpt keeps its tail and stays bounded', () => {
  const output = `${'a'.repeat(CHECK_EXCERPT_LIMIT)}TAIL`;
  const excerpt = boundedExcerpt(output);
  assert.equal(excerpt?.startsWith('…'), true);
  assert.equal(excerpt?.endsWith('TAIL'), true);
  assert.equal(excerpt?.length, CHECK_EXCERPT_LIMIT);
  assert.equal(boundedExcerpt(undefined), undefined);
  assert.equal(boundedExcerpt('   '), undefined);
});

test('duration labels use milliseconds below a second and seconds above', () => {
  assert.equal(formatDuration(0), '0 ms');
  assert.equal(formatDuration(999), '999 ms');
  assert.equal(formatDuration(1000), '1 s');
  assert.equal(formatDuration(1500), '1.5 s');
  assert.equal(formatDuration(65000), '65 s');
  assert.equal(formatDuration(-1), '');
});

test('Keep is blocked only while checks run and needs an override only after failure', () => {
  assert.equal(keepGate(undefined), 'allowed');
  assert.equal(keepGate(view('running')), 'blocked-running');
  assert.equal(keepGate(view('failed')), 'needs-override');
  assert.equal(keepGate(view('passed')), 'allowed');
  assert.equal(keepGate(view('skipped')), 'allowed');
  assert.equal(keepGate(view('untrusted')), 'allowed');
});
