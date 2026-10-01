import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSnapshot } from './render.ts';
import { buildContextMessages } from '../backends/contextMessages.ts';
import type { ProjectSnapshot } from './projectContext.ts';

/**
 * The ticket's own regression check, expressed as a unit test: in a real
 * workspace, a fresh thread asked "what is this project about?" must have
 * everything it needs — project name, root, purpose, main languages and an
 * entry point — delivered as system context before the first user turn, with no
 * pasting by the user and no web search.
 *
 * This does not call a model. It asserts the rendered snapshot and the message
 * ordering contain every fact the answer requires, which is the part this
 * ticket owns. A live model answer is covered by `docs/manual-test.md`.
 */

/** A snapshot shaped like this repository: a TypeScript extension with a README. */
const repoSnapshot: ProjectSnapshot = {
  timestamp: 1_000,
  workspace: {
    names: ['sidebar'],
    roots: ['C:/work/project'],
    multiRoot: false,
    isGitRepo: false,
    branch: null,
    remote: null,
    truncated: null
  },
  shape: {
    languages: [
      { language: 'TypeScript', files: 80 },
      { language: 'Markdown', files: 3 },
      { language: 'CSS', files: 1 }
    ],
    tree: [
      { path: 'src', name: 'src', depth: 1, entries: 8 },
      { path: 'docs', name: 'docs', depth: 1, entries: 3 }
    ],
    manifests: [
      {
        path: 'package.json',
        kind: 'package.json',
        fields: { name: 'melink-agent-sidebar', version: '0.1.0', description: 'One agent chat sidebar.' }
      },
      { path: 'src/', kind: 'src/' }
    ],
    files: ['package.json', 'src/extension.ts'],
    totalFiles: 90,
    languagesTruncated: false,
    truncated: null
  },
  instructions: {
    documents: [
      {
        path: 'README.md',
        kind: 'readme',
        excerpt:
          '# Agent sidebar\n\nOne agent chat sidebar for VS Code and Open VSX hosts, driving Ollama Cloud and the OpenAI Codex CLI.',
        truncated: false
      }
    ],
    noneFound: false,
    truncated: null
  },
  editor: { active: null, openEditors: [], dirtyFiles: [], terminalCwd: null, truncated: null },
  exclusions: { directories: ['node_modules', '.git', 'dist'], patterns: [], user: [] },
  excludedPaths: [],
  truncated: null
};

test('a fresh thread carries name, root, purpose, languages and entry point before the user turn', () => {
  const block = renderSnapshot(repoSnapshot);
  const messages = buildContextMessages([], 'what is this project about?', { snapshot: block, priming: true });

  // The context is the first message and is system-role, before the user turn.
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');

  const context = messages[0].content;
  assert.match(context, /Project name: sidebar\./);
  assert.match(context, /Project root: C:\/work\/project\./);
  assert.match(context, /Purpose \(from README\.md\): One agent chat sidebar for VS Code and Open VSX hosts/);
  assert.match(context, /Main languages: TypeScript \(80 files\)/);
  assert.match(context, /Entry point directories: src\/\./);
});
