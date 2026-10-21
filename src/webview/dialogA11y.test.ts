import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const app = readFileSync(join(process.cwd(), 'src/webview/App.tsx'), 'utf8');
const review = readFileSync(join(process.cwd(), 'src/webview/ChangesReview.tsx'), 'utf8');

test('the image viewer dialog is modal', () => {
  const dialog = app.match(/className="image-viewer__dialog"[\s\S]*?>/);
  assert.ok(dialog);
  assert.match(dialog[0], /aria-modal="true"/);
});

test('the change-review reject confirmation is a modal alertdialog', () => {
  const dialog = review.match(/className="changes-review__confirm"[\s\S]*?>/);
  assert.ok(dialog);
  assert.match(dialog[0], /role="alertdialog"/);
  assert.match(dialog[0], /aria-modal="true"/);
});

test('change-review focus restore waits for the review repaint and re-keys on the confirm target', () => {
  assert.match(review, /requestAnimationFrame\(\(\) => \{/);
  assert.match(review, /const confirmKey = rejectConfirm \? `\$\{rejectConfirm\.scope\}:\$\{rejectConfirm\.paths\.join\('\|'\)\}` : ''/);
  assert.match(review, /\[confirmOpen, confirmKey\]/);
});

test('the streaming reasoning article opts out of the transcript live region', () => {
  const article = app.match(/<article\s+className=\{`turn turn--reasoning[\s\S]*?>/);
  assert.ok(article);
  assert.match(article[0], /aria-live="off"/);
  assert.doesNotMatch(article[0], /aria-live="polite"/);
});

test('one reasoning live region is mounted above the transcript, not per card', () => {
  assert.equal(app.match(/<ReasoningAnnouncements /g)?.length, 1);
  const announcer = app.match(
    /function ReasoningAnnouncements[\s\S]*?return \(\s*<p className="sr-only" role="status">/
  );
  assert.ok(announcer);
  const card = app.slice(app.indexOf('function ReasoningCard'), app.indexOf('const NarrationRow'));
  assert.doesNotMatch(card, /className="sr-only" role="status"/);
  assert.match(card, /className="status-slot" aria-hidden="true"/);
  assert.doesNotMatch(card, /reasoning-incomplete" role="status"/);
});

test('the reasoning live region is keyed by state, not streamed text', () => {
  const announcer = app.slice(
    app.indexOf('function ReasoningAnnouncements'),
    app.indexOf('function ReasoningCard')
  );
  assert.match(announcer, /item\.id}:\$\{item\.status}/);
  assert.doesNotMatch(announcer, /item\.text/);
});
