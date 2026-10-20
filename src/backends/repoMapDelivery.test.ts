import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Static guards for the provider-neutral repo-map delivery. The prompt builders
 * in the two OpenCode paths live inside modules that import `vscode`, so they
 * cannot be loaded by `node --test`; this asserts the same source shape the
 * runtime and the other prompt tests cover.
 */

async function source(relative: string): Promise<string> {
  return readFile(join(process.cwd(), 'src', ...relative.split('/')), 'utf8');
}

test('both ollama paths include the repo map next to the per-turn delta', async () => {
  const text = await source('backends/ollama.ts');
  // Direct /api/chat goes through the shared message builder.
  assert.match(text, /buildContextMessages\(history, text, context\)/);
  // The nested OpenCode runtime primes the turn text and includes the map.
  assert.match(text, /block, context\?\.repoMap, context\?\.attachedFile, request\.text/);
});

test('the opencode provider prompt includes the repo map next to the delta', async () => {
  const text = await source('backends/opencodeBackend.ts');
  assert.match(text, /block, context\?\.repoMap, context\?\.attachedFile, request\.text/);
});

test('the context host reads every repo-map setting and clamps its count', async () => {
  const text = await source('context/vscodeHost.ts');
  for (const key of [
    'repoMap',
    'repoMapMaxFiles',
    'repoMapMaxBytes',
    'repoMapBuildMs',
    'repoMapMaxChars'
  ]) {
    assert.match(text, new RegExp(`section\\.get<[^>]+>\\('${key}'`));
  }
  assert.match(text, /function clampCount/);
});

test('the delivery layer builds only through the snapshot reads seam', async () => {
  const text = await source('context/delivery.ts');
  assert.match(text, /this\.reads\.readFileStrict \?\? this\.reads\.readFile/);
  assert.match(text, /buildRepoMap\(/);
  assert.match(text, /queryRepoMap\(/);
  assert.equal(/\breaddir\b|\breadFileSync\b/.test(text), false);
  assert.equal(/\bfrom\s+['"]vscode['"]/.test(text), false);

  // The map core itself stays host-free: no editor, filesystem or network API.
  const map = await source('context/repoMap.ts');
  assert.equal(/\bfrom\s+['"]vscode['"]/.test(map), false);
  assert.equal(/\bfrom\s+['"]node:(?:fs|net|http|https|tls|dns)['"]/.test(map), false);
  assert.equal(/\brequire\s*\(\s*['"](?:vscode|node:fs|fs|node:net|net)/.test(map), false);
  assert.equal(/\bfetch\s*\(/.test(map), false);

  // Snapshot reads stay tolerant, while the strict read seam rethrows.
  const host = await source('context/vscodeHost.ts');
  assert.match(host, /function isMissingFile/);
  assert.match(host, /async readFile\(path: string\)[\s\S]*?catch \{\s*\/\/[\s\S]*?return undefined;\s*\}/);
  assert.match(host, /async readFileStrict\(path: string\)[\s\S]*?if \(isMissingFile\(error\)\) \{\s*return undefined;\s*\}[\s\S]*?throw error;/);
});
