import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Static guards for the optional opencode runtime. These read the source rather
 * than run it, so they hold for every code path and are cheap.
 */

async function source(relative: string): Promise<string> {
  return readFile(join(process.cwd(), 'src', ...relative.split('/')), 'utf8');
}

test('the config module never writes a file, logs, or touches the host', async () => {
  const text = await source('backends/opencode/config.ts');
  assert.equal(/\bfrom\s+['"]vscode['"]/.test(text), false);
  assert.equal(/\bnode:fs\b/.test(text), false);
  assert.equal(/\bwriteFile\b/.test(text), false);
  assert.equal(/\bappendFile\b/.test(text), false);
  assert.equal(/\bconsole\./.test(text), false);
  assert.equal(/\boutputChannel\b/i.test(text), false);
  // Only the credential variable's name appears, and no `apiKey` field is set
  // to a template or a value; opencode reads the variable from the child env.
  assert.match(text, /env: \[apiKeyEnv\]/);
  assert.equal(/\bapiKey\s*:/.test(text), false);
});

test('the runtime hands the credential over only through the child environment', async () => {
  const text = await source('backends/opencode/runtime.ts');
  assert.equal(/\bfrom\s+['"]vscode['"]/.test(text), false);
  assert.equal(/\bwriteFile\b/.test(text), false);
  // The generated config travels on OPENCODE_CONFIG_CONTENT, never on disk.
  assert.match(text, /OPENCODE_CONFIG_ENV\]/);
  // The token is placed in the child env under apiKeyEnv (default OLLAMA_API_KEY).
  assert.match(text, /\[apiKeyEnv\]: options\.token/);
  assert.match(text, /DEFAULT_OPENCODE_API_KEY_ENV/);
  assert.match(text, /configContainsSecret/);
  // No raw stderr or console is ever emitted.
  assert.equal(/\bconsole\./.test(text), false);
});

test('the registry registers the OpenCode Zen backend', async () => {
  const text = await source('backends/registry.ts');
  assert.match(text, /OpencodeBackend/);
  assert.match(text, /new OpencodeBackend\(/);
});

test('the ollama adapter runs every turn through the opencode runtime', async () => {
  const text = await source('backends/ollama.ts');
  // No static value import of the runtime: it is loaded per turn.
  assert.equal(/import\s+[^;]*runOpencodeTurn[^;]*from\s+['"]\.\/opencode\/runtime['"]/.test(text), false);
  assert.match(text, /await import\('\.\/opencode\/runtime\.ts'\)/);
  assert.match(text, /await import\('\.\/opencode\/config\.ts'\)/);
  // There is no toggle: the only turn path calls sendOpencodeTurn.
  assert.equal(text.includes('opencodeEnabled'), false);
  assert.match(text, /await this\.sendOpencodeTurn\(handle, request, token\);/);
});

test('the README and usage docs cover the shared OpenCode runtime', async () => {
  const readme = await source('../README.md');
  assert.match(readme, /Shared OpenCode runtime/);
  assert.match(readme, /no direct turn fallback/i);
  const usage = await source('../docs/usage.md');
  assert.match(usage, /Shared OpenCode runtime/);
  // The old opt-in key is gone from the docs and the manual script.
  for (const [name, text] of [
    ['README.md', readme],
    ['docs/usage.md', usage],
    ['docs/manual-test.md', await source('../docs/manual-test.md')]
  ] as const) {
    assert.equal(/melink\.ollama\.opencode\.enabled/.test(text), false, `${name} still names the removed key`);
  }
});
