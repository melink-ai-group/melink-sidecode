import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_UNAVAILABLE_NOTICE,
  DEFAULT_RENDER_BUDGET,
  DELTA_OPEN,
  SNAPSHOT_OPEN,
  renderAttachedFile,
  renderDelta,
  renderSnapshot,
  renderSnapshotResult
} from './render.ts';
import type { ProjectDelta, ProjectSnapshot } from './projectContext.ts';

/**
 * A minimal, well-formed snapshot. Every field is populated so the renderer's
 * sections are all exercised; tests override one field at a time.
 */
function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    timestamp: 1_000,
    workspace: {
      names: ['app'],
      roots: ['/work/app'],
      multiRoot: false,
      isGitRepo: true,
      branch: 'main',
      remote: 'melink/app',
      truncated: null
    },
    shape: {
      languages: [
        { language: 'TypeScript', files: 12 },
        { language: 'Markdown', files: 2 }
      ],
      tree: [
        { path: 'src', name: 'src', depth: 1, entries: 3 },
        { path: 'test', name: 'test', depth: 1, entries: 1 }
      ],
      manifests: [
        { path: 'package.json', kind: 'package.json', fields: { name: 'app', version: '1.0.0' } },
        { path: 'src/', kind: 'src/' }
      ],
      files: ['package.json', 'src/index.ts'],
      totalFiles: 14,
      languagesTruncated: false,
      truncated: null
    },
    instructions: {
      documents: [
        { path: 'README.md', kind: 'readme', excerpt: '# App\n\nA bounded workspace picture.', truncated: false },
        { path: 'AGENTS.md', kind: 'agents', excerpt: 'Always run the tests.', truncated: false }
      ],
      noneFound: false,
      truncated: null
    },
    editor: {
      active: {
        absolutePath: '/work/app/src/index.ts',
        relativePath: 'src/index.ts',
        languageId: 'typescript',
        selection: {
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 12,
          text: 'export x = 1',
          truncated: false
        },
        excluded: false
      },
      openEditors: [
        { absolutePath: '/work/app/src/index.ts', relativePath: 'src/index.ts', languageId: 'typescript', isActive: true, isDirty: false }
      ],
      dirtyFiles: [],
      terminalCwd: null,
      truncated: null
    },
    exclusions: { directories: ['node_modules', '.git'], patterns: [], user: [] },
    excludedPaths: [],
    truncated: null,
    ...overrides
  };
}

test('a snapshot renders name, root, purpose, languages and entry point', () => {
  const text = renderSnapshot(snapshot());
  assert.ok(text.startsWith(SNAPSHOT_OPEN));
  assert.match(text, /Project name: app\./);
  assert.match(text, /Project root: \/work\/app\./);
  assert.match(text, /Purpose \(from README\.md\): A bounded workspace picture\./);
  assert.match(text, /Main languages: TypeScript \(12 files\), Markdown \(2 files\)\./);
  assert.match(text, /Entry point directories: src\/\./);
  assert.match(text, /Active file: src\/index\.ts \(typescript\)\./);
});

test('the purpose prefers the README over AGENTS.md and skips headings', () => {
  const text = renderSnapshot(snapshot());
  assert.match(text, /from README\.md/);
  assert.doesNotMatch(text, /Purpose \(from AGENTS\.md\)/);
});

test('a project with no README falls back to AGENTS.md for its purpose', () => {
  const bare = snapshot({
    instructions: {
      documents: [{ path: 'AGENTS.md', kind: 'agents', excerpt: '# Rules\n\nBuild with npm run build.', truncated: false }],
      noneFound: false,
      truncated: null
    }
  });
  const text = renderSnapshot(bare);
  assert.match(text, /Purpose \(from AGENTS\.md\): Build with npm run build\./);
});

test('a project with no instructions says the purpose is not stated', () => {
  const bare = snapshot({
    instructions: { documents: [], noneFound: true, truncated: null }
  });
  const text = renderSnapshot(bare);
  assert.match(text, /Purpose: not stated in the project instructions or README\./);
  assert.match(text, /Project instructions: none found\./);
});

test('an empty workspace renders explicitly rather than pretending', () => {
  const empty = snapshot({
    workspace: { names: [], roots: [], multiRoot: false, isGitRepo: false, branch: null, remote: null, truncated: null }
  });
  const text = renderSnapshot(empty);
  assert.match(text, /Workspace: no folder is open\./);
});

test('a rendered snapshot is bounded by the budget with no split multi-byte character', () => {
  const huge = snapshot({
    instructions: {
      documents: [{ path: 'README.md', kind: 'readme', excerpt: 'é'.repeat(20_000), truncated: false }],
      noneFound: false,
      truncated: null
    }
  });
  const budget = { ...DEFAULT_RENDER_BUDGET, snapshot: 512 };
  const text = renderSnapshot(huge, { budget });
  assert.ok(Buffer.byteLength(text, 'utf8') <= 512);
  assert.ok(!text.includes('\uFFFD'));
});

test('a malformed snapshot degrades to a notice inside the block, never throwing', () => {
  const malformed = snapshot({ shape: undefined as unknown as ProjectSnapshot['shape'] });
  const text = renderSnapshot(malformed);
  assert.match(text, new RegExp(CONTEXT_UNAVAILABLE_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('renderSnapshotResult reports a missing snapshot as a notice', () => {
  const result = renderSnapshotResult(undefined);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.notice, CONTEXT_UNAVAILABLE_NOTICE);
  }
});

test('an excluded active file is reported, never quoted', () => {
  const excluded = snapshot({
    editor: {
      active: {
        absolutePath: '/work/app/.env',
        relativePath: '.env',
        languageId: 'dotenv',
        selection: null,
        excluded: true,
        exclusionReason: 'secret'
      },
      openEditors: [],
      dirtyFiles: [],
      terminalCwd: null,
      truncated: null
    }
  });
  const text = renderSnapshot(excluded);
  assert.match(text, /excluded from context \(secret\)/i);
  assert.doesNotMatch(text, /SECRET/);
});

test('an unchanged delta renders nothing', () => {
  const delta: ProjectDelta = { changed: false };
  assert.equal(renderDelta(delta, snapshot()), null);
});

test('a delta names the active file and selection change compactly', () => {
  const delta: ProjectDelta = { changed: true, selection: true, activeEditor: true };
  const text = renderDelta(delta, snapshot());
  assert.ok(text);
  assert.ok(text!.startsWith(DELTA_OPEN));
  assert.match(text!, /Active file: src\/index\.ts/);
  assert.match(text!, /Selection:/);
  assert.doesNotMatch(text!, /Project name:/);
});

test('a delta names added and removed files', () => {
  const delta: ProjectDelta = { changed: true, files: { added: ['src/new.ts'], removed: ['src/old.ts'] } };
  const text = renderDelta(delta, snapshot());
  assert.ok(text);
  assert.match(text!, /Files added: src\/new\.ts\./);
  assert.match(text!, /Files removed: src\/old\.ts\./);
});

test('a delta is bounded by the delta budget', () => {
  const delta: ProjectDelta = {
    changed: true,
    files: { added: Array.from({ length: 5_000 }, (_, i) => `src/f-${i}.ts`), removed: [] }
  };
  const budget = { ...DEFAULT_RENDER_BUDGET, delta: 256 };
  const text = renderDelta(delta, snapshot(), { budget });
  assert.ok(text);
  assert.ok(Buffer.byteLength(text!, 'utf8') <= 256);
});

test('an attached file names that path and tells the model not to substitute another', () => {
  const text = renderAttachedFile({
    path: 'frontend/src/styles/global.css',
    languageId: 'css',
    excluded: false,
    text: 'body { color: red; }'
  });
  assert.match(text, /frontend\/src\/styles\/global\.css/);
  assert.match(text, /Do not substitute another file/);
  assert.match(text, /body \{ color: red; \}/);
});

test('a delivery snapshot does not name the viewed file unless it is attached', () => {
  const detached = renderSnapshot(
    snapshot({
      editor: {
        ...snapshot().editor,
        active: null,
        activeFileAttached: false
      }
    })
  );
  assert.match(detached, /not attached/);
  assert.doesNotMatch(detached, /Active file: src\/index\.ts/);
});
