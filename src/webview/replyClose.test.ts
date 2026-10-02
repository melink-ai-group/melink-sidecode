import test from 'node:test';
import assert from 'node:assert/strict';
import { splitReplyClose } from './replyClose.ts';

test('a result sentence after a checklist is lifted out of the notes', () => {
  const source = [
    '- [x] Add the chart helpers.',
    '- [x] Mount the section on the dashboard.',
    '',
    'Backend added analytics.py. Frontend added the chart components.',
    '',
    'The dashboard analytics feature is implemented and type-checks.'
  ].join('\n');
  const parts = splitReplyClose(source);
  assert.equal(parts.close, 'The dashboard analytics feature is implemented and type-checks.');
  assert.match(parts.body, /Mount the section/);
  assert.match(parts.body, /Frontend added the chart components/);
  assert.doesNotMatch(parts.body, /implemented and type-checks/);
});

test('the last sentence of a longer closing paragraph is the result', () => {
  const parts = splitReplyClose(
    'Checked the callers.\n\nVerification passed. The feature is implemented and the old tests still fail.'
  );
  assert.equal(parts.close, 'The feature is implemented and the old tests still fail.');
  assert.match(parts.body, /Checked the callers/);
  assert.match(parts.body, /Verification passed\./);
});

test('a reply that is only the result sentence stays one block', () => {
  const source = 'The plan is ready for review.';
  assert.deepEqual(splitReplyClose(source), { body: source });
});

test('a reply that ends on a list or a table keeps that ending', () => {
  assert.equal(splitReplyClose('- [x] First step.\n- [x] Second step.').close, undefined);
  const table = ['Done so far.', '', '| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n');
  assert.equal(splitReplyClose(table).close, undefined);
});

test('a sentence that is too long to be a result line stays in the body', () => {
  const sentence = `${'Word '.repeat(80).trim()}.`;
  const parts = splitReplyClose(`- [x] Step one.\n\n${sentence}`);
  assert.equal(parts.close, undefined);
  assert.match(parts.body, /Step one/);
});
