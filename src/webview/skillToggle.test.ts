import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initialState, reduce, skillToggleAction } from './state.ts';
import type { HostToWebviewMessage } from '../protocol.ts';

/**
 * The skill-toggle bridge.
 *
 * The host reports a refused CLI path as `field` / `fieldMessage`, so the
 * settings screen can show the refusal on the path field itself. The bridge
 * forwards the message through `skillToggleAction`, and the reducer keeps
 * both fields.
 *
 * This is a behaviour test, not a source grep: it runs the same helper the
 * bridge calls, so a field dropped anywhere in the path fails here.
 */

test('the bridge forwards a refused zg path to the reducer', () => {
  const message: HostToWebviewMessage = {
    type: 'zvecGrep',
    pending: false,
    ok: false,
    message: 'Enter an absolute path or a command name for the zg CLI.',
    field: 'zvecGrepPath',
    fieldMessage: 'Enter an absolute path or a command name for the zg CLI.'
  };
  const action = skillToggleAction(message);
  assert.equal(action.type, 'zvecGrep');
  assert.equal(action.field, 'zvecGrepPath');
  assert.equal(action.fieldMessage, 'Enter an absolute path or a command name for the zg CLI.');

  const state = reduce(initialState, action);
  assert.equal(state.zvecGrep?.field, 'zvecGrepPath');
  assert.equal(state.zvecGrep?.fieldMessage, 'Enter an absolute path or a command name for the zg CLI.');
});

test('the bridge forwards a refused ast-grep path to the reducer', () => {
  const message: HostToWebviewMessage = {
    type: 'astGrep',
    pending: false,
    ok: false,
    message: 'Enter an absolute path or a command name for the ast-grep CLI.',
    field: 'astGrepPath',
    fieldMessage: 'Enter an absolute path or a command name for the ast-grep CLI.'
  };
  const action = skillToggleAction(message);
  assert.equal(action.type, 'astGrep');
  assert.equal(action.field, 'astGrepPath');
  assert.equal(action.fieldMessage, 'Enter an absolute path or a command name for the ast-grep CLI.');

  const state = reduce(initialState, action);
  assert.equal(state.astGrep?.field, 'astGrepPath');
  assert.equal(state.astGrep?.fieldMessage, 'Enter an absolute path or a command name for the ast-grep CLI.');
});

test('a toggle without a refused path carries no field', () => {
  const zvec = skillToggleAction({
    type: 'zvecGrep',
    pending: false,
    ok: true,
    message: 'zvec-grep is connected to OpenCode. A new session uses it.'
  });
  assert.equal(zvec.field, undefined);
  assert.equal(zvec.fieldMessage, undefined);

  const ast = skillToggleAction({
    type: 'astGrep',
    pending: true,
    requested: true
  });
  assert.equal(ast.field, undefined);
  assert.equal(ast.fieldMessage, undefined);

  // The reducer keeps the absence too, so a stale refusal cannot linger.
  const state = reduce(initialState, zvec);
  assert.equal(state.zvecGrep?.field, undefined);
  assert.equal(state.zvecGrep?.fieldMessage, undefined);
});

test('a pending toggle keeps the request and still carries the refused field', () => {
  const action = skillToggleAction({
    type: 'zvecGrep',
    pending: true,
    requested: true,
    field: 'zvecGrepPath',
    fieldMessage: 'This value was not saved.'
  });
  assert.equal(action.pending, true);
  assert.equal(action.requested, true);
  assert.equal(action.field, 'zvecGrepPath');
  assert.equal(action.fieldMessage, 'This value was not saved.');
});

/**
 * The bridge must go through the helper.
 *
 * The behaviour test above covers the helper; this covers the one call site
 * that could bypass it and rebuild the action by hand, which is exactly how
 * the field was dropped the first time.
 */
test('the bridge dispatches the skill toggles through the shared helper', async () => {
  const text = await readFile(join(process.cwd(), 'src', 'webview', 'App.tsx'), 'utf8');
  assert.match(text, /case 'zvecGrep':\s*dispatch\(skillToggleAction\(message\)\);/);
  assert.match(text, /case 'astGrep':\s*dispatch\(skillToggleAction\(message\)\);/);
});
