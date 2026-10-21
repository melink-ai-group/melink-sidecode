import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * `sidebarView` imports `vscode`, so this guard reads the helper's source
 * rather than loading the module. It still pins the prompt text, the checkbox
 * protocol, and the order of the final verification step.
 */

async function viewSource(): Promise<string> {
  return readFile(join(process.cwd(), 'src', 'sidebarView.ts'), 'utf8');
}

async function helperSource(): Promise<string> {
  return readFile(join(process.cwd(), 'src', 'sidebar', 'turnInstruction.ts'), 'utf8');
}

async function buildTurnInstructionSource(): Promise<string> {
  const source = await helperSource();
  const start = source.indexOf('export function buildTurnInstruction(');
  assert.notEqual(start, -1, 'buildTurnInstruction should exist and be exported');
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

test('the build transition keeps the ordered checklist and checkbox protocol', async () => {
  const body = await buildTurnInstructionSource();
  assert.match(body, /steps\.map\(\(step\) => `- \[ \] \$\{step\.text\}`\)\.join\('\\n'\)/);
  assert.match(body, /"- \[~\] \.\.\."/);
  assert.match(body, /"- \[x\] \.\.\."/);
  assert.match(body, /Execute each step in order/);
  assert.match(body, /Leave the plan document prose unchanged/);
});

test('the build transition ends with an explicit verification step', async () => {
  const body = await buildTurnInstructionSource();
  // The verification paragraph comes after the checklist, so it is the last
  // instruction the agent reads before closing.
  assert.match(body, /list,\s*'',\s*'Before you finish, verify the work/);
  assert.match(body, /lint, typecheck, and tests/);
  assert.match(body, /`package\.json` scripts and the README or contributor docs/);
  assert.match(body, /console, runtime, and network errors/);
  assert.match(body, /Report each command.*result and any failure before you close/);
  assert.ok(body.indexOf('Before you finish, verify the work') > body.indexOf('const list'));
});

test('the helper is still the one the build transition sends', async () => {
  const source = await viewSource();
  assert.match(source, /await this\.sendTurn\(buildTurnInstruction\(state\.steps\)\)/);
});
