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
    'src/orchestration/completion.ts',
    'src/webview/settings/orchestrationCopy.ts'
  ]) {
    const source = await read(file);
    assert.doesNotMatch(source, /from ['"]vscode['"]/, file);
    assert.doesNotMatch(source, /from ['"].*protocol/, file);
  }
});

test('the turn pipeline decides once and consumes the stored plan at every seam', async () => {
  const source = await read('src/sidebarView.ts');
  assert.match(source, /planTurn,\s+resolvePostTurnRoles,/);
  assert.match(source, /from '\.\/orchestration\/plan\.ts'/);
  assert.match(source, /session\.turnPlan = planTurn\(\{/);
  assert.match(source, /this\.turnPlans\.set\(turnId, plan\)/);
  assert.match(source, /resolvePostTurnRoles\(\{/);
  assert.match(source, /this\.startChangeChecks\(set, roles\.testing, \{/);
  assert.match(source, /const shouldReview = roles\.reviewing/);
  assert.match(source, /if \(roles\.doubleCheck && terminus === 'completed'\)/);
  assert.match(source, /logDiagnostic\(\s*orchestrationDiagnostic\(/);
  // The turn-end decision settles progress for every Agent turn and gates only
  // the continuation on planning.
  assert.match(source, /await runTurnEnd\(/);
  assert.match(source, /settle: \(\) => this\.flushBuiltPlanProgress\(/);
  assert.match(source, /isStillCurrent: \(\) =>/);
  assert.match(source, /continue: \(\) => \{/);
  assert.match(source, /continuation = this\.continuePlanIfReady\(session, backendId, threadId\)/);
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

test('the resolved orchestration plan is exposed in the settings read model', async () => {
  const source = await read('src/sidebarView.ts');
  assert.match(source, /orchestrationTurnSnapshot\(plan, roles, \{/);
  assert.match(source, /this\.lastOrchestrationTurn = snapshot/);
  assert.match(source, /lastTurn: this\.lastOrchestrationTurn/);
  assert.match(source, /orchestrationDiagnostic\(plan, roles\)/);
  // The old write-only map must not come back: a snapshot that is stored and
  // never read is not observability.
  assert.doesNotMatch(source, /rememberResolvedRoles|resolvedTurnPlans/);
});

test('a quick notice is stored in its owning chat before the background return', async () => {
  const source = await read('src/sidebarView.ts');
  const start = source.indexOf('private async finishChangeTurn');
  const end = source.indexOf('  private ', start + 1);
  assert.ok(start > 0);
  assert.ok(end > start);
  const body = source.slice(start, end);
  const notice = body.indexOf('this.postQuickTaskNotice(set)');
  const background = body.indexOf('if (this.activeThread?.backendId !== set.backendId');
  assert.ok(notice > 0, 'finishChangeTurn must post the quick notice');
  assert.ok(background > notice, 'the quick notice must precede the background early return');
  assert.match(body, /plan\.quickNotice && set\.entries\.length > 0/);

  const helperStart = source.indexOf('private postQuickTaskNotice');
  const helperEnd = source.indexOf('  private ', helperStart + 1);
  assert.ok(helperStart > 0);
  const helper = source.slice(helperStart, helperEnd);
  // A persisted notice item replays on reload; a transient `notice` message
  // does not.
  assert.match(helper, /type: 'item\/started'/);
  assert.match(helper, /id: `quick-task_\$\{set\.turnId\}`/);
  assert.match(helper, /this\.store\.applyEvent\(event\)/);
  assert.doesNotMatch(helper, /type: 'notice'/);
});

test('stored review evidence is not gated by the current orchestration choice', async () => {
  const source = await read('src/sidebarView.ts');
  const start = source.indexOf('private async postChangeReview');
  const end = source.indexOf('  private ', start + 1);
  assert.ok(start > 0);
  assert.ok(end > start);
  const body = source.slice(start, end);
  assert.match(body, /this\.reviewStore\.get\(backendId, threadId, turnId\)/);
  assert.match(body, /this\.stylingReviewStore\.get\(backendId, threadId, turnId\)/);
  assert.doesNotMatch(body, /readOrchestrationSettings|diffReviewEnabled|stylingCheckEnabled/);
});

test('the completion decision reads status only and never sends a turn', async () => {
  const completion = await read('src/orchestration/completion.ts');
  assert.doesNotMatch(completion, /from ['"]vscode['"]/);
  assert.doesNotMatch(completion, /from ['"].*protocol/);
  assert.doesNotMatch(completion, /from ['"](node:)?(fs|child_process|net|http|https)['"]/);
  assert.doesNotMatch(completion, /localDiffReview|extractMentionedPaths/);
  assert.doesNotMatch(completion, /from ['"][^'"]*(review|checkStore|checkHost|checks)[^'"]*['"]/);
  assert.doesNotMatch(completion, /\.results\b|\bresults\s*:|\bstdout\b|\bstderr\b|\boutput\s*:/);

  const source = await read('src/sidebarView.ts');
  const start = source.indexOf('private async postAttentionNotice');
  const end = source.indexOf('  private ', start + 1);
  assert.ok(start > 0);
  assert.ok(end > start);
  const body = source.slice(start, end);
  assert.match(body, /const key = attentionKey\(expected\.backendId, expected\.threadId, expected\.turnId\)/);
  assert.match(body, /this\.attentionNotified\.claim\(key\)/);
  assert.match(body, /this\.post\(\{ type: 'notice'/);
  assert.doesNotMatch(body, /sendTurn|backend\.|planAutopilotQueue|flushQueuedTurns|userTurnQueues/);
  assert.doesNotMatch(body, /runTurnDiffReview|reviewFinishedTurn|stylingReviewFinishedTurn/);
  assert.doesNotMatch(body, /turnBusy|turnOpen/);

  const checksStart = source.indexOf('private startChangeChecks');
  const checksEnd = source.indexOf('  private ', checksStart + 1);
  assert.ok(checksStart > 0);
  assert.ok(checksEnd > checksStart);
  const checksBody = source.slice(checksStart, checksEnd);
  assert.match(checksBody, /view\.status !== 'failed'/);
  assert.doesNotMatch(checksBody, /view\.(results|output|summary)/);
});
