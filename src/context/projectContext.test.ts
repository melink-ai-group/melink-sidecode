import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BUDGET,
  MAX_MANIFEST_SCRIPTS,
  MAX_SCRIPT_VALUE_BYTES,
  ProjectContext,
  classifyPath,
  cutToBytes,
  languageForPath,
  matchesGlob,
  ownerRepo,
  readManifestFields,
  readmeExcerptOf,
  remoteUrl,
  truncationMarker,
  type DirectoryEntry,
  type ProjectContextHost
} from './projectContext.ts';
import { renderSnapshot } from './render.ts';

/* -------------------------------------------------------------------------- */
/* A fake, host-free workspace                                                */
/* -------------------------------------------------------------------------- */

class FakeHost implements ProjectContextHost {
  roots: string[];
  files = new Map<string, string>();
  directories = new Map<string, DirectoryEntry[]>();
  branch: string | null = null;
  remote: string | null = null;
  active: { path: string; languageId: string; selection?: { text: string } | null } | null = null;
  editors: { path: string; languageId: string; isActive: boolean; isDirty: boolean }[] = [];
  dirty: string[] = [];
  terminal: string | null = null;
  patterns: string[] = [];
  userPatterns: string[] = [];
  /** Records every path that was actually read or enumerated. */
  readPaths: string[] = [];
  time = 1_000;

  constructor(roots: string[]) {
    this.roots = roots;
    for (const root of roots) {
      this.ensureDir(normalize(root));
    }
  }

  addFile(path: string, content = ''): void {
    const normalized = normalize(path);
    const parent = normalized.slice(0, normalized.lastIndexOf('/'));
    this.ensureDir(parent);
    this.files.set(normalized, content);
    this.entriesOf(parent).push({ path: normalized, isDirectory: false });
  }

  addDir(path: string): void {
    this.ensureDir(normalize(path));
  }

  private ensureDir(directory: string): void {
    if (!directory || this.directories.has(directory)) {
      return;
    }
    this.directories.set(directory, []);
    const parent = directory.slice(0, directory.lastIndexOf('/'));
    if (parent && parent !== directory) {
      this.ensureDir(parent);
      this.entriesOf(parent).push({ path: directory, isDirectory: true });
    }
  }

  private entriesOf(directory: string): DirectoryEntry[] {
    const existing = this.directories.get(directory);
    if (existing) {
      return existing;
    }
    const created: DirectoryEntry[] = [];
    this.directories.set(directory, created);
    return created;
  }

  workspaceRoots(): string[] {
    return this.roots;
  }

  async readFile(path: string): Promise<string | undefined> {
    const normalized = normalize(path);
    this.readPaths.push(normalized);
    return this.files.get(normalized);
  }

  async listDirectory(directory: string): Promise<readonly DirectoryEntry[]> {
    const normalized = normalize(directory);
    this.readPaths.push(normalized);
    return this.directories.get(normalized) ?? [];
  }

  async gitBranch(): Promise<string | null> {
    return this.branch;
  }

  async gitRemote(): Promise<string | null> {
    return this.remote;
  }

  activeEditor(): ReturnType<ProjectContextHost['activeEditor']> {
    if (!this.active) {
      return null;
    }
    return {
      absolutePath: this.active.path,
      languageId: this.active.languageId,
      selection: this.active.selection
        ? { startLine: 1, startColumn: 1, endLine: 2, endColumn: 4 }
        : null
    };
  }

  activeSelectionText(): string {
    return this.active?.selection?.text ?? '';
  }

  openEditors(): ReturnType<ProjectContextHost['openEditors']> {
    return this.editors.map((editor) => ({
      absolutePath: editor.path,
      languageId: editor.languageId,
      isActive: editor.isActive,
      isDirty: editor.isDirty
    }));
  }

  dirtyFiles(): readonly string[] {
    return this.dirty;
  }

  async terminalCwd(): Promise<string | null> {
    return this.terminal;
  }

  filesExclude(): readonly string[] {
    return this.patterns;
  }

  searchExclude(): readonly string[] {
    return [];
  }

  userExclude(): readonly string[] {
    return this.userPatterns;
  }

  /** Undefined until a test opts in, so the injected budget stays in charge. */
  settings: import('./contextSettings.ts').ContextSettings | undefined = undefined;

  contextSettings(): import('./contextSettings.ts').ContextSettings | undefined {
    return this.settings;
  }

  now(): number {
    return this.time;
  }
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function fixture(): FakeHost {
  const host = new FakeHost(['/work/app']);
  host.addFile('/work/app/README.md', '# App\n\nA bounded workspace picture.');
  host.addFile(
    '/work/app/package.json',
    JSON.stringify({ name: 'app', version: '1.0.0', scripts: { build: 'x', test: 'y' } })
  );
  host.addFile('/work/app/src/index.ts', 'export const x = 1;');
  host.addFile('/work/app/src/util/helper.ts', 'export const y = 2;');
  host.addFile('/work/app/.env', 'SECRET=super-secret-value');
  host.addFile('/work/app/node_modules/dep/index.js', 'module.exports = "node_modules-marker";');
  host.addFile('/work/app/id_rsa', 'PRIVATE-KEY-MATERIAL');
  return host;
}

/* -------------------------------------------------------------------------- */
/* Glob + classification                                                      */
/* -------------------------------------------------------------------------- */

test('a glob matches anchored, segment and double-star patterns', () => {
  assert.equal(matchesGlob('*.log', 'debug.log'), true);
  assert.equal(matchesGlob('*.log', 'logs/debug.log'), true);
  assert.equal(matchesGlob('/root-only', 'root-only'), true);
  assert.equal(matchesGlob('/root-only', 'nested/root-only'), false);
  assert.equal(matchesGlob('**/generated/**', 'a/generated/b/c.ts'), true);
  assert.equal(matchesGlob('secret-?', 'secret-x'), true);
  assert.equal(matchesGlob('secret-?', 'secret-xy'), false);
});

test('the default ignore set refuses secrets, dependencies, keys and lockfiles', () => {
  assert.deepEqual(classifyPath('/work/app/.env', { patterns: [], user: [] }), { excluded: true, reason: 'secret' });
  assert.deepEqual(classifyPath('/work/app/.env.local', { patterns: [], user: [] }), { excluded: true, reason: 'secret' });
  assert.deepEqual(classifyPath('/work/app/node_modules/x/y.js', { patterns: [], user: [] }), { excluded: true, reason: 'dependency' });
  assert.deepEqual(classifyPath('/work/app/.git/config', { patterns: [], user: [] }), { excluded: true, reason: 'vcs' });
  assert.deepEqual(classifyPath('/work/app/id_rsa', { patterns: [], user: [] }), { excluded: true, reason: 'key-material' });
  assert.deepEqual(classifyPath('/work/app/server.pem', { patterns: [], user: [] }), { excluded: true, reason: 'key-material' });
  assert.deepEqual(classifyPath('/work/app/package-lock.json', { patterns: [], user: [] }), { excluded: true, reason: 'lockfile' });
  assert.deepEqual(classifyPath('/work/app/dist/bundle.js', { patterns: [], user: [] }), { excluded: true, reason: 'build' });
  assert.deepEqual(classifyPath('/work/app/logo.png', { patterns: [], user: [] }), { excluded: true, reason: 'binary' });
  assert.equal(classifyPath('/work/app/src/index.ts', { patterns: [], user: [] }).excluded, false);
});

test('configured and user globs are honored, with the user pattern attributed', () => {
  assert.deepEqual(
    classifyPath('/work/app/generated/schema.ts', { patterns: ['**/generated/**'], user: [] }),
    { excluded: true, reason: 'excluded' }
  );
  assert.deepEqual(
    classifyPath('/work/app/private/notes.md', { patterns: [], user: ['private/**'] }),
    { excluded: true, reason: 'user' }
  );
});

test('the language breakdown names common extensions and falls back to Other', () => {
  assert.equal(languageForPath('a/b.ts'), 'TypeScript');
  assert.equal(languageForPath('a/b.py'), 'Python');
  assert.equal(languageForPath('Makefile'), 'Other');
});

test('a manifest contributes only small structured fields, never its body', () => {
  const fields = readManifestFields('package.json', JSON.stringify({ name: 'app', version: '2.0.0', scripts: { a: 1, b: 2 } }));
  assert.equal(fields.name, 'app');
  assert.equal(fields.version, '2.0.0');
  assert.equal(fields['scripts.a'], undefined);
  assert.equal(fields['scripts.b'], undefined);
  // A malformed manifest yields nothing rather than leaking raw text.
  assert.deepEqual(readManifestFields('package.json', '{ not json'), {});
});

test('package scripts carry bounded command values, not just names', () => {
  const fields = readManifestFields(
    'package.json',
    JSON.stringify({
      scripts: {
        build: 'node esbuild.mjs --production',
        test: 'node --experimental-strip-types --test "src/**/*.test.ts"'
      }
    })
  );
  assert.equal(fields['scripts.build'], 'node esbuild.mjs --production');
  assert.equal(fields['scripts.test'], 'node --experimental-strip-types --test "src/**/*.test.ts"');
  assert.equal(fields.scripts, undefined);
});

test('package script values are capped in count and per-script length', () => {
  const scripts: Record<string, string> = {};
  for (let i = 0; i < MAX_MANIFEST_SCRIPTS + 3; i += 1) {
    scripts[`s${i}`] = i === 0 ? 'x'.repeat(MAX_SCRIPT_VALUE_BYTES * 2) : `echo ${i}`;
  }
  const fields = readManifestFields('package.json', JSON.stringify({ scripts }));
  const names = Object.keys(fields).filter((key) => key.startsWith('scripts.') && key !== 'scripts');

  assert.equal(names.length, MAX_MANIFEST_SCRIPTS);
  assert.ok(Buffer.byteLength(fields['scripts.s0'], 'utf8') <= MAX_SCRIPT_VALUE_BYTES);
  assert.equal(fields['scripts.s0'].endsWith('…'), true);
  assert.equal(fields.scripts, '… 3 more scripts not shown');
});

test('byte truncation never splits a multi-byte character', () => {
  const text = 'héllo wörld';
  const cut = cutToBytes(text, 4);
  assert.ok(Buffer.byteLength(cut.text, 'utf8') <= 4);
  assert.equal(cut.truncated, true);
  assert.equal(text.startsWith(cut.text), true);
});

test('the truncation marker is the one documented shape', () => {
  assert.equal(truncationMarker(2, 9), '… truncated (2 of 9 entries)');
});

test('a git remote is parsed from config preferring origin, and reduced to owner/repo', () => {
  const config = [
    '[core]',
    '\trepositoryformatversion = 0',
    '[remote "upstream"]',
    '\turl = https://github.com/someone/fork.git',
    '[remote "origin"]',
    '\turl = git@github.com:melink/agent-sidebar.git'
  ].join('\n');
  assert.equal(remoteUrl(config), 'git@github.com:melink/agent-sidebar.git');
  assert.equal(ownerRepo('git@github.com:melink/agent-sidebar.git'), 'melink/agent-sidebar');
  assert.equal(ownerRepo('https://github.com/melink/agent-sidebar'), 'melink/agent-sidebar');
  assert.equal(remoteUrl('[core]\n\tbare = false'), null);
});

/* -------------------------------------------------------------------------- */
/* Snapshot shape                                                             */
/* -------------------------------------------------------------------------- */

test('the snapshot reports workspace, shape, instructions and editor state', async () => {
  const host = fixture();
  host.branch = 'feature/context';
  host.remote = 'melink/agent-sidebar';
  host.active = { path: '/work/app/src/index.ts', languageId: 'typescript', selection: { text: 'const x = 1;' } };
  host.editors = [{ path: '/work/app/src/index.ts', languageId: 'typescript', isActive: true, isDirty: true }];
  host.dirty = ['/work/app/src/index.ts'];
  host.terminal = '/work/app';
  const context = new ProjectContext({ host });

  const snapshot = await context.getSnapshot();

  assert.deepEqual(snapshot.workspace.names, ['app']);
  assert.deepEqual(snapshot.workspace.roots, ['/work/app']);
  assert.equal(snapshot.workspace.multiRoot, false);
  assert.equal(snapshot.workspace.isGitRepo, true);
  assert.equal(snapshot.workspace.branch, 'feature/context');
  assert.equal(snapshot.workspace.remote, 'melink/agent-sidebar');

  const languages = Object.fromEntries(snapshot.shape.languages.map((entry) => [entry.language, entry.files]));
  assert.equal(languages.TypeScript, 2);
  assert.equal(languages.Markdown, 1);
  assert.equal(languages.JSON, 1);

  assert.ok(snapshot.shape.tree.some((node) => node.path === 'src'));
  assert.ok(snapshot.shape.manifests.some((hit) => hit.path === 'package.json' && hit.kind === 'package.json'));
  assert.ok(snapshot.shape.manifests.some((hit) => hit.kind === 'src/'));

  assert.equal(snapshot.editor.active?.absolutePath, '/work/app/src/index.ts');
  assert.equal(snapshot.editor.active?.relativePath, 'src/index.ts');
  assert.equal(snapshot.editor.active?.languageId, 'typescript');
  assert.deepEqual(snapshot.editor.active?.selection?.text, 'const x = 1;');
  assert.deepEqual(snapshot.editor.dirtyFiles, ['src/index.ts']);
  assert.equal(snapshot.editor.openEditors.length, 1);
  assert.equal(snapshot.editor.terminalCwd, '/work/app');
});

test('instruction documents are excerpted and an empty category says none found', async () => {
  const host = fixture();
  host.addFile('/work/app/AGENTS.md', 'Always run the tests.');
  host.addFile('/work/app/.github/copilot-instructions.md', 'Be concise.');
  host.addFile('/work/app/packages/api/AGENTS.md', 'API rules.');
  host.addDir('/work/app/packages');
  host.addDir('/work/app/packages/api');
  const context = new ProjectContext({ host });

  const snapshot = await context.getSnapshot();
  assert.equal(snapshot.instructions.noneFound, false);
  const paths = snapshot.instructions.documents.map((doc) => doc.path);
  assert.ok(paths.includes('AGENTS.md'));
  assert.ok(paths.includes('README.md'));
  assert.ok(paths.includes('.github/copilot-instructions.md'));
  assert.ok(paths.includes('packages/api/AGENTS.md'));

  const bare = new FakeHost(['/work/bare']);
  bare.addFile('/work/bare/src/a.ts', 'x');
  const bareSnapshot = await new ProjectContext({ host: bare }).getSnapshot();
  assert.equal(bareSnapshot.instructions.noneFound, true);
  assert.deepEqual(bareSnapshot.instructions.documents, []);
});

test('a multi-root workspace is represented in full, not reduced to the first root', async () => {
  const host = new FakeHost(['/work/a', '/work/b']);
  host.addFile('/work/a/README.md', 'A');
  host.addFile('/work/b/main.py', 'print(1)');
  host.branch = 'main';
  const context = new ProjectContext({ host });

  const snapshot = await context.getSnapshot();
  assert.equal(snapshot.workspace.multiRoot, true);
  assert.deepEqual(snapshot.workspace.roots, ['/work/a', '/work/b']);
  assert.deepEqual(snapshot.workspace.names, ['a', 'b']);
  const languages = Object.fromEntries(snapshot.shape.languages.map((entry) => [entry.language, entry.files]));
  assert.equal(languages.Python, 1);
  assert.equal(languages.Markdown, 1);
});

/* -------------------------------------------------------------------------- */
/* Exclusions                                                                 */
/* -------------------------------------------------------------------------- */

test('no content from an excluded path ever appears in a snapshot', async () => {
  const host = fixture();
  host.addFile('/work/app/notes.log', 'plain');
  host.userPatterns = ['**/private/**'];
  host.addFile('/work/app/private/secret.ts', 'user-private-marker');
  host.addDir('/work/app/private');
  const context = new ProjectContext({ host });

  const serialized = JSON.stringify(await context.getSnapshot());
  assert.equal(serialized.includes('super-secret-value'), false);
  assert.equal(serialized.includes('node_modules-marker'), false);
  assert.equal(serialized.includes('PRIVATE-KEY-MATERIAL'), false);
  assert.equal(serialized.includes('user-private-marker'), false);
});

test('a selection inside an excluded file is reported excluded, never quoted', async () => {
  const host = fixture();
  host.active = { path: '/work/app/.env', languageId: 'dotenv', selection: { text: 'SECRET=super-secret-value' } };
  host.editors = [{ path: '/work/app/.env', languageId: 'dotenv', isActive: true, isDirty: false }];
  const context = new ProjectContext({ host });

  const snapshot = await context.getSnapshot();
  assert.equal(snapshot.editor.active?.excluded, true);
  assert.equal(snapshot.editor.active?.exclusionReason, 'secret');
  assert.equal(snapshot.editor.active?.selection, null);
  assert.ok(snapshot.excludedPaths.some((entry) => entry.path === '/work/app/.env' && entry.reason === 'secret'));
  // The host must never have been asked for the selection text.
  assert.equal(JSON.stringify(snapshot).includes('super-secret-value'), false);
});

test('the walk never descends into an excluded directory', async () => {
  const host = fixture();
  const context = new ProjectContext({ host });
  await context.getSnapshot();
  assert.equal(host.readPaths.some((path) => path.startsWith('/work/app/node_modules/')), false);
});

/* -------------------------------------------------------------------------- */
/* Budgets and truncation                                                     */
/* -------------------------------------------------------------------------- */

test('every category respects its byte cap and carries a truncation marker', async () => {
  const host = new FakeHost(['/work/big']);
  for (let i = 0; i < 200; i += 1) {
    host.addFile(`/work/big/src/file-${i}.ts`, `export const v${i} = ${i};`);
  }
  host.addDir('/work/big/src');
  const budget = { ...DEFAULT_BUDGET, treeEntries: 5, languageEntries: 2, fileEntries: 10, scanLimit: 50 };
  const context = new ProjectContext({ host, budget });

  const snapshot = await context.getSnapshot();
  assert.ok(snapshot.shape.tree.length <= 5);
  assert.ok(snapshot.shape.languages.length <= 2);
  assert.ok(snapshot.shape.files.length <= 10);
  assert.ok(snapshot.shape.truncated?.includes('truncated ('));

  const shapeBytes = Buffer.byteLength(JSON.stringify(snapshot.shape), 'utf8');
  assert.ok(shapeBytes <= budget.shape, `shape is ${shapeBytes} bytes, cap ${budget.shape}`);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= budget.overall);
});

test('a large project keeps the package scripts when the shape budget forces truncation', async () => {
  const host = new FakeHost(['/work/repo']);
  for (let directory = 0; directory < 50; directory += 1) {
    for (let file = 0; file < 20; file += 1) {
      host.addFile(`/work/repo/src/area-${directory}/file-${file}.ts`, `export const value = ${file};`);
    }
  }
  const testCommand = 'node --experimental-strip-types --test "src/**/*.test.ts"';
  host.addFile(
    '/work/repo/package.json',
    JSON.stringify({
      name: 'repo',
      scripts: {
        build: 'node esbuild.mjs --production',
        test: testCommand
      }
    })
  );
  host.addFile('/work/repo/tsconfig.json', JSON.stringify({ extends: './base.json' }));
  host.addFile(
    '/work/repo/pyproject.toml',
    '[project]\nname = "repo"\nversion = "1.0.0"\nrequires-python = ">=3.11"\n'
  );
  host.addFile('/work/repo/Cargo.toml', '[package]\nname = "repo"\nversion = "0.1.0"\nedition = "2021"\n');
  host.addFile('/work/repo/go.mod', 'module example.com/repo\n\ngo 1.22\n');
  const context = new ProjectContext({ host });

  const snapshot = await context.getSnapshot();
  assert.ok(snapshot.shape.files.length < DEFAULT_BUDGET.fileEntries);
  assert.ok(snapshot.shape.manifests.some((hit) => hit.kind === 'package.json'));

  const packageManifest = snapshot.shape.manifests.find((hit) => hit.kind === 'package.json');
  assert.ok(packageManifest);
  assert.equal(packageManifest.fields?.['scripts.test'], testCommand);

  const text = renderSnapshot(snapshot);
  assert.ok(text.includes(`scripts.test: ${testCommand}`));
});

test('an instruction document excerpt is cut to the excerpt cap and marked', async () => {
  const host = new FakeHost(['/work/docs']);
  host.addFile('/work/docs/AGENTS.md', 'x'.repeat(5_000));
  host.addFile('/work/docs/README.md', 'short');
  const budget = { ...DEFAULT_BUDGET, excerptBytes: 100 };
  const context = new ProjectContext({ host, budget });

  const snapshot = await context.getSnapshot();
  const agents = snapshot.instructions.documents.find((doc) => doc.kind === 'agents');
  assert.ok(agents);
  assert.ok(Buffer.byteLength(agents.excerpt, 'utf8') <= 100);
  assert.equal(agents.truncated, true);
});

function readmeWithDevSection(): string {
  const filler = Array.from(
    { length: 30 },
    (_, index) => `Paragraph ${index}: ${'detail '.repeat(12)}`
  ).join('\n\n');
  return [
    '# Dev App',
    '',
    'A small app for testing project context.',
    '',
    '## Overview',
    '',
    filler,
    '',
    '## Development',
    '',
    '### Commands',
    '',
    '```sh',
    'npm install',
    'npm run build',
    'npm test',
    '```',
    '',
    '`npm test` needs Node 22.6+ because it uses --experimental-strip-types.',
    ''
  ].join('\n');
}

test('a large README excerpt selects the development section beyond the first KiB', () => {
  const readme = readmeWithDevSection();
  assert.ok(Buffer.byteLength(readme, 'utf8') > 2_048);

  const excerpt = readmeExcerptOf(readme, 1_024);
  assert.equal(excerpt.truncated, true);
  assert.ok(Buffer.byteLength(excerpt.text, 'utf8') <= 1_024);
  assert.match(excerpt.text, /npm install/);
  assert.match(excerpt.text, /npm run build/);
  assert.match(excerpt.text, /npm test/);
  assert.match(excerpt.text, /Node 22\.6\+/);
});

test('a large README with no development heading still yields a bounded head and tail', () => {
  const readme = ['# Notes', '', 'Intro.', '', `## History\n\n${'old '.repeat(1_000)}`, '', '## Latest', '', 'The end.'].join('\n');
  const excerpt = readmeExcerptOf(readme, 512);

  assert.equal(excerpt.truncated, true);
  assert.ok(Buffer.byteLength(excerpt.text, 'utf8') <= 512);
  assert.match(excerpt.text, /^# Notes/);
  assert.match(excerpt.text, /The end\./);
});

test('the assembled project context carries real script values and the README commands', async () => {
  const host = new FakeHost(['/work/dev']);
  host.addFile('/work/dev/README.md', readmeWithDevSection());
  host.addFile(
    '/work/dev/package.json',
    JSON.stringify({
      name: 'dev-app',
      scripts: {
        build: 'node esbuild.mjs --production',
        test: 'node --experimental-strip-types --test "src/**/*.test.ts"'
      }
    })
  );
  host.addFile('/work/dev/src/index.ts', 'export const value = 1;');
  const context = new ProjectContext({ host });

  const snapshot = await context.getSnapshot();
  const readme = snapshot.instructions.documents.find((doc) => doc.kind === 'readme');
  assert.ok(readme);
  assert.equal(readme.truncated, true);
  assert.match(readme.excerpt, /npm install/);
  assert.match(readme.excerpt, /npm test/);
  assert.match(readme.excerpt, /Node 22\.6\+/);

  const text = renderSnapshot(snapshot);
  assert.match(text, /scripts\.build: node esbuild\.mjs --production/);
  assert.match(text, /scripts\.test: node --experimental-strip-types --test "src\/\*\*\/\*\.test\.ts"/);
  assert.match(text, /npm test/);
  assert.match(text, /Node 22\.6\+/);
});

test('an overall cap drop is marked and still under the over cap', async () => {
  const host = new FakeHost(['/work/huge']);
  for (let i = 0; i < 50; i += 1) {
    host.addFile(`/work/huge/src/f${i}.ts`, 'const value = 1;');
  }
  host.addDir('/work/huge/src');
  host.addFile('/work/huge/README.md', 'r'.repeat(400));
  const budget = { ...DEFAULT_BUDGET, overall: 1_500 };
  const context = new ProjectContext({ host, budget });

  const snapshot = await context.getSnapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= budget.overall);
  assert.ok(snapshot.truncated);
});

/* -------------------------------------------------------------------------- */
/* Delta                                                                      */
/* -------------------------------------------------------------------------- */

test('an unchanged snapshot yields an empty delta', async () => {
  const host = fixture();
  host.active = { path: '/work/app/src/index.ts', languageId: 'typescript', selection: { text: 'a' } };
  const context = new ProjectContext({ host });
  const first = await context.getSnapshot();
  const second = await context.getSnapshot();
  const delta = await context.getDelta(first, second);
  assert.equal(delta.changed, false);
  assert.deepEqual(delta, { changed: false });
});

test('a selection-only change yields a selection delta and no file delta', async () => {
  const host = fixture();
  host.active = { path: '/work/app/src/index.ts', languageId: 'typescript', selection: { text: 'a' } };
  const context = new ProjectContext({ host });
  const first = await context.getSnapshot();
  host.active = { path: '/work/app/src/index.ts', languageId: 'typescript', selection: { text: 'b' } };
  const second = await context.getSnapshot();
  const delta = await context.getDelta(first, second);
  assert.equal(delta.changed, true);
  assert.equal(delta.selection, true);
  assert.equal(delta.files, undefined);
  assert.equal(delta.activeEditor, undefined);
});

test('a file added between snapshots shows up in the delta and not as a selection change', async () => {
  const host = fixture();
  const context = new ProjectContext({ host });
  const first = await context.getSnapshot();
  host.addFile('/work/app/src/new.ts', 'export const n = 1;');
  // The host adapter invalidates on file create/save/delete; without that the
  // cached walk is still authoritative.
  context.invalidate('fileCreated');
  host.time += 5;
  const second = await context.getSnapshot();
  const delta = await context.getDelta(first, second);
  assert.equal(delta.changed, true);
  assert.ok(delta.files?.added.includes('src/new.ts'));
  assert.equal(delta.files?.removed.length, 0);
});

test('a branch change is a gitBranch delta', async () => {
  const host = fixture();
  host.branch = 'main';
  const context = new ProjectContext({ host });
  const first = await context.getSnapshot();
  host.branch = 'feature/x';
  const second = await context.getSnapshot();
  const delta = await context.getDelta(first, second);
  assert.equal(delta.workspace, true);
  assert.equal(delta.gitBranch, true);
});

/* -------------------------------------------------------------------------- */
/* Caching and invalidation                                                   */
/* -------------------------------------------------------------------------- */

test('typing alone does not rebuild the workspace tree', async () => {
  const host = fixture();
  host.active = { path: '/work/app/src/index.ts', languageId: 'typescript', selection: { text: 'a' } };
  const context = new ProjectContext({ host });
  await context.getSnapshot();
  const rootListingsAfterFirst = host.readPaths.filter((path) => path === '/work/app').length;
  assert.ok(rootListingsAfterFirst >= 1);

  // Change only the selection and snapshot again: the cached walk and
  // instruction scan mean the root is not enumerated a second time.
  host.active = { path: '/work/app/src/index.ts', languageId: 'typescript', selection: { text: 'ab' } };
  await context.getSnapshot();
  const rootListingsAfterSecond = host.readPaths.filter((path) => path === '/work/app').length;
  assert.equal(rootListingsAfterSecond, rootListingsAfterFirst);
});

test('an explicit invalidation forces a fresh walk', async () => {
  const host = fixture();
  const context = new ProjectContext({ host });
  await context.getSnapshot();
  context.invalidate('fileCreated');
  host.addFile('/work/app/src/added.ts', 'export const a = 1;');
  const snapshot = await context.getSnapshot();
  assert.ok(snapshot.shape.files.includes('src/added.ts'));
});

test('a configuration change to the ignore patterns invalidates the cache', async () => {
  const host = fixture();
  const context = new ProjectContext({ host });
  const first = await context.getSnapshot();
  const firstFiles = first.shape.files.length;

  // A new user pattern changes the cache key, so the walk is redone.
  host.userPatterns = ['src/util/**'];
  const second = await context.getSnapshot();
  assert.notEqual(second.shape.files.length, firstFiles);
  assert.equal(second.shape.files.some((path) => path.startsWith('src/util/')), false);
});

/* -------------------------------------------------------------------------- */
/* Hygiene: nothing project-derived is persisted                              */
/* -------------------------------------------------------------------------- */

test('the snapshot is self-contained and no write path is touched', async () => {
  const host = fixture();
  host.active = { path: '/work/app/src/index.ts', languageId: 'typescript', selection: { text: 'const x = 1;' } };
  const context = new ProjectContext({ host });
  const snapshot = await context.getSnapshot();
  // A snapshot is pure data: a JSON round trip is lossless and the only
  // "output" is the returned value. There is no console, no fs, no log call.
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

test('the host-free module names no write, log, output or telemetry call', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const source = await readFile(join(process.cwd(), 'src', 'context', 'projectContext.ts'), 'utf8');
  // A grep-by-test: the module cannot write or exfiltrate project content.
  assert.equal(/\bfrom\s+['"]vscode['"]/.test(source), false);
  assert.equal(/\bconsole\./.test(source), false);
  assert.equal(/\bwriteFile\b/.test(source), false);
  assert.equal(/\boutputChannel\b/i.test(source), false);
  assert.equal(/\btelemetry\b/i.test(source), false);
  assert.equal(/\bappendFile\b/.test(source), false);
});

/* -------------------------------------------------------------------------- */
/* Context settings gates                                                     */
/* -------------------------------------------------------------------------- */

test('a disabled category is empty in the snapshot and is never read', async () => {
  const host = fixture();
  host.active = { path: '/work/app/src/index.ts', languageId: 'typescript', selection: { text: 'const x = 1;' } };
  host.editors = [{ path: '/work/app/src/index.ts', languageId: 'typescript', isActive: true, isDirty: false }];
  host.settings = {
    includeInstructions: false,
    includeShape: false,
    includeEditorState: false,
    includeSelection: false,
    includeChangedFiles: true,
    maxBytes: 20_480,
    exclude: []
  };
  const context = new ProjectContext({ host });

  const snapshot = await context.getSnapshot();
  assert.equal(snapshot.instructions.documents.length, 0);
  assert.equal(snapshot.shape.files.length, 0);
  assert.equal(snapshot.editor.active, null);
  assert.equal(snapshot.editor.openEditors.length, 0);
  // No instruction document, no shape manifest, and no editor call was made.
  assert.equal(host.readPaths.includes('/work/app/README.md'), false);
  assert.equal(host.readPaths.includes('/work/app/package.json'), false);
});

test('selection sharing off means the selected text is never read', async () => {
  const host = fixture();
  host.active = { path: '/work/app/src/index.ts', languageId: 'typescript', selection: { text: 'super-secret-selection' } };
  host.editors = [{ path: '/work/app/src/index.ts', languageId: 'typescript', isActive: true, isDirty: false }];
  host.settings = {
    includeInstructions: true,
    includeShape: true,
    includeEditorState: true,
    includeSelection: false,
    includeChangedFiles: true,
    maxBytes: 20_480,
    exclude: []
  };
  const context = new ProjectContext({ host });

  const snapshot = await context.getSnapshot();
  assert.equal(snapshot.editor.active?.absolutePath, '/work/app/src/index.ts');
  assert.equal(snapshot.editor.active?.selection, null);
  assert.equal(JSON.stringify(snapshot).includes('super-secret-selection'), false);
});

test('the settings maxBytes is the overall cap for the snapshot', async () => {
  const host = new FakeHost(['/work/huge']);
  for (let i = 0; i < 50; i += 1) {
    host.addFile(`/work/huge/src/f${i}.ts`, 'const value = 1;');
  }
  host.addDir('/work/huge/src');
  host.addFile('/work/huge/README.md', 'r'.repeat(400));
  host.settings = {
    includeInstructions: true,
    includeShape: true,
    includeEditorState: true,
    includeSelection: true,
    includeChangedFiles: true,
    maxBytes: 1_500,
    exclude: []
  };
  const context = new ProjectContext({ host });

  const snapshot = await context.getSnapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= 1_500);
  assert.ok(snapshot.truncated);
});

test('the user exclude patterns are additive to the built-in ignore set', async () => {
  const host = fixture();
  host.addFile('/work/app/src/generated/api.ts', 'export const generated = 1;');
  host.userPatterns = ['**/generated/**'];
  const context = new ProjectContext({ host });

  const snapshot = await context.getSnapshot();
  assert.equal(snapshot.shape.files.includes('src/generated/api.ts'), false);
  assert.ok(snapshot.excludedPaths.some((entry) => entry.path.includes('generated')));
});

test('an attached file reads the viewed path and refuses a secret', async () => {
  const host = fixture();
  host.active = { path: '/work/app/src/index.ts', languageId: 'typescript' };
  const context = new ProjectContext({ host });
  const file = await context.viewedFileAttachment();
  assert.equal(file?.path, 'src/index.ts');
  assert.equal(file?.excluded, false);
  assert.match(file?.text ?? '', /export const x = 1;/);

  host.active = { path: '/work/app/.env', languageId: 'plaintext' };
  const secret = await context.viewedFileAttachment();
  assert.equal(secret?.excluded, true);
  assert.equal(secret?.text, undefined);
  assert.equal(host.readPaths.includes('/work/app/.env'), false);
});
