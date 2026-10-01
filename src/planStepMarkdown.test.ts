import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPlanStepIcons,
  isPlanMarkdownPath,
  planPathFromEnv,
  shouldAutoShowPlanPreview,
  type StepToken
} from './planStepMarkdown.ts';

function textToken(content: string): StepToken {
  return { type: 'text', content, children: null, attrs: null };
}

function inline(children: StepToken[]): StepToken {
  return { type: 'inline', content: '', children, attrs: null };
}

function list(itemChildren: StepToken[]): StepToken[] {
  return [
    { type: 'bullet_list_open', content: '', children: null, attrs: null },
    { type: 'list_item_open', content: '', children: null, attrs: null },
    inline(itemChildren),
    { type: 'list_item_close', content: '', children: null, attrs: null },
    { type: 'bullet_list_close', content: '', children: null, attrs: null }
  ];
}

test('a plan path is recognised from a workspace-relative markdown file', () => {
  assert.equal(isPlanMarkdownPath('C:\\work\\proj\\.melink\\plans\\thread.md'), true);
  assert.equal(isPlanMarkdownPath('/work/proj/.melink/plans/thread.md'), true);
  assert.equal(isPlanMarkdownPath('/work/proj/README.md'), false);
  assert.equal(isPlanMarkdownPath(undefined), false);
});

test('a plan file auto-opens in preview once, and other markdown does not', () => {
  const plan = 'C:\\work\\proj\\.melink\\plans\\thread.md';
  assert.equal(shouldAutoShowPlanPreview(plan, false), true);
  assert.equal(shouldAutoShowPlanPreview(plan, true), false);
  assert.equal(shouldAutoShowPlanPreview('C:\\work\\proj\\README.md', false), false);
  assert.equal(shouldAutoShowPlanPreview(undefined, false), false);
});

test('the preview env yields a path from a string or a uri-like object', () => {
  assert.equal(planPathFromEnv({ containingFile: '/work/.melink/plans/a.md' }), '/work/.melink/plans/a.md');
  assert.equal(planPathFromEnv({ containingFile: { fsPath: 'C:\\plans\\a.md' } }), 'C:\\plans\\a.md');
  assert.equal(planPathFromEnv({}), undefined);
  assert.equal(planPathFromEnv(undefined), undefined);
});

test('plan checkbox text becomes a status icon and the marker is removed', () => {
  const tokens = list([textToken('[~] Harden the prompt')]);
  applyPlanStepIcons(tokens, true);
  const children = tokens[2].children ?? [];
  assert.equal(children[0].type, 'html_inline');
  assert.match(children[0].content, /melink-step--progress/);
  assert.match(children[0].content, /aria-label="In progress"/);
  assert.equal(children[1].content, 'Harden the prompt');
  assert.match(tokens[1].attrs?.find((pair) => pair[0] === 'class')?.[1] ?? '', /melink-step-item/);
});

test('done, to-do, and denied markers each get their own icon', () => {
  const done = list([textToken('[x] Ship it')]);
  const todo = list([textToken('[ ] Still open')]);
  const denied = list([textToken('[-] Skipped')]);
  applyPlanStepIcons(done, true);
  applyPlanStepIcons(todo, true);
  applyPlanStepIcons(denied, true);
  assert.match(done[2].children?.[0].content ?? '', /melink-step--done/);
  assert.match(todo[2].children?.[0].content ?? '', /melink-step--todo/);
  assert.match(denied[2].children?.[0].content ?? '', /melink-step--denied/);
  assert.equal(done[2].children?.[1].content, 'Ship it');
});

test('a checkbox input the preview already emitted is replaced with an icon', () => {
  const tokens = list([
    {
      type: 'html_inline',
      content: '<input class="task-list-item-checkbox" checked="" disabled="" type="checkbox">',
      children: null,
      attrs: null
    },
    textToken(' Ship it')
  ]);
  applyPlanStepIcons(tokens, true);
  assert.match(tokens[2].children?.[0].content ?? '', /melink-step--done/);
  assert.equal(tokens[2].children?.[1].content, ' Ship it');
});

test('an ordinary markdown file keeps its checkbox text', () => {
  const tokens = list([textToken('[x] A readme task')]);
  applyPlanStepIcons(tokens, false);
  assert.equal(tokens[2].children?.[0].content, '[x] A readme task');
  assert.equal(tokens[2].children?.length, 1);
});

test('a document that uses an in-progress marker converts the other steps too', () => {
  const tokens = [
    ...list([textToken('[ ] First')]),
    ...list([textToken('[~] Second')])
  ];
  applyPlanStepIcons(tokens, false);
  assert.match(tokens[2].children?.[0].content ?? '', /melink-step--todo/);
  assert.match(tokens[7].children?.[0].content ?? '', /melink-step--progress/);
});
