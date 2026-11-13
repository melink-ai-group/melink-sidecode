import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import { parseSubagentRequests } from './delegation.ts';
import { resolvePostTurnRoles, orchestrationTurnSnapshot, orchestrationDiagnostic } from './plan.ts';
import { ORCHESTRATION_DEFAULTS } from './settings.ts';
import { turnRequestText } from '../review/turnReview.ts';
import { collectDoubleCheck, doubleCheckNotice } from './doubleCheck.ts';
import {
  buildOrchestrationDictationPrompt, collectOrchestrationTurnWork,
  parseOrchestrationDictationDecision, ORCHESTRATION_DICTATION_ROLES,
  ORCHESTRATION_DICTATION_TIMEOUT_MS
} from './dictation.ts';
import { resolveCheckPlan } from '../review/checks.ts';

/** Execute the actual host methods with injected host seams, without VS Code. */
async function fixture() {
  const source = await readFile(`${process.cwd()}/src/sidebarView.ts`, 'utf8');
  const methods = ['finishOrchestration', 'finishChangeTurn', 'runDoubleCheck'].map((name) => {
    const start = source.indexOf(`private async ${name}(`);
    assert.ok(start >= 0);
    const end = source.indexOf('  private ', start + 1);
    return source.slice(start, end).replace(/^private /, '');
  });
  const code = transformSync(`class Harness { ${methods.join('\n')} }`, { loader: 'ts', target: 'es2022' }).code;
  const calls: string[] = [];
  const Harness = new Function('parseSubagentRequests', 'turnRequestText', 'resolvePostTurnRoles',
    'orchestrationTurnSnapshot', 'orchestrationDiagnostic', 'readOrchestrationSettings', 'logDiagnostic',
    'DOUBLE_CHECK_SETTLE_MS', 'collectDoubleCheck', 'doubleCheckNotice', 'readFileDiagnostics',
    `${code}; return Harness;`)(parseSubagentRequests, turnRequestText, resolvePostTurnRoles,
      orchestrationTurnSnapshot, orchestrationDiagnostic, () => ORCHESTRATION_DEFAULTS, () => {},
      0, collectDoubleCheck, doubleCheckNotice, () => { calls.push('read diagnostics'); return []; });
  const session = { id: 'chat', mode: 'agent', planEpoch: 1, disposed: false, planHold: false };
  const set = { backendId: 'fake', threadId: 'parent', turnId: 'turn', entries: [{ path: 'src/Card.tsx' }] };
  const host = Object.assign(new Harness(), {
    session, mode: 'agent', activeThread: { backendId: 'fake', threadId: 'parent' },
    orchestrationTurns: new Set(), subagentRuns: new Map(), checkRuns: new Map(),
    delegationRounds: new Map(), reviewFollowups: new Set(), turnPlans: new Map(), planAutopilotQueue: new Map(),
    sessionForThread: () => session,
    changeTracker: { isOpen: () => true, endTurn: async () => set, isTracking: false },
    changeWatcher: { flush: () => {}, stop: () => {} },
    store: { getTranscript: () => [{ id: 'user', kind: 'message', role: 'user', text: 'Update the card.' }] },
    reviewStore: { get: () => ({ findings: [] }) }, stylingReviewStore: { get: () => ({ findings: [] }) },
    checkStore: { get: () => undefined },
    checkHost: { cancelThread: async () => {} },
    post: () => {}, postAgentActivity: () => {}, postTurnChanged: () => calls.push('changes'),
    decideOrchestration: async () => ({ reason: 'off' }),
    startChangeChecks: () => calls.push('checks'), runDoubleCheck: () => calls.push('diagnostics'),
    reviewFinishedTurn: async () => { calls.push('review'); },
    stylingReviewFinishedTurn: async () => { calls.push('styling'); },
    postChangeReview: async () => {}, postCheckpoints: async () => {},
    flushBuiltPlanProgress: async () => { calls.push('settle'); },
    considerPlanAutopilot: async () => { calls.push('autopilot'); },
    flushQueuedTurns: () => { calls.push('drain'); }
  });
  return { host, session, calls, set };
}

test('Stop during snapshot closure prevents new checks and reviewers but retains changed-file review', async () => {
  const { host, calls, set } = await fixture();
  let close!: (value: typeof set) => void;
  host.changeTracker.endTurn = () => new Promise((resolve) => { close = resolve; });
  const finishing = host.finishOrchestration('fake', 'parent', 'turn', 'completed');
  host.subagentRuns.get('chat').controller.abort();
  close(set);
  await finishing;
  assert.ok(calls.includes('changes'));
  assert.ok(!calls.some((call) => ['checks', 'diagnostics', 'review', 'styling', 'autopilot'].includes(call)), calls.join(','));
  assert.equal(host.planAutopilotQueue.size, 0);
  assert.equal(host.subagentRuns.size, 0);
});

test('cancelled and superseded turns do not publish a late diagnostics result', async () => {
  const { host, calls, set } = await fixture();
  const controller = new AbortController();
  host.isGenuinelyNewerTurn = () => false;
  host.postDoubleCheckNotice = () => { calls.push('diagnostic notice'); };
  const run = Object.getPrototypeOf(host).runDoubleCheck.call(host, set, controller.signal);
  controller.abort();
  await run;
  assert.deepEqual(calls, []);
  host.isGenuinelyNewerTurn = () => true;
  await Object.getPrototypeOf(host).runDoubleCheck.call(host, set);
  assert.deepEqual(calls, []);
});

test('an approval denial prevents automatic reviewer correction from starting another main-agent turn', async () => {
  const { host, session } = await fixture();
  session.planHold = true;
  host.reviewStore.get = () => ({ findings: [{ path: 'src/Card.tsx', line: 1, message: 'Check this guard.' }] });
  await host.finishOrchestration('fake', 'parent', 'turn', 'completed');
  assert.equal(host.planAutopilotQueue.size, 0);
});

test('Off and Auto use the closed change set, and a completed review queues one correction', async () => {
  const { host, calls } = await fixture();
  host.turnPlans.set('turn', { choices: { ...ORCHESTRATION_DEFAULTS, testing: 'off', reviewing: 'off', styling: 'auto', doubleCheck: 'off' }, quick: false, dictation: true, reasons: {} });
  host.startChangeChecks = (_set: unknown, enabled: boolean) => { if (enabled) calls.push('checks'); };
  host.stylingReviewStore.get = () => ({ findings: [{ path: 'src/Card.tsx', line: 1, message: 'Compare the existing input.' }] });
  await host.finishOrchestration('fake', 'parent', 'turn', 'completed');
  assert.ok(calls.includes('styling'));
  assert.ok(!calls.includes('review'));
  assert.ok(!calls.includes('checks'));
  assert.match(host.planAutopilotQueue.get('chat').text, /Compare the existing input/);
  assert.equal(host.reviewFollowups.size, 1);
});

test('the dictation decision narrows the Auto passes before the fixed rules run', async () => {
  const { host, calls } = await fixture();
  host.turnPlans.set('turn', {
    choices: { ...ORCHESTRATION_DEFAULTS, testing: 'auto', reviewing: 'auto', styling: 'auto', doubleCheck: 'auto' },
    quick: false,
    dictation: true,
    reasons: {}
  });
  let decided = 0;
  host.decideOrchestration = async () => {
    decided += 1;
    return {
      decision: {
        testing: false,
        reviewing: false,
        styling: true,
        doubleCheck: false,
        reason: 'Only the visible control changed.'
      },
      reason: 'used:thread-model'
    };
  };
  host.startChangeChecks = (_set: unknown, enabled: boolean) => { if (enabled) calls.push('checks'); };
  host.stylingReviewStore.get = () => ({ findings: [] });
  await host.finishOrchestration('fake', 'parent', 'turn', 'completed');
  assert.equal(decided, 1);
  assert.ok(calls.includes('styling'));
  assert.ok(!calls.includes('review'));
  assert.ok(!calls.includes('checks'));
  assert.ok(!calls.includes('diagnostics'));
  assert.equal(host.lastOrchestrationTurn?.reasons.dictation, 'used:thread-model');
});

test('the real decision call receives the owning turn work and detected or configured checks', async () => {
  const source = await readFile(`${process.cwd()}/src/sidebarView.ts`, 'utf8');
  const start = source.indexOf('private async decideOrchestration(');
  const end = source.indexOf('  private ', start + 1);
  const code = transformSync(`class Harness { ${source.slice(start, end).replace(/^private /, '')} }`,
    { loader: 'ts', target: 'es2022' }).code;
  let prompt = '';
  let configured: string[] | undefined;
  let manifestUnavailable = false;
  const dependencies = {
    turnRequestText, buildOrchestrationDictationPrompt, collectOrchestrationTurnWork,
    parseOrchestrationDictationDecision, ORCHESTRATION_DICTATION_ROLES, ORCHESTRATION_DICTATION_TIMEOUT_MS,
    resolveCheckPlan,
    readWorkspaceCheckSettings: () => ({ trusted: true, timeoutMs: 1000, commands: configured }),
    vscodeCheckWorkspace: () => ({ workspaceRoot: () => '/project', readManifest: async () => {
      if (manifestUnavailable) throw new Error('Unavailable');
      return { scripts: { typecheck: 'tsc', test: 'test runner' }, packageManager: 'pnpm@9' };
    } }),
    vscode: { workspace: { asRelativePath: (path: string) => path,
      getConfiguration: () => ({ get: () => '' }) } },
    isDocumentationPath: () => false, isFrontendPath: () => false,
    parseDictationTarget: () => undefined,
    runReadOnlySubagent: async (input: { prompt: string }) => {
      prompt = input.prompt;
      return JSON.stringify({ testing: false, reviewing: true, styling: false, doubleCheck: true });
    }
  };
  const Harness = new Function(...Object.keys(dependencies), `${code}; return Harness;`)(...Object.values(dependencies));
  const host = Object.assign(new Harness(), {
    mode: 'agent', sessionForThread: () => ({ mode: 'agent' }),
    store: {
      getTranscript: () => [
        { id: 'user', kind: 'message', role: 'user', text: 'Fix the handler' },
        { id: 'test', kind: 'tool', command: 'pnpm run test', status: 'completed' },
        { id: 'report', kind: 'message', role: 'assistant', text: 'Typecheck and tests passed.' },
        { id: 'new', kind: 'message', role: 'user', text: 'Another task' },
        { id: 'other', kind: 'tool', command: 'unrelated command', status: 'completed' }
      ],
      listThreads: () => [{ threadId: 'parent', modelId: 'model' }]
    },
    registry: { get: () => ({ permissionLevels: ['read-only'] }) },
    resolveTurnSettings: async () => ({})
  });
  const choices = { ...ORCHESTRATION_DEFAULTS, testing: 'auto' };
  const set = { backendId: 'fake', threadId: 'parent', turnId: 'turn', messageId: 'user', entries: [{ path: 'src/handler.ts' }] };
  const decide = () => host.decideOrchestration(set, { quick: false }, choices, true, 'completed');
  const result = await decide();
  assert.equal(result.decision.testing, false);
  assert.match(prompt, /\["pnpm run typecheck","pnpm run test"\]/);
  assert.match(prompt, /Typecheck and tests passed/);
  assert.doesNotMatch(prompt, /unrelated command/);
  configured = ['custom compile', 'custom tests'];
  await decide();
  assert.match(prompt, /\["custom compile","custom tests"\]/);
  configured = undefined;
  manifestUnavailable = true;
  await decide();
  assert.match(prompt, /Host testing commands[^\n]*\n\(unknown\)/);
});

test('explicit delegation without file changes returns all worker results to the owning main agent', async () => {
  const { host } = await fixture();
  host.changeTracker.endTurn = async () => undefined;
  host.store.getTranscript = () => [
    { id: 'user', kind: 'message', role: 'user', text: 'Investigate the form.' },
    { id: 'reply', kind: 'message', role: 'assistant', text: '```sidecode-subagents\n' + JSON.stringify({ tasks: [
      { task: 'Inspect callers', reason: 'Check integration' }, { task: 'Inspect inputs', reason: 'Compare styles' }
    ] }) + '\n```' }
  ];
  const workers: string[] = [];
  host.runVisibleSubagent = async (_owner: unknown, role: string) => { workers.push(role); return `${role} evidence`; };
  await host.finishOrchestration('fake', 'parent', 'turn', 'completed');
  assert.deepEqual(workers, ['Analysis agent 1', 'Analysis agent 2']);
  assert.match(host.planAutopilotQueue.get('chat').text, /Analysis agent 1 evidence/);
  assert.match(host.planAutopilotQueue.get('chat').text, /Analysis agent 2 evidence/);
});

test('a superseded orchestration cannot clear the newer run busy indicator', async () => {
  const { host } = await fixture();
  let finishOld!: () => void;
  let finishNew!: () => void;
  host.finishChangeTurn = (turn: string) => new Promise<void>((resolve) => {
    if (turn === 'old') { finishOld = resolve; } else { finishNew = resolve; }
  });
  const busy: boolean[] = [];
  host.post = (message: { type: string; value: boolean }) => { if (message.type === 'busy') busy.push(message.value); };
  const old = host.finishOrchestration('fake', 'parent', 'old', 'completed');
  const newer = host.finishOrchestration('fake', 'parent', 'new', 'completed');
  finishOld();
  await old;
  assert.equal(busy.at(-1), true);
  assert.equal(host.subagentRuns.size, 1);
  finishNew();
  await newer;
  assert.equal(busy.at(-1), false);
});
