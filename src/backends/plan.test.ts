import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN_DIRECTORY,
  adoptedPlanSteps,
  assistantProgressText,
  completeStepsBeforeFrontier,
  mergeCheckboxStatuses,
  mergeReportedStepStatuses,
  parsePlanBody,
  parsePlanSteps,
  parsePlanSummary,
  parsePlanTitle,
  planArtifactFromMarkdown,
  isLoosePlanFile,
  planDocumentFromReply,
  canonicalPlanPath,
  planFileName,
  planRelativePath,
  planRelativePathForTitle,
  planSlugFromTitle,
  planTitleFromFileName,
  recoverPlanDraft,
  planStepsFromReply,
  planSummaryFromReply,
  renderPlanMarkdown,
  sanitizeThreadId,
  applyPlanDecisions,
  extractPlanDecisionLines,
  hasPlanDecisionsSection,
  hasPlanDecisionsTruncationMarker,
  mergePlanDecisionLines,
  PLAN_DECISION_MAX_LINES,
  PLAN_DECISION_MAX_LINE_CHARS,
  PLAN_DECISION_MAX_TOTAL_CHARS,
  PLAN_DECISIONS_TRUNCATION_MARKER,
  hasPlanStepsHeading,
  shouldAutoOpenPlanDocument,
  stepMarker,
  statusForMarker,
  todoStepsFromNative,
  updateStepStatus,
  userAsksToRevisePlan,
  carriedPlanDismissal,
  continuePlanInstruction,
  decidePlanAutopilot,
  planFullyComplete,
  planTurnWork,
  shouldDismissCompletedPlan,
  showBuiltPlanDock
} from './plan.ts';
import { denyInProgressStep, settleInProgressSteps } from './types.ts';
import { modeRefusalReason } from './modes.ts';
import type { TodoStep } from './types.ts';

test('a plan lives at one path derived from the thread id, never the prompt', () => {
  const first = planRelativePath('thread-abc');
  assert.equal(first, `${PLAN_DIRECTORY}/thread-abc.md`);
  // The same thread always resolves to the same file: a revision updates it.
  assert.equal(first, planRelativePath('thread-abc'));
  // A different thread gets a different file.
  assert.notEqual(first, planRelativePath('thread-def'));
});

test('a new plan file uses the title, and a later write keeps that file', () => {
  assert.equal(planSlugFromTitle('Acme Board Status and Location'), 'acme-board-status-and-location');
  assert.equal(
    planRelativePathForTitle('Acme Board Status and Location'),
    `${PLAN_DIRECTORY}/acme-board-status-and-location.md`
  );
  assert.equal(planSlugFromTitle(''), 'plan');
  const created = canonicalPlanPath({
    threadId: '01a10c52-6f1d-7802-af48-7a3542a6b586',
    title: 'Acme board status and location'
  });
  assert.equal(created.path, `${PLAN_DIRECTORY}/acme-board-status-and-location.md`);
  assert.equal(created.retire, undefined);
  const legacy = canonicalPlanPath({
    threadId: '01a10c52-6f1d-7802-af48-7a3542a6b586',
    title: 'Acme board status and location',
    existingPath: planRelativePath('01a10c52-6f1d-7802-af48-7a3542a6b586')
  });
  assert.equal(legacy.path, created.path);
  assert.equal(legacy.retire, planRelativePath('01a10c52-6f1d-7802-af48-7a3542a6b586'));
  const kept = canonicalPlanPath({
    threadId: '01a10c52-6f1d-7802-af48-7a3542a6b586',
    title: 'A different title',
    existingPath: created.path
  });
  assert.equal(kept.path, created.path);
  assert.equal(kept.retire, undefined);
  const named = canonicalPlanPath({
    threadId: '01a10c52-6f1d-7802-af48-7a3542a6b586',
    title: 'Acme board status and location',
    existingPath: `${PLAN_DIRECTORY}/plan.md`
  });
  assert.equal(named.path, created.path);
  assert.equal(named.retire, `${PLAN_DIRECTORY}/plan.md`);
});

test('a new unbuilt plan opens once; a built plan or a repeat does not', () => {
  assert.equal(shouldAutoOpenPlanDocument({ stepCount: 2, alreadyOpened: false }), true);
  assert.equal(shouldAutoOpenPlanDocument({ built: false, stepCount: 2, alreadyOpened: false }), true);
  assert.equal(shouldAutoOpenPlanDocument({ built: true, stepCount: 2, alreadyOpened: false }), false);
  assert.equal(shouldAutoOpenPlanDocument({ stepCount: 0, alreadyOpened: false }), false);
  assert.equal(shouldAutoOpenPlanDocument({ stepCount: 2, alreadyOpened: true }), false);
});

test('a thread id with path characters is sanitized into a safe, stable file name', () => {
  const stem = sanitizeThreadId('a/b\\c:d*e?');
  assert.ok(!stem.includes('/'));
  assert.ok(!stem.includes('\\'));
  assert.ok(!stem.includes(':'));
  assert.equal(sanitizeThreadId('a/b\\c:d*e?'), stem);
  assert.ok(!planFileName('a/b:c').includes('/'));
});

test('an empty or wholly unsafe thread id still yields a usable, bounded name', () => {
  assert.equal(sanitizeThreadId(''), 'thread');
  assert.equal(sanitizeThreadId('...'), 'thread');
  assert.ok(sanitizeThreadId('x'.repeat(500)).length <= 96);
});

test('rendered markdown carries what it will do and a bullet list of steps', () => {
  const markdown = renderPlanMarkdown({
    title: 'Fix the failing test',
    summary: 'Re-run the suite, find the breakage, patch it.',
    steps: [
      { text: 'Reproduce the failure', status: 'pending' },
      { text: 'Patch the bug', status: 'inProgress' },
      { text: 'Re-run the suite', status: 'completed' }
    ]
  });
  assert.match(markdown, /^# Fix the failing test/m);
  assert.match(markdown, /Re-run the suite, find the breakage/);
  assert.match(markdown, /## Steps/);
  assert.match(markdown, /- \[ \] Reproduce the failure/);
  assert.match(markdown, /- \[~\] Patch the bug/);
  assert.match(markdown, /- \[x\] Re-run the suite/);
});

test('the bullet list round-trips through parse, carrying status', () => {
  const steps: TodoStep[] = [
    { text: 'One', status: 'completed' },
    { text: 'Two', status: 'inProgress' },
    { text: 'Three', status: 'pending' }
  ];
  assert.deepEqual(parsePlanSteps(renderPlanMarkdown({ title: 'Plan', steps })), steps);
});

test('a plan with no summary still parses its steps and title', () => {
  const markdown = renderPlanMarkdown({ title: 'Bare plan', steps: [{ text: 'Do a thing', status: 'pending' }] });
  assert.equal(parsePlanTitle(markdown, 'fallback'), 'Bare plan');
  assert.deepEqual(parsePlanSteps(markdown), [{ text: 'Do a thing', status: 'pending' }]);
});

test('a bullet with no checkbox is treated as a pending step, not dropped', () => {
  assert.deepEqual(parsePlanSteps('## Steps\n\n- a plain bullet\n* another one\n'), [
    { text: 'a plain bullet', status: 'pending' },
    { text: 'another one', status: 'pending' }
  ]);
});

test('a title without a heading falls back rather than yielding an empty string', () => {
  assert.equal(parsePlanTitle('no heading here', 'Plan'), 'Plan');
});

test('the what-it-will-do paragraph round-trips out of the markdown', () => {
  const markdown = renderPlanMarkdown({
    title: 'Fix the failing test',
    summary: 'Re-run the suite, find the breakage, patch it.',
    steps: [{ text: 'Reproduce', status: 'pending' }]
  });
  assert.equal(parsePlanSummary(markdown), 'Re-run the suite, find the breakage, patch it.');
});

test('a plan with no prose yields no summary rather than an empty string', () => {
  const markdown = renderPlanMarkdown({ title: 'Bare plan', steps: [{ text: 'Do it', status: 'pending' }] });
  assert.equal(parsePlanSummary(markdown), undefined);
  assert.equal(parsePlanSummary(''), undefined);
});

test('the summary is the first paragraph only, never the whole file', () => {
  const markdown = [
    '# Plan',
    '',
    'First paragraph of the summary.',
    '',
    'A second paragraph that must not be included.',
    '',
    '## Steps',
    '',
    '- one'
  ].join('\n');
  assert.equal(parsePlanSummary(markdown), 'First paragraph of the summary.');
});

test('native turn plan steps map straight onto the shared todo shape', () => {
  assert.deepEqual(
    todoStepsFromNative([
      { step: 'First', status: 'pending' },
      { step: 'Second', status: 'completed' }
    ]),
    [
      { text: 'First', status: 'pending' },
      { text: 'Second', status: 'completed' }
    ]
  );
});

test('a step status update is by index, so duplicate texts stay distinct', () => {
  const steps: TodoStep[] = [
    { text: 'same', status: 'pending' },
    { text: 'same', status: 'pending' }
  ];
  assert.deepEqual(updateStepStatus(steps, 1, 'completed'), [
    { text: 'same', status: 'pending' },
    { text: 'same', status: 'completed' }
  ]);
  // The source array is never mutated.
  assert.deepEqual(steps, [
    { text: 'same', status: 'pending' },
    { text: 'same', status: 'pending' }
  ]);
});

test('an out-of-range step index is a no-op, not a throw', () => {
  const steps: TodoStep[] = [{ text: 'one', status: 'pending' }];
  assert.deepEqual(updateStepStatus(steps, -1, 'completed'), steps);
  assert.deepEqual(updateStepStatus(steps, 9, 'completed'), steps);
});

test('an artifact view carries the path, title, summary and parsed steps', () => {
  const markdown = renderPlanMarkdown({
    title: 'Plan',
    summary: 'What it will do.',
    steps: [{ text: 'step', status: 'pending' }]
  });
  const artifact = planArtifactFromMarkdown({ path: 'x.md', markdown, fallbackTitle: 'fallback', updatedAt: 7 });
  assert.equal(artifact.path, 'x.md');
  assert.equal(artifact.title, 'Plan');
  assert.equal(artifact.summary, 'What it will do.');
  assert.deepEqual(artifact.steps, [{ text: 'step', status: 'pending' }]);
  assert.equal(artifact.updatedAt, 7);
});

test('plan and ask refuse with a plain, distinct explanation', () => {
  assert.match(modeRefusalReason('plan'), /permission level/i);
  assert.match(modeRefusalReason('ask'), /answer/i);
  assert.notEqual(modeRefusalReason('plan'), modeRefusalReason('ask'));
});

test('a plan is derived from the agent reply when no native plan notification arrives', () => {
  const reply = [
    'Here is the plan.',
    '',
    '- Add a retry with backoff',
    '- Cover the new branch with a test',
    '- Run the suite'
  ].join('\n');
  assert.deepEqual(planStepsFromReply(reply), [
    { text: 'Add a retry with backoff', status: 'pending' },
    { text: 'Cover the new branch with a test', status: 'pending' },
    { text: 'Run the suite', status: 'pending' }
  ]);
});

test('a reply with no bullet list fabricates no plan', () => {
  assert.deepEqual(planStepsFromReply('I would approach this by reading the code first.'), []);
  assert.deepEqual(planStepsFromReply(''), []);
});

test('only the first contiguous bullet list is taken from a reply', () => {
  const reply = ['- first', '- second', '', 'Some prose.', '', '- an unrelated later list'].join('\n');
  assert.deepEqual(planStepsFromReply(reply), [
    { text: 'first', status: 'pending' },
    { text: 'second', status: 'pending' }
  ]);
});

test('a denied step round-trips through the markdown marker', () => {
  assert.equal(stepMarker('denied'), '-');
  assert.equal(statusForMarker('-'), 'denied');
  const steps: TodoStep[] = [
    { text: 'done', status: 'completed' },
    { text: 'refused', status: 'denied' },
    { text: 'todo', status: 'pending' }
  ];
  assert.deepEqual(parsePlanSteps(renderPlanMarkdown({ title: 'Plan', steps })), steps);
});

test('the summary is derived from the reply prose ahead of the bullet list', () => {
  const reply = [
    'Make buildContext read the live editor model so a dirty buffer keeps its selection.',
    '',
    '- Add a live-model accessor',
    '- Fall back to disk only when no model exists'
  ].join('\n');
  assert.equal(
    planSummaryFromReply(reply),
    'Make buildContext read the live editor model so a dirty buffer keeps its selection.'
  );
});

test('a reply that opens straight into a list yields no summary', () => {
  assert.equal(planSummaryFromReply('- only a bullet'), undefined);
  assert.equal(planSummaryFromReply('# Heading\n\n- a bullet'), undefined);
  assert.equal(planSummaryFromReply(''), undefined);
});

test('the summary is the first paragraph only, never text below the list', () => {
  const reply = ['The plan summary.', '', '- step one', '', 'Trailing prose that is not a summary.'].join('\n');
  assert.equal(planSummaryFromReply(reply), 'The plan summary.');
});

test('settling a finished turn returns a lingering in-progress step to pending', () => {
  const steps: TodoStep[] = [
    { text: 'done', status: 'completed' },
    { text: 'was running', status: 'inProgress' },
    { text: 'later', status: 'pending' }
  ];
  assert.deepEqual(settleInProgressSteps(steps), [
    { text: 'done', status: 'completed' },
    { text: 'was running', status: 'pending' },
    { text: 'later', status: 'pending' }
  ]);
  // A source array with nothing running is returned unchanged (same values).
  const settled = [{ text: 'done', status: 'completed' as const }];
  assert.deepEqual(settleInProgressSteps(settled), settled);
});

test('settling never revives a denied step', () => {
  const steps: TodoStep[] = [
    { text: 'refused', status: 'denied' },
    { text: 'running', status: 'inProgress' }
  ];
  assert.deepEqual(settleInProgressSteps(steps), [
    { text: 'refused', status: 'denied' },
    { text: 'running', status: 'pending' }
  ]);
});

test('the document body round-trips and the todo list stays at the end', () => {
  const body = ['Read the editor model first.', '', 'Then fall back to disk when no model is open.'].join('\n');
  const steps: TodoStep[] = [
    { text: 'Add the accessor', status: 'pending' },
    { text: 'Cover the fallback', status: 'inProgress' }
  ];
  const markdown = renderPlanMarkdown({ title: 'Live selection', body, steps });
  assert.ok(markdown.indexOf(body) < markdown.indexOf('## Steps'));
  assert.equal(parsePlanBody(markdown), body);
  assert.equal(parsePlanSummary(markdown), 'Read the editor model first.');
  assert.deepEqual(parsePlanSteps(markdown), steps);
  const artifact = planArtifactFromMarkdown({
    path: '.melink/plans/t.md',
    markdown,
    fallbackTitle: 'Plan',
    updatedAt: 3
  });
  assert.equal(artifact.body, body);
  assert.equal(artifact.summary, 'Read the editor model first.');
});

test('a reply with a steps heading keeps the body and ignores an earlier bullet list', () => {
  const reply = [
    '# Live selection',
    '',
    'Read the editor model first.',
    '',
    'Notes:',
    '',
    '- this bullet is prose, not a step',
    '',
    '## Steps',
    '',
    '- [ ] Add the accessor',
    '- [x] Cover the fallback'
  ].join('\n');
  assert.deepEqual(planDocumentFromReply(reply), {
    title: 'Live selection',
    body: ['Read the editor model first.', '', 'Notes:', '', '- this bullet is prose, not a step'].join('\n'),
    summary: 'Read the editor model first.',
    steps: [
      { text: 'Add the accessor', status: 'pending' },
      { text: 'Cover the fallback', status: 'completed' }
    ]
  });
});

test('a reply without a steps heading still uses the first list and the prose before it', () => {
  const reply = ['Here is the plan.', '', 'It touches one file.', '', '- Add a retry', '- Run the suite'].join('\n');
  const draft = planDocumentFromReply(reply);
  assert.equal(draft.body, 'Here is the plan.\n\nIt touches one file.');
  assert.equal(draft.summary, 'Here is the plan.');
  assert.deepEqual(draft.steps, [
    { text: 'Add a retry', status: 'pending' },
    { text: 'Run the suite', status: 'pending' }
  ]);
});

test('answered questions replace a decisions section and stay ahead of later headings', () => {
  const body = applyPlanDecisions('Ship the wording change.', ['1. Which label?: Develop']);
  assert.equal(body, 'Ship the wording change.\n\n## Decisions\n\n- 1. Which label?: Develop');
  const replaced = applyPlanDecisions(`${body}\n\n## Risks\n\nNone.`, ['1. Which label?: Build']);
  assert.equal(
    replaced,
    'Ship the wording change.\n\n## Decisions\n\n- 1. Which label?: Build\n\n## Risks\n\nNone.'
  );
  assert.equal(applyPlanDecisions(undefined, []), undefined);
  assert.equal(hasPlanStepsHeading('## Steps\n\n- [ ] Go'), true);
  assert.equal(hasPlanStepsHeading('No steps here'), false);
});

test('decision storage exposes the documented caps and fixed marker', () => {
  assert.equal(PLAN_DECISION_MAX_LINES, 40);
  assert.equal(PLAN_DECISION_MAX_LINE_CHARS, 300);
  assert.equal(PLAN_DECISION_MAX_TOTAL_CHARS, 8000);
  assert.equal(PLAN_DECISIONS_TRUNCATION_MARKER, '_Earlier decisions were omitted at the storage limit._');
});

test('decisions are read only from their own section and never from prose', () => {
  const body = [
    '# Plan',
    '',
    'Intro prose with a bullet.',
    '',
    '- this is prose, not a decision',
    '',
    '## Decisions',
    '',
    '- 1. Which label?: Develop',
    '-   2.   Where?:   Settings ',
    '',
    '## Risks',
    '',
    '- this later bullet is not a decision'
  ].join('\n');
  assert.deepEqual(extractPlanDecisionLines(body), ['1. Which label?: Develop', '2. Where?: Settings']);
  assert.equal(hasPlanDecisionsSection(body), true);
  assert.equal(hasPlanDecisionsTruncationMarker(body), false);
});

test('a missing, empty, malformed or non-string body yields no decisions without throwing', () => {
  assert.deepEqual(extractPlanDecisionLines(undefined), []);
  assert.deepEqual(extractPlanDecisionLines(''), []);
  assert.deepEqual(extractPlanDecisionLines('No decisions section here.'), []);
  assert.deepEqual(extractPlanDecisionLines('## Decisions\n\nnot a bullet\n\n-   \n\n**bold**'), []);
  assert.deepEqual(extractPlanDecisionLines(42 as unknown as string), []);
  assert.equal(hasPlanDecisionsSection(undefined), false);
  assert.equal(hasPlanDecisionsSection('No decisions section here.'), false);
  assert.equal(hasPlanDecisionsTruncationMarker(42 as unknown as string), false);
});

test('two stored rounds plus a reload and one new round keep all three in order', () => {
  const firstBody = applyPlanDecisions(undefined, ['1. Which label?: Develop']);
  const firstReload = extractPlanDecisionLines(firstBody);
  const second = mergePlanDecisionLines(firstReload, ['2. Where?: Settings']);
  const secondBody = applyPlanDecisions(firstBody, second.lines, { truncated: second.truncated });
  assert.deepEqual(extractPlanDecisionLines(secondBody), [
    '1. Which label?: Develop',
    '2. Where?: Settings'
  ]);
  const third = mergePlanDecisionLines(extractPlanDecisionLines(secondBody), ['3. When?: Now']);
  const thirdBody = applyPlanDecisions(secondBody, third.lines, { truncated: third.truncated });
  assert.deepEqual(extractPlanDecisionLines(thirdBody), [
    '1. Which label?: Develop',
    '2. Where?: Settings',
    '3. When?: Now'
  ]);
});

test('merge is append-only, exact-line deduped first-seen-first, with stable order', () => {
  const merged = mergePlanDecisionLines(['one', 'two'], ['two', 'three', 'one  ', 'two', 'four']);
  assert.deepEqual(merged.lines, ['one', 'two', 'three', 'four']);
  assert.equal(merged.truncated, false);
  // Differently worded equivalents are not superseded: only exact lines dedupe.
  assert.deepEqual(mergePlanDecisionLines(['use tabs'], ['use spaces']).lines, ['use tabs', 'use spaces']);
  // Whitespace is trimmed and collapsed before the exact comparison.
  assert.deepEqual(mergePlanDecisionLines(['one two'], ['  one   two  ']).lines, ['one two']);
});

test('an overlong decision line is bounded to the cap with a trailing ellipsis', () => {
  const merged = mergePlanDecisionLines([], ['x'.repeat(350)]);
  assert.equal(merged.lines.length, 1);
  assert.equal(Array.from(merged.lines[0] ?? '').length, PLAN_DECISION_MAX_LINE_CHARS);
  assert.ok((merged.lines[0] ?? '').endsWith('…'));
  assert.equal(merged.truncated, false);
});

test('the count cap drops the oldest decision lines and reports truncation', () => {
  const incoming = Array.from({ length: 45 }, (_, index) => `${index + 1}. Q: A`);
  const merged = mergePlanDecisionLines([], incoming);
  assert.equal(merged.lines.length, PLAN_DECISION_MAX_LINES);
  assert.equal(merged.lines[0], '6. Q: A');
  assert.equal(merged.lines[PLAN_DECISION_MAX_LINES - 1], '45. Q: A');
  assert.equal(merged.truncated, true);
});

test('the total character cap drops the oldest decision lines and reports truncation', () => {
  const lines = Array.from({ length: 30 }, (_, index) => `${String(index).padStart(2, '0')}: ${'x'.repeat(295)}`);
  const merged = mergePlanDecisionLines([], lines);
  assert.equal(merged.lines.length, 26);
  assert.ok(merged.lines[0]?.startsWith('04:'));
  assert.ok(merged.lines.reduce((sum, line) => sum + line.length, 0) <= PLAN_DECISION_MAX_TOTAL_CHARS);
  assert.equal(merged.truncated, true);
});

test('the truncation marker is written after the heading and ignored by extraction', () => {
  const body = applyPlanDecisions('Prose.', ['1. A'], { truncated: true });
  assert.equal(
    body,
    `Prose.\n\n## Decisions\n\n${PLAN_DECISIONS_TRUNCATION_MARKER}\n\n- 1. A`
  );
  assert.equal(hasPlanDecisionsTruncationMarker(body), true);
  assert.deepEqual(extractPlanDecisionLines(body), ['1. A']);
  // A replacement without the flag drops a marker left by an earlier round.
  assert.equal(hasPlanDecisionsTruncationMarker(applyPlanDecisions(body, ['2. B'])), false);
});

test('a prior marker survives reload and later rounds until an explicit revision clears it', () => {
  const truncatedBody = applyPlanDecisions('Prose.', ['1. A'], { truncated: true });
  const next = mergePlanDecisionLines(extractPlanDecisionLines(truncatedBody), ['2. B']);
  assert.equal(next.truncated, false);
  const priorMarker = hasPlanDecisionsTruncationMarker(truncatedBody);
  const persisted = applyPlanDecisions(truncatedBody, next.lines, {
    truncated: priorMarker || next.truncated
  });
  assert.equal(hasPlanDecisionsTruncationMarker(persisted), true);
  assert.deepEqual(extractPlanDecisionLines(persisted), ['1. A', '2. B']);
  const revised = parsePlanBody(
    '# Plan\n\nProse.\n\n## Decisions\n\n- 2. B\n\n## Steps\n\n- [ ] Go'
  );
  assert.equal(hasPlanDecisionsTruncationMarker(revised), false);
  assert.deepEqual(extractPlanDecisionLines(revised), ['2. B']);
});

test('an empty revised decisions section clears all and is persisted directly, not via the empty no-op', () => {
  const cleared = parsePlanBody('# Plan\n\nProse.\n\n## Decisions\n\n## Steps\n\n- [ ] Go');
  assert.equal(hasPlanDecisionsSection(cleared), true);
  assert.deepEqual(extractPlanDecisionLines(cleared), []);
  assert.match(cleared ?? '', /## Decisions/);
  // applyPlanDecisions() no-ops on empty lines, so the revised body itself is written.
  assert.equal(applyPlanDecisions(cleared, []), cleared);
});

test('an absent decisions section is an omission that keeps accumulated lines', () => {
  const omitted = parsePlanBody('# Plan\n\nProse.\n\n## Steps\n\n- [ ] Go');
  assert.equal(hasPlanDecisionsSection(omitted), false);
  const reapplied = applyPlanDecisions(omitted, ['1. A', '2. B']);
  assert.deepEqual(extractPlanDecisionLines(reapplied), ['1. A', '2. B']);
  // Removing only the heading is handled the same way: it is not a clear.
  assert.equal(hasPlanDecisionsSection(parsePlanBody('# Plan\n\nProse.')), false);
});

test('a populated revised decisions section is authoritative and does not resurrect removed lines', () => {
  const edited = parsePlanBody(
    '# Plan\n\nProse.\n\n## Decisions\n\n- 2. B\n\n## Steps\n\n- [ ] Go'
  );
  assert.equal(hasPlanDecisionsSection(edited), true);
  assert.deepEqual(extractPlanDecisionLines(edited), ['2. B']);
  const afterEdit = mergePlanDecisionLines(extractPlanDecisionLines(edited), ['3. C']);
  assert.deepEqual(afterEdit.lines, ['2. B', '3. C']);
  const reloaded = extractPlanDecisionLines(applyPlanDecisions(edited, afterEdit.lines));
  assert.equal(reloaded.includes('1. A'), false);
  assert.deepEqual(reloaded, ['2. B', '3. C']);
});

test('a revision is recognised only when the user asks to change the plan', () => {
  assert.equal(userAsksToRevisePlan('please update the plan to include tests'), true);
  assert.equal(userAsksToRevisePlan('revise this plan'), true);
  assert.equal(userAsksToRevisePlan('can you change the plan'), true);
  assert.equal(userAsksToRevisePlan('does this plan include tests?'), false);
  assert.equal(userAsksToRevisePlan('fix the failing test'), false);
  assert.equal(userAsksToRevisePlan(''), false);
});

test('checkbox lines update matching steps and leave the rest of the list alone', () => {
  const steps: TodoStep[] = [
    { text: 'Add the accessor', status: 'pending' },
    { text: 'Cover the fallback', status: 'pending' },
    { text: 'same', status: 'pending' },
    { text: 'same', status: 'pending' }
  ];
  const reply = ['Done with the first step.', '', '- [x] Add the accessor', '- [~] same', '- [x] same'].join('\n');
  assert.deepEqual(mergeCheckboxStatuses(steps, reply), [
    { text: 'Add the accessor', status: 'completed' },
    { text: 'Cover the fallback', status: 'pending' },
    { text: 'same', status: 'inProgress' },
    { text: 'same', status: 'completed' }
  ]);
  assert.deepEqual(mergeCheckboxStatuses(steps, 'No checklist here.'), steps.map((step) => ({ ...step })));
});

test('a later checkbox for the same step replaces the earlier status', () => {
  const steps: TodoStep[] = [
    { text: 'Add the accessor', status: 'pending' },
    { text: 'Cover the fallback', status: 'pending' }
  ];
  const reply = ['- [~] Add the accessor', 'working', '- [x] Add the accessor', '- [~] Cover the fallback'].join('\n');
  assert.deepEqual(mergeCheckboxStatuses(steps, reply), [
    { text: 'Add the accessor', status: 'completed' },
    { text: 'Cover the fallback', status: 'inProgress' }
  ]);
});

test('progress is read from every assistant message in the turn', () => {
  const text = assistantProgressText([
    { id: 'u1', kind: 'message', role: 'user', text: 'Build it' },
    { id: 'a1', kind: 'message', role: 'assistant', text: '- [x] Add the accessor' },
    { id: 't1', kind: 'tool', title: 'Edit' },
    { id: 'a2', kind: 'message', role: 'assistant', text: '- [~] Cover the fallback' }
  ]);
  assert.match(text, /- \[x\] Add the accessor/);
  assert.match(text, /- \[~\] Cover the fallback/);
  const earlier = assistantProgressText([
    { id: 'old', kind: 'message', role: 'assistant', text: '- [x] old' },
    { id: 'u2', kind: 'message', role: 'user', text: 'next' },
    { id: 'a3', kind: 'message', role: 'assistant', text: 'Starting now.' }
  ]);
  assert.equal(earlier.includes('[x]'), false);
  assert.match(earlier, /Starting now/);
});

test('a later empty checkbox does not clear a finished step', () => {
  const steps: TodoStep[] = [
    { text: 'Add the accessor', status: 'completed' },
    { text: 'Cover the fallback', status: 'inProgress' }
  ];
  assert.deepEqual(mergeCheckboxStatuses(steps, '- [ ] Add the accessor\n- [ ] Cover the fallback'), [
    { text: 'Add the accessor', status: 'completed' },
    { text: 'Cover the fallback', status: 'inProgress' }
  ]);
});

test('starting a later step completes the open steps before it', () => {
  const steps: TodoStep[] = [
    { text: 'Add the accessor', status: 'pending' },
    { text: 'Cover the fallback', status: 'pending' },
    { text: 'Ship it', status: 'pending' }
  ];
  const merged = mergeCheckboxStatuses(steps, '- [~] Cover the fallback');
  assert.deepEqual(completeStepsBeforeFrontier(merged), [
    { text: 'Add the accessor', status: 'completed' },
    { text: 'Cover the fallback', status: 'inProgress' },
    { text: 'Ship it', status: 'pending' }
  ]);
  const denied: TodoStep[] = [
    { text: 'Refused', status: 'denied' },
    { text: 'Next', status: 'inProgress' }
  ];
  assert.equal(completeStepsBeforeFrontier(denied)[0]?.status, 'denied');
});

test('a native todo update changes matching plan steps and leaves the rest', () => {
  const steps: TodoStep[] = [
    { text: 'Add the accessor', status: 'pending' },
    { text: 'Cover the fallback', status: 'pending' },
    { text: 'Ship it', status: 'pending' }
  ];
  const matched = mergeReportedStepStatuses(steps, [
    { text: 'Add the accessor', status: 'completed' },
    { text: 'Cover the fallback', status: 'inProgress' }
  ]);
  assert.equal(matched.matched, true);
  assert.deepEqual(matched.steps, [
    { text: 'Add the accessor', status: 'completed' },
    { text: 'Cover the fallback', status: 'inProgress' },
    { text: 'Ship it', status: 'pending' }
  ]);
  const unrelated = mergeReportedStepStatuses(steps, [{ text: 'Something else', status: 'completed' }]);
  assert.equal(unrelated.matched, false);
  assert.deepEqual(unrelated.steps, steps.map((step) => ({ ...step })));
});

test('a plan file edit adopts checkbox statuses when the steps are the same', () => {
  const steps: TodoStep[] = [
    { text: 'Add the accessor', status: 'pending' },
    { text: 'Cover the fallback', status: 'pending' }
  ];
  assert.deepEqual(adoptedPlanSteps(steps, [
    { text: 'Add the accessor', status: 'completed' },
    { text: 'Cover the fallback', status: 'inProgress' }
  ]), [
    { text: 'Add the accessor', status: 'completed' },
    { text: 'Cover the fallback', status: 'inProgress' }
  ]);
  assert.equal(adoptedPlanSteps(steps, steps), undefined);
  assert.equal(adoptedPlanSteps(steps, [{ text: 'Rewritten', status: 'completed' }]), undefined);
});

test('rewriting steps keeps the document body', () => {
  const body = 'Read the editor model first.\n\nThen fall back to disk.';
  const markdown = renderPlanMarkdown({
    title: 'Live selection',
    body,
    steps: [
      { text: 'Add the accessor', status: 'completed' },
      { text: 'Cover the fallback', status: 'pending' }
    ]
  });
  assert.equal(parsePlanBody(markdown), body);
  assert.match(markdown, /- \[x\] Add the accessor/);
  assert.ok(markdown.trimEnd().endsWith('- [ ] Cover the fallback'));
});

test('denying marks the running step as denied and leaves the rest alone', () => {
  const steps: TodoStep[] = [
    { text: 'done', status: 'completed' },
    { text: 'refused', status: 'inProgress' },
    { text: 'later', status: 'pending' }
  ];
  assert.deepEqual(denyInProgressStep(steps), [
    { text: 'done', status: 'completed' },
    { text: 'refused', status: 'denied' },
    { text: 'later', status: 'pending' }
  ]);
  // With nothing running there is no step to deny: the list is unchanged.
  const none: TodoStep[] = [{ text: 'a', status: 'pending' }];
  assert.deepEqual(denyInProgressStep(none), none);
});

test('a built plan continues only after a turn that changed the workspace', () => {
  const steps: TodoStep[] = [
    { text: 'Write the schema', status: 'completed' },
    { text: 'Write the service', status: 'pending' }
  ];
  const quiet = decidePlanAutopilot({
    built: true,
    steps,
    automatic: false,
    work: [],
    blocked: false
  });
  assert.equal(quiet.decision, 'hold');

  const repeated = decidePlanAutopilot({
    built: true,
    steps,
    automatic: false,
    previousSignature: quiet.signature,
    work: [],
    blocked: false
  });
  assert.equal(repeated.decision, 'hold');

  const progressed = decidePlanAutopilot({
    built: true,
    steps,
    automatic: true,
    previousSignature: quiet.signature,
    work: ['tool:write:backend/app/services/analytics.py'],
    blocked: false
  });
  assert.equal(progressed.decision, 'continue');

  const stalled = decidePlanAutopilot({
    built: true,
    steps,
    automatic: true,
    previousSignature: progressed.signature,
    work: ['tool:write:backend/app/services/analytics.py'],
    blocked: false
  });
  assert.equal(stalled.decision, 'hold');

  const finished = decidePlanAutopilot({
    built: true,
    steps: steps.map((step) => ({ ...step, status: 'completed' as const })),
    automatic: true,
    previousSignature: progressed.signature,
    work: ['tool:write:backend/app/services/analytics.py'],
    blocked: false
  });
  assert.equal(finished.decision, 'hold');

  const asked = decidePlanAutopilot({
    built: true,
    steps,
    automatic: false,
    work: [],
    blocked: true
  });
  assert.equal(asked.decision, 'hold');
  assert.match(continuePlanInstruction(steps), /Write the service/);
  assert.doesNotMatch(continuePlanInstruction(steps), /Write the schema/);
});

test('a completed plan row hides only after a later user message', () => {
  const done = [{ text: 'Ship it', status: 'completed' as const }];
  const open = [
    { text: 'Ship it', status: 'completed' as const },
    { text: 'Verify it', status: 'pending' as const }
  ];
  const finished = { built: true, steps: done };
  assert.equal(planFullyComplete(done), true);
  assert.equal(planFullyComplete(open), false);
  assert.equal(showBuiltPlanDock(finished), true);
  assert.equal(shouldDismissCompletedPlan(finished, false), true);
  assert.equal(shouldDismissCompletedPlan(finished, true), false);
  assert.equal(showBuiltPlanDock({ ...finished, completedDismissed: true }), false);
  assert.equal(showBuiltPlanDock({ built: true, steps: open, completedDismissed: true }), true);
  assert.equal(carriedPlanDismissal(open, true), undefined);
  assert.equal(carriedPlanDismissal(done, true), true);
});

test('a plan moved into .melink/plans is recoverable when it is not a thread file', () => {
  const owned = new Set(['.melink/plans/thread-abc.md']);
  assert.equal(isLoosePlanFile('.melink/plans/OPENCODE_KNOWLEDGE_SOURCE_LEADS_PLAN.md', owned), true);
  assert.equal(isLoosePlanFile('.melink/plans/thread-abc.md', owned), false);
  assert.equal(isLoosePlanFile('docs/plan.md', owned), false);
  assert.equal(planTitleFromFileName('OPENCODE_KNOWLEDGE_SOURCE_LEADS_PLAN.md'), 'OPENCODE KNOWLEDGE SOURCE LEADS PLAN');

  const moved = [
    '# Knowledge source leads',
    '',
    'Read the current indexer before changing it.',
    '',
    '## Steps',
    '',
    '- [ ] Read the indexer',
    '- [x] Note the gap'
  ].join('\n');
  const draft = recoverPlanDraft(moved, 'fallback');
  assert.equal(draft?.title, 'Knowledge source leads');
  assert.deepEqual(draft?.steps, [
    { text: 'Read the indexer', status: 'pending' },
    { text: 'Note the gap', status: 'completed' }
  ]);

  const numbered = ['# Later', '', '1. First', '2. Second'].join('\n');
  assert.deepEqual(recoverPlanDraft(numbered, 'fallback')?.steps, [
    { text: 'First', status: 'pending' },
    { text: 'Second', status: 'pending' }
  ]);
  assert.equal(recoverPlanDraft('Just a paragraph.', 'fallback'), undefined);
});

test('plan work is the latest turn’s tools and files, not the prose', () => {
  assert.deepEqual(
    planTurnWork([
      { id: 'u', kind: 'message', role: 'user', text: 'Build the plan' },
      { id: 'a', kind: 'message', role: 'assistant', text: 'Writing the service next.' },
      { id: 't', kind: 'tool', tool: 'read', command: 'analytics.py' },
      { id: 'f', kind: 'file-change', files: [{ path: 'backend/app/services/analytics.py', additions: 4, deletions: 1 }] }
    ]),
    ['tool:read:analytics.py', 'file:backend/app/services/analytics.py:4:1']
  );
});
