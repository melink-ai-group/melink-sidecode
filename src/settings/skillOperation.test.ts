import test from 'node:test';
import assert from 'node:assert/strict';
import { runSkillOperation, skillOperationMessage } from './skillOperation.ts';

test('a throwing toggle still settles with a readable failure', async () => {
  const outcome = await runSkillOperation(async () => {
    throw new Error('The configuration target is read-only.');
  });
  assert.deepEqual(outcome, {
    ok: false,
    message: 'The configuration target is read-only.'
  });
  assert.equal(
    skillOperationMessage(Object.assign(new Error(''), { message: '   ' })),
    'The skill operation failed before it could finish. Try again.'
  );
});

test('a successful toggle returns its value for the caller to post', async () => {
  const outcome = await runSkillOperation(async () => ({ ok: false, message: 'not connected' }));
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.value, { ok: false, message: 'not connected' });
  assert.equal(outcome.message, '');
});

test('a throwing install/upgrade still settles with a readable failure', async () => {
  // `settings.installAstGrep`/`upgradeAstGrep`/`installZvecGrep` update a
  // locked configuration target after fetching the release; a rejection used
  // to bypass the final `pending: false` post and leave "Installing…" forever.
  for (const thrown of [
    new Error('Unable to write to User Settings because the target is locked.'),
    'network down'
  ]) {
    const outcome = await runSkillOperation(async () => {
      throw thrown;
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.value, undefined);
    assert.equal(
      outcome.message,
      thrown instanceof Error ? thrown.message : 'The skill operation failed before it could finish. Try again.'
    );
  }
});
