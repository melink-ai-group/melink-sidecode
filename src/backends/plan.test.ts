import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN_DIRECTORY,
  mergeCheckboxStatuses,
  parsePlanBody,
  parsePlanSteps,
  parsePlanSummary,
  parsePlanTitle,
  planArtifactFromMarkdown,
  planDocumentFromReply,
  planFileName,
  planRelativePath,
  planStepsFromReply,
  planSummaryFromReply,
  renderPlanMarkdown,
  sanitizeThreadId,
  stepMarker,
  statusForMarker,
  todoStepsFromNative,
  updateStepStatus,
  userAsksToRevisePlan
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
