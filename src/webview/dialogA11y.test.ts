import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (relative: string): string => readFileSync(join(process.cwd(), ...relative.split('/')), 'utf8');

// The webview was split into feature modules, so each a11y guard reads the file
// that now owns the markup it names.
const app = read('src/webview/App.tsx');
const review = read('src/webview/ChangesReview.tsx');
const imageViewer = read('src/webview/composer/attachments.tsx');
const reasoning = read('src/webview/transcript/Reasoning.tsx');

test('the image viewer dialog is modal', () => {
  const dialog = imageViewer.match(/className="image-viewer__dialog"[\s\S]*?>/);
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
  const article = reasoning.match(/<article\s+className=\{`turn turn--reasoning[\s\S]*?>/);
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
  assert.doesNotMatch(reasoning, /className="sr-only" role="status"/);
  assert.match(reasoning, /className="status-slot" aria-hidden="true"/);
  assert.doesNotMatch(reasoning, /reasoning-incomplete" role="status"/);
});

test('the reasoning live region is keyed by state, not streamed text', () => {
  const announcer = app.slice(
    app.indexOf('function ReasoningAnnouncements'),
    app.indexOf('export function App')
  );
  assert.match(announcer, /item\.id}:\$\{item\.status}/);
  assert.doesNotMatch(announcer, /item\.text/);
});
