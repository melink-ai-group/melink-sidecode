import test from 'node:test';
import assert from 'node:assert/strict';
import type { DiffReviewResult } from '../review/diffReview.ts';
import { diffReviewView, findingView, severityLabel, stylingReviewView } from './diffReviewView.ts';

/**
 * The diff-review section is driven by one pure display model. These tests pin
 * the three states the panel must never blur together: findings, an explicit
 * clean pass, and a visible-but-non-blocking failure.
 */

test('reviewed findings show severity text, path:line and message', () => {
  const result: DiffReviewResult = {
    status: 'reviewed',
    findings: [
      { path: 'src/a.ts', line: 7, severity: 'warning', message: 'This file was not changed.' },
      { path: 'src/b.ts', line: 2, severity: 'error', message: 'This guard is inverted.' }
    ]
  };

  const view = diffReviewView(result);
  assert.equal(view?.kind, 'findings');
  assert.equal(view?.tone, 'error');
  assert.equal(view?.summary, 'Review: 2 findings');
  assert.equal(view?.heading, '2 diff-review findings');
  assert.deepEqual(view?.findings[1], {
    severity: 'error',
    severityLabel: 'Error',
    location: 'src/b.ts:2',
    message: 'This guard is inverted.'
  });
});

test('one finding has a compact singular header summary', () => {
  const view = diffReviewView({
    status: 'reviewed',
    findings: [{ path: 'src/a.ts', line: 1, severity: 'warning', message: 'Missed file.' }]
  });
  assert.equal(view?.summary, 'Review: 1 finding');
});

test('an empty review says so explicitly instead of rendering nothing', () => {
  const view = diffReviewView({ status: 'no-findings', findings: [] });
  assert.equal(view?.kind, 'empty');
  assert.equal(view?.summary, 'Review: clean');
  assert.equal(view?.heading, 'No diff-review findings.');
  assert.deepEqual(view?.findings, []);
});

test('a failed review keeps its notice and stays advisory', () => {
  const view = diffReviewView({
    status: 'failed',
    findings: [],
    notice: 'The diff review could not complete. Your changes are still ready for review.'
  });
  assert.equal(view?.kind, 'failed');
  assert.equal(view?.tone, 'warning');
  assert.equal(view?.summary, 'Review unavailable');
  assert.match(view?.detail ?? '', /still ready for review/);
  assert.deepEqual(view?.findings, []);
});

test('an unreviewed turn renders no section at all', () => {
  assert.equal(diffReviewView(undefined), undefined);
});

test('a styling result uses its own wording and keeps the brand-kit notice', () => {
  const view = stylingReviewView({
    status: 'reviewed',
    findings: [{ path: 'src/webview/Card.tsx', line: 4, severity: 'warning', message: 'Literal colour.' }],
    notice: 'No brand kit was found; this pass checked generic token and state consistency only.'
  });
  assert.equal(view?.summary, 'Styling: 1 finding');
  assert.equal(view?.heading, '1 styling finding');
  assert.equal(view?.detail, 'No brand kit was found; this pass checked generic token and state consistency only.');
  assert.deepEqual(view?.findings[0], {
    severity: 'warning',
    severityLabel: 'Warning',
    location: 'src/webview/Card.tsx:4',
    message: 'Literal colour.'
  });
  assert.equal(stylingReviewView(undefined), undefined);
});

test('severity labels are fixed words, not glyph-only states', () => {
  assert.equal(severityLabel('error'), 'Error');
  assert.equal(severityLabel('warning'), 'Warning');
  assert.equal(severityLabel('info'), 'Info');
  assert.equal(findingView({ path: 'a.ts', line: 1, severity: 'info', message: 'Note' }).severityLabel, 'Info');
});
