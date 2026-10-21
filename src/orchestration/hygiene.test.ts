import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function read(relativePath: string): Promise<string> {
  return readFile(join(process.cwd(), relativePath), 'utf8');
}

test('the decision modules stay host-free', async () => {
  for (const file of [
    'src/orchestration/settings.ts',
    'src/orchestration/quickTask.ts',
    'src/orchestration/plan.ts',
    'src/orchestration/turnEnd.ts',
    'src/orchestration/doubleCheck.ts',
    'src/webview/settings/orchestrationCopy.ts'
  ]) {
    const source = await read(file);
    assert.doesNotMatch(source, /from ['"]vscode['"]/, file);
    assert.doesNotMatch(source, /from ['"].*protocol/, file);
  }
});

test('the turn pipeline decides once and consumes the stored plan at every seam', async () => {
  const source = await read('src/sidebarView.ts');
  assert.match(source, /import \{ planTurn, type TurnPlan \} from '\.\/orchestration\/plan\.ts'/);
  assert.match(source, /session\.turnPlan = planTurn\(\{/);
  assert.match(source, /this\.turnPlans\.set\(turnId, plan\)/);
  assert.match(source, /this\.startChangeChecks\(set, testing\)/);
  assert.match(source, /shouldRunDiffReview\(reviewing, set\.entries\)/);
  assert.match(source, /if \(doubleCheck && terminus === 'completed'\)/);
  // The turn-end decision settles progress for every Agent turn and gates only
  // the continuation on planning.
  assert.match(source, /await runTurnEnd\(/);
  assert.match(source, /settle: \(\) => this\.flushBuiltPlanProgress\(/);
  assert.match(source, /isStillCurrent: \(\) =>/);
  assert.match(source, /continue: \(\) => this\.continuePlanIfReady\(/);
});

test('the double-check pass reads diagnostics and never sends a model turn', async () => {
  const source = await read('src/sidebarView.ts');
  const start = source.indexOf('private async runDoubleCheck');
  const end = source.indexOf('  private ', start + 1);
  assert.ok(start > 0);
  assert.ok(end > start);
  const body = source.slice(start, end);
  assert.match(body, /collectDoubleCheck\(/);
  assert.match(body, /readFileDiagnostics/);
  assert.doesNotMatch(body, /sendTurn|backend\.|runTurnDiffReview/);
});
