import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DIFF_REVIEW_CHAR_LIMIT,
  DIFF_REVIEW_FAILURE_NOTICE,
  DIFF_REVIEW_LINE_LIMIT,
  DIFF_REVIEW_MAX_FINDINGS,
  boundDiffFiles,
  buildDiffReviewPrompt,
  localDiffReview,
  parseDiffReviewFindings,
  runDiffReview
} from './diffReview.ts';

/**
 * The diff-review core is deliberately pure. These tests pin its three seams:
 * the prompt is bounded and advisory, the parser accepts only well-formed
 * findings, and the local fallback catches an explicitly named but unchanged
 * path without pretending to be a semantic reviewer.
 */

test('the prompt carries the request, bounded diff, JSON shape and read-only wording', () => {
  const prompt = buildDiffReviewPrompt({
    request: 'Fix the bug in src/a.ts.',
    files: [{ path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new' }]
  });

  assert.match(prompt, /Fix the bug in src\/a\.ts\./);
  assert.match(prompt, /--- src\/a\.ts ---/);
  assert.match(prompt, /@@ -1 \+1 @@/);
  assert.ok(prompt.includes('"path":"<changed file>"'));
  assert.ok(prompt.includes('"severity":"error"|"warning"|"info"'));
  assert.match(prompt, /read-only/i);
  assert.match(prompt, /advisory only/i);
  assert.match(prompt, /Do not edit files/i);
  assert.match(prompt, /Ignore style nits/i);
  assert.match(prompt, /Return ONLY a JSON array/i);
});

test('the prompt bounds a very large diff before it reaches the reviewer', () => {
  const long = Array.from({ length: 500 }, (_, index) => `+line ${index}`).join('\n');
  const prompt = buildDiffReviewPrompt({
    request: 'Review the whole file.',
    files: [{ path: 'src/big.ts', diff: long }]
  });

  assert.ok(prompt.includes('…'));
  assert.ok(prompt.length < 30_000);
});

test('plain JSON findings are validated, clamped, trimmed and sorted', () => {
  const text = JSON.stringify([
    { path: ' src/b.ts ', line: 0, severity: 'warning', message: ' second ' },
    { path: 'src/a.ts', line: '3', severity: 'ERROR', message: ' first ' }
  ]);

  assert.deepEqual(parseDiffReviewFindings(text), [
    { path: 'src/a.ts', line: 3, severity: 'error', message: 'first' },
    { path: 'src/b.ts', line: 1, severity: 'warning', message: 'second' }
  ]);
});

test('a fenced JSON block or an array embedded in prose is parsed', () => {
  const fenced =
    'Here is the review:\n```json\n[{"path":"src/a.ts","line":2,"severity":"error","message":"Broken"}]\n```\n';
  assert.deepEqual(parseDiffReviewFindings(fenced), [
    { path: 'src/a.ts', line: 2, severity: 'error', message: 'Broken' }
  ]);

  const prose =
    'I found one issue: [{"path":"src/b.ts","line":4,"severity":"info","message":"Note"}] done.';
  assert.deepEqual(parseDiffReviewFindings(prose), [
    { path: 'src/b.ts', line: 4, severity: 'info', message: 'Note' }
  ]);
});

test('invalid and partial entries are dropped, and negative lines clamp to 1', () => {
  const text = JSON.stringify([
    null,
    { line: 1, severity: 'error', message: 'no path' },
    { path: 'src/a.ts', line: 1, severity: 'fatal', message: 'bad severity' },
    { path: 'src/b.ts', severity: 'error', message: 'no line' },
    { path: 'src/c.ts', line: 0, severity: 'info', message: 'clamped' },
    { path: 'src/d.ts', line: -4, severity: 'warning', message: 'clamped too' },
    { path: 'src/e.ts', line: 'nope', severity: 'warning', message: 'bad line' },
    { path: '   ', line: 1, severity: 'warning', message: 'blank path' },
    { path: 'src/f.ts', line: 1, severity: 'warning', message: '   ' }
  ]);

  assert.deepEqual(parseDiffReviewFindings(text), [
    { path: 'src/c.ts', line: 1, severity: 'info', message: 'clamped' },
    { path: 'src/d.ts', line: 1, severity: 'warning', message: 'clamped too' }
  ]);
});

test('parse caps a runaway findings list deterministically', () => {
  const entries = Array.from({ length: 60 }, (_, index) => ({
    path: `src/f${String(index).padStart(3, '0')}.ts`,
    line: 1,
    severity: 'info',
    message: 'message'
  }));

  const findings = parseDiffReviewFindings(JSON.stringify(entries));
  assert.equal(findings.length, DIFF_REVIEW_MAX_FINDINGS);
  assert.equal(findings[0].path, 'src/f000.ts');
  assert.equal(findings[findings.length - 1].path, 'src/f049.ts');
});

test('the local reviewer flags exactly the named path the turn did not change', () => {
  const input = {
    request: 'Update `src/a.ts` and src\\b.ts as discussed.',
    files: [{ path: 'src/a.ts', diff: '@@ -1 +1 @@\n-a\n+b' }]
  };
  const snapshot = JSON.stringify(input);

  const result = localDiffReview(input);

  assert.equal(result.status, 'reviewed');
  assert.deepEqual(result.findings, [
    {
      path: 'src/b.ts',
      line: 1,
      severity: 'warning',
      message: 'The request mentions src/b.ts, but the turn did not change it.'
    }
  ]);
  assert.equal(result.findings.some((finding) => finding.path === 'src/a.ts'), false);
  assert.equal(JSON.stringify(input), snapshot);
});

test('path normalization accepts ./, backslashes and a changed-path match', () => {
  const result = localDiffReview({
    request: 'Touch ./src/c.tsx, src\\a.ts and `src/b.ts`.',
    files: [
      { path: 'src/c.tsx', diff: '+c' },
      { path: 'src/a.ts', diff: '+a' },
      { path: 'src/b.ts', diff: '+b' }
    ]
  });

  assert.equal(result.status, 'no-findings');
  assert.deepEqual(result.findings, []);
});

test('version numbers such as Node 1.93.0 and VS Code 22.12 are not paths', () => {
  const result = localDiffReview({
    request: 'Upgrade Node 1.93.0 and use VS Code 22.12.',
    files: [{ path: 'src/a.ts', diff: '+a' }]
  });

  assert.equal(result.status, 'no-findings');
  assert.deepEqual(result.findings, []);
});

test('mentioned paths match changed paths case-insensitively, so only case differs', () => {
  const result = localDiffReview({
    request: 'Please touch SRC/A.TS and `src/b.ts`.',
    files: [
      { path: 'src/a.ts', diff: '+a' },
      { path: 'src/b.ts', diff: '+b' }
    ]
  });

  assert.equal(result.status, 'no-findings');
  assert.deepEqual(result.findings, []);
});

test('a request without explicit paths never invents a finding', () => {
  const result = localDiffReview({
    request: 'Make the sidebar feel faster and nicer.',
    files: [{ path: 'src/a.ts', diff: '@@ -1 +1 @@\n-a\n+b' }]
  });

  assert.equal(result.status, 'no-findings');
  assert.deepEqual(result.findings, []);
});

test('a mentioned path with an empty diff is still flagged', () => {
  const missing = localDiffReview({ request: 'Please fix src/a.ts', files: [] });
  assert.equal(missing.status, 'reviewed');
  assert.equal(missing.findings.length, 1);
  assert.equal(missing.findings[0].path, 'src/a.ts');

  const emptyDiff = localDiffReview({
    request: 'Please fix src/a.ts',
    files: [{ path: 'src/a.ts', diff: '   \n' }]
  });
  assert.equal(emptyDiff.status, 'reviewed');
  assert.equal(emptyDiff.findings.length, 1);
  assert.equal(emptyDiff.findings[0].path, 'src/a.ts');
});

test('a throwing runner or a missed deadline fails softly with a notice', async () => {
  const input = { request: 'Fix src/a.ts', files: [] };

  const thrown = await runDiffReview(
    input,
    async () => {
      throw new Error('backend unavailable');
    },
    1_000
  );
  assert.equal(thrown.status, 'failed');
  assert.deepEqual(thrown.findings, []);
  assert.equal(thrown.notice, DIFF_REVIEW_FAILURE_NOTICE);

  const slow = await runDiffReview(
    input,
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return [];
    },
    5
  );
  assert.equal(slow.status, 'failed');
  assert.deepEqual(slow.findings, []);
  assert.equal(slow.notice, DIFF_REVIEW_FAILURE_NOTICE);
});

test('runDiffReview accepts a findings array or a complete result and maps empty to no-findings', async () => {
  const input = { request: 'Review src/a.ts', files: [] };
  const finding = {
    path: 'src/a.ts',
    line: 2,
    severity: 'error' as const,
    message: 'Broken'
  };

  const fromArray = await runDiffReview(input, async () => [finding]);
  assert.equal(fromArray.status, 'reviewed');
  assert.deepEqual(fromArray.findings, [finding]);

  const fromResult = await runDiffReview(input, async () => ({
    status: 'reviewed' as const,
    findings: [finding],
    notice: 'Advisory only.'
  }));
  assert.equal(fromResult.status, 'reviewed');
  assert.equal(fromResult.notice, 'Advisory only.');
  assert.deepEqual(fromResult.findings, [finding]);

  const empty = await runDiffReview(input, async () => []);
  assert.equal(empty.status, 'no-findings');
  assert.deepEqual(empty.findings, []);

  const defaultRunner = await runDiffReview({
    request: 'Please fix src/missing.ts',
    files: []
  });
  assert.equal(defaultRunner.status, 'reviewed');
  assert.equal(defaultRunner.findings[0].path, 'src/missing.ts');
});

test('boundDiffFiles caps per-file lines including the truncation marker', () => {
  const diff = Array.from({ length: 300 }, (_, index) => `+line ${index}`).join('\n');
  const files = [{ path: 'src/big.ts', diff }];
  const snapshot = JSON.stringify(files);

  const bounded = boundDiffFiles(files, 10);

  assert.equal(bounded.length, 1);
  assert.ok(bounded[0].diff.split('\n').length <= 10);
  assert.ok(bounded[0].diff.endsWith('…'));
  assert.equal(JSON.stringify(files), snapshot);
});

test('boundDiffFiles caps characters per file and across all files', () => {
  const perFile = boundDiffFiles(
    [{ path: 'src/long.ts', diff: 'x'.repeat(500) }],
    DIFF_REVIEW_LINE_LIMIT,
    50
  );
  assert.ok(perFile[0].diff.length <= 50);
  assert.ok(perFile[0].diff.endsWith('…'));

  const overall = boundDiffFiles(
    [
      { path: 'src/a.ts', diff: 'a'.repeat(80) },
      { path: 'src/b.ts', diff: 'b'.repeat(80) }
    ],
    DIFF_REVIEW_LINE_LIMIT,
    100
  );
  const total = overall.reduce((sum, file) => sum + file.diff.length, 0);
  assert.ok(total <= 100);
  assert.equal(overall[0].diff.length, 80);
  assert.ok(overall[1].diff.endsWith('…'));
});

test('the default limits are exported for the host and docs', () => {
  assert.equal(DIFF_REVIEW_LINE_LIMIT, 200);
  assert.equal(DIFF_REVIEW_CHAR_LIMIT, 24_000);
  assert.equal(boundDiffFiles([{ path: 'a.ts', diff: '+x' }])[0].diff, '+x');
});

test('the review core is read-only by construction: no host or filesystem imports', async () => {
  const text = await readFile(
    join(process.cwd(), 'src', 'review', 'diffReview.ts'),
    'utf8'
  );
  const forbidden = [
    /\bfrom\s+['"]vscode['"]/,
    /\bfrom\s+['"]node:fs['"]/,
    /\bfrom\s+['"]fs['"]/,
    /\bnode:fs\b/,
    /\bchild_process\b/,
    /\bnode:net\b/,
    /\bnode:https?\b/,
    /\bwriteFile\s*\(/,
    /\bconsole\./
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(text), false, `unexpected ${pattern}`);
  }
});
