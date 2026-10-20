import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildRepoMap,
  extractImports,
  extractSymbols,
  isSourcePath,
  queryRepoMap,
  renderRepoMap,
  DEFAULT_REPO_MAP_CAPS,
  REPO_MAP_DISABLED,
  REPO_MAP_EMPTY,
  REPO_MAP_FAILED,
  REPO_MAP_UNAVAILABLE,
  type RepoMapIndex
} from './repoMap.ts';
import { DEFAULT_CONTEXT_SETTINGS } from './contextSettings.ts';

const CAPS = {
  maxFiles: 50,
  maxBytes: 100_000,
  maxBuildMs: 5_000,
  maxSymbols: 100,
  maxResults: 10,
  maxChars: 2_000
};

function reads(files: Record<string, string>): (path: string) => Promise<string | undefined> {
  return async (path) => files[path.replace(/^\/work\/app\//, '')];
}

const BASIC_FILES: Record<string, string> = {
  'src/index.ts':
    "import { helper } from './util';\nexport function main() {\n  helper();\n}\nexport const value = 1;\n",
  'src/util.ts': 'export function helper() {}\nclass Widget {}\n',
  'README.md': '# App\n',
  'package-lock.json': '{"lockfileVersion": 3}'
};

function makeIndex(entries: RepoMapIndex['entries']): RepoMapIndex {
  return {
    status: 'ok',
    marker: '',
    entries,
    filesScanned: entries.length,
    bytesRead: 100,
    symbolCount: entries.reduce((sum, entry) => sum + entry.symbols.length, 0),
    buildMs: 1
  };
}

test('the map parses definitions and imports from source files only', async () => {
  const index = await buildRepoMap({
    root: '/work/app',
    files: Object.keys(BASIC_FILES),
    readFile: reads(BASIC_FILES),
    caps: CAPS
  });
  assert.equal(index.status, 'ok');
  assert.deepEqual(index.entries.map((entry) => entry.path), ['src/index.ts', 'src/util.ts']);
  const indexEntry = index.entries.find((entry) => entry.path === 'src/index.ts');
  assert.ok(indexEntry?.symbols.includes('main'));
  assert.ok(indexEntry?.symbols.includes('value'));
  assert.deepEqual(indexEntry?.imports, ['./util']);
  assert.ok(index.entries.find((entry) => entry.path === 'src/util.ts')?.symbols.includes('Widget'));
  assert.equal(index.filesScanned, 2);
  assert.equal(isSourcePath('src/app.tsx'), true);
  assert.equal(isSourcePath('README.md'), false);
  assert.equal(isSourcePath('package-lock.json'), false);
});

test('extractors are static, deduplicated and bounded per file', () => {
  const symbols = extractSymbols('export function alpha() {}\nfunction alpha() {}\nclass Beta {}\ndef gamma(x):\n  pass');
  assert.deepEqual(symbols, ['alpha', 'Beta', 'gamma']);
  const imports = extractImports("import x from 'a';\nconst y = require('b');\nfrom pkg import thing\n#include <stdio.h>");
  assert.deepEqual(imports, ['a', 'b', 'pkg', 'stdio.h']);
});

test('the file cap stops deterministically and marks the map limited', async () => {
  const index = await buildRepoMap({
    root: '/work/app',
    files: Object.keys(BASIC_FILES),
    readFile: reads(BASIC_FILES),
    caps: { ...CAPS, maxFiles: 1 }
  });
  assert.equal(index.status, 'limited');
  assert.equal(index.entries.length, 1);
  assert.match(index.marker, /Repo map: limited/);
  assert.match(index.marker, /files=1/);
});

test('the byte cap stops before exceeding its budget', async () => {
  const index = await buildRepoMap({
    root: '/work/app',
    files: Object.keys(BASIC_FILES),
    readFile: reads(BASIC_FILES),
    caps: { ...CAPS, maxBytes: 10 }
  });
  assert.equal(index.status, 'limited');
  assert.equal(index.bytesRead, 0);
  assert.equal(index.entries.length, 0);
  assert.match(index.marker, /bytes=10/);
});

test('the time cap stops before the first read when the budget is spent', async () => {
  let clock = 0;
  const index = await buildRepoMap({
    root: '/work/app',
    files: Object.keys(BASIC_FILES),
    readFile: reads(BASIC_FILES),
    caps: { ...CAPS, maxBuildMs: 50 },
    now: () => {
      const value = clock;
      clock += 100;
      return value;
    }
  });
  assert.equal(index.status, 'limited');
  assert.equal(index.entries.length, 0);
  assert.match(index.marker, /ms=50/);
});

test('the symbol cap is global and marks the map limited', async () => {
  const index = await buildRepoMap({
    root: '/work/app',
    files: ['src/a.ts', 'src/b.ts'],
    readFile: reads({
      'src/a.ts': 'export const one = 1;\nexport const two = 2;',
      'src/b.ts': 'export const three = 3;'
    }),
    caps: { ...CAPS, maxSymbols: 2 }
  });
  assert.equal(index.status, 'limited');
  assert.equal(index.symbolCount, 2);
  assert.equal(index.entries.length, 1);
  assert.match(index.marker, /symbols=2/);
});

test('a file over the per-file symbol cap is truncated but later files are still indexed', async () => {
  const large = Array.from({ length: 45 }, (_, i) => `export const sym${i} = ${i};`).join('\n');
  const index = await buildRepoMap({
    root: '/work/app',
    files: ['src/a.ts', 'src/b.ts'],
    readFile: reads({
      'src/a.ts': large,
      'src/b.ts': 'export function later() {}'
    }),
    caps: { ...CAPS, maxSymbols: 100 }
  });
  assert.equal(index.status, 'limited');
  assert.equal(index.entries.find((entry) => entry.path === 'src/a.ts')?.symbols.length, 40);
  assert.ok(index.entries.find((entry) => entry.path === 'src/b.ts')?.symbols.includes('later'));
  assert.equal(index.filesScanned, 2);
});

test('a complete build that exactly reaches maxSymbols with nothing omitted is ok', async () => {
  const index = await buildRepoMap({
    root: '/work/app',
    files: ['src/a.ts', 'src/b.ts'],
    readFile: reads({
      'src/a.ts': 'export const a1 = 1;\nexport const a2 = 2;\nexport const a3 = 3;',
      'src/b.ts': 'export const b1 = 1;\nexport const b2 = 2;'
    }),
    caps: { ...CAPS, maxSymbols: 5 }
  });
  assert.equal(index.status, 'ok');
  assert.equal(index.symbolCount, 5);
  assert.equal(index.entries.length, 2);
});

test('a never-resolving read times out instead of hanging the turn', async () => {
  const index = await buildRepoMap({
    root: '/work/app',
    files: ['src/index.ts'],
    // The promise never settles; the per-read timeout must win.
    readFile: () => new Promise<string | undefined>(() => {}),
    caps: { ...CAPS, maxBuildMs: 500 }
  });
  assert.equal(index.status, 'limited');
  assert.match(index.marker, /limited/);
});

test('a thrown read becomes failed, never an exception', async () => {
  const index = await buildRepoMap({
    root: '/work/app',
    files: ['src/index.ts'],
    readFile: async () => {
      throw new Error('boom');
    },
    caps: CAPS
  });
  assert.equal(index.status, 'failed');
  assert.equal(index.marker, REPO_MAP_FAILED);
});

test('an absent read seam is explicitly unavailable', async () => {
  const index = await buildRepoMap({ root: '/work/app', files: ['src/index.ts'] });
  assert.equal(index.status, 'unavailable');
  assert.equal(index.marker, REPO_MAP_UNAVAILABLE);
});

test('query ranks definitions, then importers and related files', async () => {
  const index = makeIndex([
    { path: 'src/auth.ts', symbols: ['login', 'logout'], imports: ['./session'] },
    { path: 'src/session.ts', symbols: ['createSession'], imports: [] },
    { path: 'src/app.ts', symbols: ['main'], imports: ['./auth'] }
  ]);

  const byDefinition = queryRepoMap(index, 'implement login', [], CAPS);
  assert.match(byDefinition.text.split('\n')[0], /src\/auth\.ts: login, logout/);
  assert.match(byDefinition.text, /src\/app\.ts/);

  const related = queryRepoMap(index, 'createSession', [], CAPS);
  assert.match(related.text.split('\n')[0], /src\/session\.ts/);

  const dirty = queryRepoMap(index, '', ['src/app.ts'], CAPS);
  assert.match(dirty.text.split('\n')[0], /src\/app\.ts/);

  const capped = queryRepoMap(
    index,
    '',
    ['src/auth.ts', 'src/session.ts', 'src/app.ts'],
    { ...CAPS, maxResults: 1 }
  );
  assert.equal(capped.text.split('\n').length, 1);
  assert.match(capped.text, /src\/app\.ts/);
});

test('an unmatched request is an explicit empty marker', () => {
  const index = makeIndex([{ path: 'src/app.ts', symbols: ['main'], imports: [] }]);
  const result = queryRepoMap(index, 'quantum flux', [], CAPS);
  assert.equal(result.text, REPO_MAP_EMPTY);
  assert.equal(queryRepoMap(index, '', [], CAPS).text, REPO_MAP_EMPTY);
});

test('render keeps markers and respects the character cap', () => {
  const limited: RepoMapIndex = {
    ...makeIndex([
      { path: 'src/avery-long-file-name.ts', symbols: ['one', 'two', 'three'], imports: ['./x'] },
      { path: 'src/another-long-file-name.ts', symbols: ['four'], imports: ['./y'] }
    ]),
    status: 'limited',
    marker: 'Repo map: limited (test).'
  };
  const text = renderRepoMap(
    limited,
    limited.entries.map((entry) => `${entry.path}: ${entry.symbols.join(', ')}`),
    { ...CAPS, maxChars: 50 }
  );
  assert.match(text, /^Repo map: limited/);
  assert.equal(text.length <= 50, true);
  assert.equal(text.endsWith('…'), true);

  const disabled = { ...makeIndex([]), status: 'disabled' as const, marker: REPO_MAP_DISABLED };
  assert.equal(renderRepoMap(disabled), REPO_MAP_DISABLED);
  const empty = makeIndex([]);
  assert.match(renderRepoMap(empty), /no source files found/);
});

test('the map defaults are documented and the settings stay off by default', async () => {
  assert.equal(DEFAULT_CONTEXT_SETTINGS.repoMap, false);
  assert.equal(DEFAULT_CONTEXT_SETTINGS.repoMapMaxFiles, DEFAULT_REPO_MAP_CAPS.maxFiles);
  assert.equal(DEFAULT_CONTEXT_SETTINGS.repoMapMaxBytes, DEFAULT_REPO_MAP_CAPS.maxBytes);
  assert.equal(DEFAULT_CONTEXT_SETTINGS.repoMapBuildMs, DEFAULT_REPO_MAP_CAPS.maxBuildMs);
  assert.equal(DEFAULT_CONTEXT_SETTINGS.repoMapMaxChars, DEFAULT_REPO_MAP_CAPS.maxChars);

  const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
  };
  const properties = pkg.contributes.configuration.properties;
  assert.equal(properties['melink.context.repoMap'].default, false);
  assert.equal(properties['melink.context.repoMapMaxFiles'].default, DEFAULT_REPO_MAP_CAPS.maxFiles);
  assert.equal(properties['melink.context.repoMapMaxBytes'].default, DEFAULT_REPO_MAP_CAPS.maxBytes);
  assert.equal(properties['melink.context.repoMapBuildMs'].default, DEFAULT_REPO_MAP_CAPS.maxBuildMs);
  assert.equal(properties['melink.context.repoMapMaxChars'].default, DEFAULT_REPO_MAP_CAPS.maxChars);
});
