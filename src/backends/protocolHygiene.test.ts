import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Static guards for the Codex app-server fix. These read the source rather than
 * run it, so they hold for every code path: the app must never blind-probe an
 * experimental feature list (which has crashed the upstream app-server), and the
 * teardown path must remain present so no `codex` child outlives `deactivate`.
 */

async function source(relative: string): Promise<string> {
  return readFile(join(process.cwd(), 'src', ...relative.split('/')), 'utf8');
}

test('the adapter never calls experimentalFeature/list or an enablement set', async () => {
  const connection = await source('backends/appserver/connection.ts');
  const codex = await source('backends/codex.ts');
  const combined = `${connection}\n${codex}`;
  assert.equal(/experimentalFeature\/list/.test(combined), false);
  assert.equal(/experimentalFeature\/enablement\/set/.test(combined), false);
  // The only experimental surface opted into is the documented initialize
  // capability flag, which is part of the handshake, not a feature probe.
  assert.match(connection, /experimentalApi: true/);
});

test('the pinned protocol version is the one the schemas were generated from', async () => {
  const version = await source('backends/appserver/version.ts');
  assert.match(version, /PINNED_CODEX_VERSION = '0\.156\.1'/);
});

test('teardown still walks the process tree so no orphan survives deactivate', async () => {
  const connection = await source('backends/appserver/connection.ts');
  // A failed spawn attempt is stopped before the next form, and the process
  // tree is killed rather than only the direct child.
  assert.match(connection, /stopChildIfCurrent/);
  assert.match(connection, /killProcessTree/);
  assert.match(connection, /taskkill/);
});

test('the docs pin the regenerated version', async () => {
  const readme = await source('../README.md');
  const usage = await source('../docs/usage.md');
  assert.match(readme, /codex-cli 0\.156\.1/);
  assert.match(readme, /codex app-server generate-ts --out \.\/schemas/);
  assert.match(usage, /0\.156\.1/);
});
