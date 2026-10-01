import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyContextExclusions,
  applyViewExclusions,
  buildContextView,
  categoryExclusionKey,
  exclusionReasonLabel,
  itemExclusionKey
} from './contextView.ts';
import type { ProjectSnapshot } from './projectContext.ts';

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  const base: ProjectSnapshot = {
    timestamp: 1_000,
    workspace: {
      names: ['melink-sidebar'],
      roots: ['/work/sidebar'],
      multiRoot: false,
      isGitRepo: true,
      branch: 'main',
      remote: 'melink/sidebar',
      truncated: null
    },
    shape: {
      languages: [{ language: 'TypeScript', files: 2 }],
      tree: [{ path: 'src', name: 'src', depth: 1, entries: 2 }],
      manifests: [],
      files: ['src/a.ts', 'src/b.ts'],
      totalFiles: 2,
      languagesTruncated: false,
      truncated: null
    },
    instructions: {
      documents: [
        { path: 'AGENTS.md', kind: 'agents', excerpt: '# Rules\n\nBe kind.', truncated: false },
        { path: 'README.md', kind: 'readme', excerpt: '# App', truncated: false }
      ],
      noneFound: false,
      truncated: null
    },
    editor: {
      active: {
        absolutePath: '/work/sidebar/src/a.ts',
        relativePath: 'src/a.ts',
        languageId: 'typescript',
        selection: { startLine: 4, startColumn: 1, endLine: 15, endColumn: 1, text: 'const x = 1;', truncated: false },
        excluded: false
      },
      openEditors: [
        { absolutePath: '/work/sidebar/src/a.ts', relativePath: 'src/a.ts', languageId: 'typescript', isActive: true, isDirty: false },
        { absolutePath: '/work/sidebar/src/b.ts', relativePath: 'src/b.ts', languageId: 'typescript', isActive: false, isDirty: true }
      ],
      dirtyFiles: ['src/b.ts'],
      terminalCwd: null,
      truncated: null
    },
    exclusions: { directories: [], patterns: [], user: [] },
    excludedPaths: [],
    truncated: null
  };
  return { ...base, ...overrides };
}

test('the strip read model names the workspace, branch, and viewed file', () => {
  const view = buildContextView(snapshot());
  assert.equal(view.status, 'ready');
  assert.equal(view.workspaceName, 'melink-sidebar');
  assert.equal(view.branch, 'main');
  assert.equal(view.viewedFile, 'src/a.ts');
  assert.equal(view.viewedFileIncluded, false, 'the current file is not sent until the user adds it');
  assert.equal(view.activeFile, undefined);
  assert.equal(view.selectionLines, 0);
});

test('attaching the viewed file names it and its selection', () => {
  const view = buildContextView(snapshot(), { includeViewedFile: true });
  assert.equal(view.viewedFileIncluded, true);
  assert.equal(view.activeFile, 'src/a.ts');
  assert.equal(view.selectionLines, 12, 'lines 4-15 inclusive is 12 lines');
});

test('no selection means no selection indicator', () => {
  const without = buildContextView(
    snapshot({
      editor: {
        active: {
          absolutePath: '/work/sidebar/src/a.ts',
          relativePath: 'src/a.ts',
          languageId: 'typescript',
          selection: null,
          excluded: false
        },
        openEditors: [],
        dirtyFiles: [],
        terminalCwd: null,
        truncated: null
      }
    })
  );
  assert.equal(without.selectionLines, 0);
});

test('a workspace with no folder open is empty, not failed or a blank ready strip', () => {
  const view = buildContextView(
    snapshot({
      workspace: {
        names: [],
        roots: [],
        multiRoot: false,
        isGitRepo: false,
        branch: null,
        remote: null,
        truncated: null
      }
    })
  );
  assert.equal(view.status, 'empty');
  assert.match(view.message ?? '', /no folder is open/i);
  assert.equal(view.categories.length, 0);
});

test('the panel carries one row per category with counts and truncation state', () => {
  const view = buildContextView(snapshot());
  const ids = view.categories.map((entry) => entry.id);
  assert.deepEqual(ids, ['instructions', 'shape', 'editor', 'selection', 'changedFiles']);
  const shape = view.categories.find((entry) => entry.id === 'shape');
  assert.equal(shape?.count, 1);
  assert.match(shape?.items[0].excerpt ?? '', /src\/a\.ts/);
});

test('a category can be excluded for one turn and the strip counts drop', () => {
  const base = buildContextView(snapshot());
  const excluded = buildContextView(snapshot(), { exclusions: [categoryExclusionKey('instructions')] });
  const baseIncluded = base.includedCount;
  const excludedIncluded = excluded.includedCount;
  assert.ok(excludedIncluded < baseIncluded, 'excluding a category reduces what is sent');
  assert.ok(excluded.excludedCount > 0);
  const instructions = excluded.categories.find((entry) => entry.id === 'instructions');
  assert.equal(instructions?.excluded, true);
  assert.ok(instructions?.items.every((item) => item.excluded));
});

test('an excluded item is shown excluded with a reason, never as a blank row', () => {
  const view = buildContextView(snapshot(), { exclusions: [itemExclusionKey('instructions', 'AGENTS.md')] });
  const instructions = view.categories.find((entry) => entry.id === 'instructions');
  const item = instructions?.items.find((entry) => entry.id === 'AGENTS.md');
  assert.equal(item?.excluded, true);
  assert.ok(item?.label, 'the label is still present');
});

test('an excluded active file reports its reason instead of appearing empty', () => {
  const view = buildContextView(
    snapshot({
      editor: {
        active: {
          absolutePath: '/work/sidebar/.env',
          relativePath: '.env',
          languageId: 'plaintext',
          selection: null,
          excluded: true,
          exclusionReason: 'secret'
        },
        openEditors: [],
        dirtyFiles: [],
        terminalCwd: null,
        truncated: null
      }
    })
  );
  const editor = view.categories.find((entry) => entry.id === 'editor');
  const item = editor?.items[0];
  assert.equal(item?.excluded, true);
  assert.match(item?.reason ?? '', /secret store/i);
  assert.equal(view.selectionLines, 0);
});

test('excluding a category from the sent snapshot removes its content', () => {
  const filtered = applyContextExclusions(snapshot(), [categoryExclusionKey('instructions')]);
  assert.equal(filtered.instructions.documents.length, 0);
  assert.equal(filtered.instructions.noneFound, true);
});

test('excluding the selection removes the quoted text but keeps the file', () => {
  const filtered = applyContextExclusions(snapshot(), [categoryExclusionKey('selection')]);
  assert.equal(filtered.editor.active?.selection, null);
  assert.equal(filtered.editor.active?.relativePath, 'src/a.ts');
});

test('excluding an item never adds anything back and is pure', () => {
  const input = snapshot();
  const filtered = applyContextExclusions(input, [itemExclusionKey('instructions', 'AGENTS.md')]);
  assert.deepEqual(
    filtered.instructions.documents.map((doc) => doc.path),
    ['README.md']
  );
  assert.equal(input.instructions.documents.length, 2, 'the input snapshot is untouched');
});

test('an empty exclusion set is a no-op returning the same snapshot', () => {
  const input = snapshot();
  assert.equal(applyContextExclusions(input, []), input);
});

test('the optimistic overlay marks items excluded so a toggle reads immediately', () => {
  const view = buildContextView(snapshot());
  const overlaid = applyViewExclusions(view, [categoryExclusionKey('shape')]);
  const shape = overlaid.categories.find((entry) => entry.id === 'shape');
  assert.equal(shape?.excluded, true);
  assert.ok(overlaid.excludedCount >= shape?.count);
});

test('exclusion reasons read as plain language, never a raw enum', () => {
  assert.match(exclusionReasonLabel('secret'), /secret store/);
  assert.match(exclusionReasonLabel(undefined), /excluded/);
  assert.equal(/secret\b(?! store)/.test(`x ${exclusionReasonLabel(undefined)}`), false);
});

test('excluding the selection removes the strip selection indicator', () => {
  const base = buildContextView(snapshot(), { includeViewedFile: true });
  assert.equal(base.selectionLines, 12);
  const excluded = buildContextView(snapshot(), {
    includeViewedFile: true,
    exclusions: [categoryExclusionKey('selection')]
  });
  assert.equal(excluded.selectionLines, 0, 'the strip must not claim a selection the turn will not send');
});

test('the viewed file stays visible when editor context is excluded', () => {
  const base = buildContextView(snapshot(), { includeViewedFile: true });
  assert.equal(base.activeFile, 'src/a.ts');
  const byCategory = buildContextView(snapshot(), {
    includeViewedFile: true,
    exclusions: [categoryExclusionKey('editor')]
  });
  assert.equal(byCategory.viewedFile, 'src/a.ts');
  assert.equal(byCategory.viewedFileIncluded, false);
  assert.equal(byCategory.activeFile, undefined);
  const byItem = buildContextView(snapshot(), {
    includeViewedFile: true,
    exclusions: [itemExclusionKey('editor', 'active')]
  });
  assert.equal(byItem.activeFile, undefined);
  assert.equal(byItem.viewedFileIncluded, false);
});

test('the optimistic overlay clears the strip file and selection when toggled off', () => {
  const view = buildContextView(snapshot());
  const noFile = applyViewExclusions(view, [itemExclusionKey('editor', 'active')]);
  assert.equal(noFile.activeFile, undefined);
  const noSelection = applyViewExclusions(view, [categoryExclusionKey('selection')]);
  assert.equal(noSelection.selectionLines, 0);
});

test('the optimistic overlay never un-excludes a host-excluded file', () => {
  // The host reported the active file excluded because it is a secret store.
  const view = buildContextView(
    snapshot({
      editor: {
        active: {
          absolutePath: '/work/sidebar/.env',
          relativePath: '.env',
          languageId: 'plaintext',
          selection: null,
          excluded: true,
          exclusionReason: 'secret'
        },
        openEditors: [],
        dirtyFiles: [],
        terminalCwd: null,
        truncated: null
      }
    })
  );
  // A local exclusion on some other category must not turn the secret row into
  // a blank, included row.
  const overlaid = applyViewExclusions(view, [categoryExclusionKey('shape')]);
  const editor = overlaid.categories.find((entry) => entry.id === 'editor');
  const item = editor?.items[0];
  assert.equal(item?.excluded, true, 'a host exclusion survives the overlay');
  assert.match(item?.reason ?? '', /secret store/i);
});

test('the overlay is additive: local keys never clear a host exclusion', () => {
  const view = buildContextView(snapshot(), { exclusions: [categoryExclusionKey('instructions')] });
  const instructions = view.categories.find((entry) => entry.id === 'instructions');
  const overlaid = applyViewExclusions(view, [categoryExclusionKey('shape')]);
  const stillExcluded = overlaid.categories.find((entry) => entry.id === 'instructions');
  assert.equal(stillExcluded?.excluded, true);
  assert.equal(stillExcluded?.items.length, instructions?.items.length);
  assert.ok(stillExcluded?.items.every((item) => item.excluded));
});

test('excluding editor state also removes the nested selection from the view', () => {
  const view = buildContextView(snapshot(), { exclusions: [categoryExclusionKey('editor')] });
  assert.equal(view.activeFile, undefined);
  assert.equal(view.selectionLines, 0, 'the selection is nested in editor state, so it goes too');
  const selection = view.categories.find((entry) => entry.id === 'selection');
  assert.equal(selection?.excluded, true);
});

test('excluding editor state removes the selection from the sent snapshot', () => {
  const filtered = applyContextExclusions(snapshot(), [categoryExclusionKey('editor')]);
  assert.equal(filtered.editor.active, null);
});
