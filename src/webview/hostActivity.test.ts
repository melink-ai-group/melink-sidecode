import test from 'node:test';
import assert from 'node:assert/strict';
import { beginHostActivity, deferHostClick, hostActivityPending, resetHostActivityForTests, setHostBacklog } from './hostActivity.ts';

test('a host action stays busy until it is released, and a second release is a no-op', () => {
  resetHostActivityForTests();
  assert.equal(hostActivityPending(), false);
  const release = beginHostActivity(5_000);
  assert.equal(hostActivityPending(), true);
  release();
  assert.equal(hostActivityPending(), false);
  release();
  assert.equal(hostActivityPending(), false);
});

test('overlapping actions keep the spinner until the last one finishes', () => {
  resetHostActivityForTests();
  const first = beginHostActivity(5_000);
  const second = beginHostActivity(5_000);
  first();
  assert.equal(hostActivityPending(), true);
  second();
  assert.equal(hostActivityPending(), false);
});

test('a held transcript update counts as busy, and clearing it does not', () => {
  resetHostActivityForTests();
  setHostBacklog(true);
  assert.equal(hostActivityPending(), true);
  setHostBacklog(true);
  setHostBacklog(false);
  assert.equal(hostActivityPending(), false);
});

test('a click defers its work until after the current turn and stays busy until release', async () => {
  resetHostActivityForTests();
  let ran = false;
  const release = deferHostClick(() => {
    ran = true;
  });
  assert.equal(ran, false);
  assert.equal(hostActivityPending(), true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(ran, true);
  assert.equal(hostActivityPending(), true);
  release();
  assert.equal(hostActivityPending(), false);
});

test('an unanswered host action clears itself', async () => {
  resetHostActivityForTests();
  beginHostActivity(20);
  assert.equal(hostActivityPending(), true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(hostActivityPending(), false);
});
