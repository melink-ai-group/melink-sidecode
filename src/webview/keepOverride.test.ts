import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The check override is a wire fact: the webview must put `overrideChecks` on
 * both decision messages after the user confirms. There is no rendered DOM in
 * this test setup, so assert against the handler source directly.
 */
test('both keep handlers send overrideChecks with their decision message', async () => {
  const app = await readFile(join(process.cwd(), 'src', 'webview', 'App.tsx'), 'utf8');
  const decideAll = app.indexOf("type: 'changes/decideAll'");
  const decide = app.indexOf("type: 'changes/decide'");
  assert.ok(decideAll >= 0, 'decideAll message exists');
  assert.ok(decide >= 0, 'decide message exists');

  const allBlock = app.slice(decideAll, decideAll + 600);
  const fileBlock = app.slice(decide, decide + 600);
  assert.match(allBlock, /overrideChecks/);
  assert.match(fileBlock, /overrideChecks/);
  assert.match(app, /keepChange = \(turnId: string, path: string, overrideChecks\?: boolean\)/);
  assert.match(app, /keepAll = \(turnId: string, overrideChecks\?: boolean\)/);
});

test('the review surface passes true only from the confirmed bypass', async () => {
  const review = await readFile(join(process.cwd(), 'src', 'webview', 'ChangesReview.tsx'), 'utf8');
  assert.match(review, /onKeepAll\(true\)/);
  assert.match(review, /onKeep\(pending\.path, true\)/);
  assert.match(review, /keepGate\(checks\)/);
  assert.match(review, /The failed check will be bypassed/);
});

test('opening one confirmation dismisses the other', async () => {
  const review = await readFile(join(process.cwd(), 'src', 'webview', 'ChangesReview.tsx'), 'utf8');
  const requestKeep = review.slice(review.indexOf('const requestKeep'), review.indexOf('const confirmKeep'));
  assert.match(requestKeep, /onCancelReject\(\)/);
  const requestReject = review.slice(review.indexOf('const requestReject'), review.indexOf('const rejectPaths'));
  assert.match(requestReject, /setKeepConfirm\(undefined\)/);
  assert.match(review, /if \(rejectConfirm\) \{\s*setKeepConfirm\(undefined\)/);
});
