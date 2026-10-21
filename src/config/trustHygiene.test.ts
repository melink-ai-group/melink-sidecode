import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findEffectiveReads, TRUST_SENSITIVE_KEYS } from './trustReadGuard.ts';

/**
 * Static guards for the trust boundary.
 *
 * The rules themselves are unit-tested in `trust.test.ts`,
 * `executables.test.ts`, `permissionDefault.test.ts` and
 * `packageContract.test.ts`. These guards read the source instead, so a
 * future edit that re-introduces a plain `get()` on a trust-sensitive key
 * fails here even if the helper tests still pass.
 *
 * The guard is `trustReadGuard.ts`, which resolves the *section* a read is
 * scoped to — so the section-relative form
 * `getConfiguration('melink.codex').get('path')` is caught, not just the
 * fully-qualified `get('melink.codex.path')`.
 */

async function source(relative: string): Promise<string> {
  return readFile(join(process.cwd(), 'src', ...relative.split('/')), 'utf8');
}

/** The read sites that must not read a trust-sensitive key directly. */
const TRUST_SENSITIVE_READ_SITES: readonly string[] = [
  'backends/ollama.ts',
  'backends/codex.ts',
  'backends/opencodeBackend.ts',
  'backends/defaults.ts',
  'backends/opencode/resolve.ts',
  'backends/astGrep/resolve.ts',
  'backends/zvecGrep/resolve.ts',
  'skills/resolveForTurn.ts',
  'settings.ts'
];

test('no read site reads a trust-sensitive key with the effective value', async () => {
  for (const file of TRUST_SENSITIVE_READ_SITES) {
    const text = await source(file);
    const reads = findEffectiveReads(text);
    assert.deepEqual(
      reads.map((read) => `${read.key} (${read.form})`),
      [],
      `${file} reads a trust-sensitive key with the effective value`
    );
  }
});

/**
 * The negative control.
 *
 * The guard is only worth something if it rejects the vulnerable form it was
 * written for. The snippets below are synthetic and live only here: they
 * are the shape the guard has to catch, and they must never reach a
 * production source file.
 */
test('the guard rejects a section-relative read of a trust-sensitive key', () => {
  const snippet = [
    "const config = vscode.workspace.getConfiguration('melink.codex');",
    "const path = config.get('path', 'codex');"
  ].join('\n');
  const reads = findEffectiveReads(snippet);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].key, 'melink.codex.path');
});

test('the guard rejects an inline section-relative read', () => {
  const snippet = "const path = vscode.workspace.getConfiguration('melink.codex').get('path', 'codex');";
  const reads = findEffectiveReads(snippet);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].key, 'melink.codex.path');
});

test('the guard rejects a destructured get of a trust-sensitive key', () => {
  const snippet = [
    "const { get } = vscode.workspace.getConfiguration('melink.ollama');",
    "const baseUrl = get('baseUrl', 'https://ollama.com');"
  ].join('\n');
  const reads = findEffectiveReads(snippet);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].key, 'melink.ollama.baseUrl');
});

test('the guard rejects an aliased destructured get of a trust-sensitive key', () => {
  const snippet = [
    "const { get: read } = vscode.workspace.getConfiguration('melink.skills.astGrep');",
    "const cli = read('cliSource', 'local');"
  ].join('\n');
  const reads = findEffectiveReads(snippet);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].key, 'melink.skills.astGrep.cliSource');
});

test('the guard rejects a fully-qualified read of a trust-sensitive key', () => {
  const snippet = "const path = vscode.workspace.getConfiguration().get('melink.codex.path', 'codex');";
  const reads = findEffectiveReads(snippet);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].key, 'melink.codex.path');
});

/**
 * The section does not have to be a string literal.
 *
 * The pre-rework `defaults.ts` read `getConfiguration(DEFAULTS_SECTION).get(
 * 'permissionLevel')`, where the section was a module-level constant. A
 * guard that only understood literals would have missed the exact form it
 * was written for, so the constant form is a negative control too.
 */
test('the guard rejects an inline read through a constant section', () => {
  const snippet = [
    "const CODEX_SECTION = 'melink.codex';",
    "const path = vscode.workspace.getConfiguration(CODEX_SECTION).get('path', 'codex');"
  ].join('\n');
  const reads = findEffectiveReads(snippet);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].key, 'melink.codex.path');
});

test('the guard rejects a bound read through a constant section', () => {
  const snippet = [
    "const CODEX_SECTION = 'melink.codex';",
    'const config = vscode.workspace.getConfiguration(CODEX_SECTION);',
    "const path = config.get('path', 'codex');"
  ].join('\n');
  const reads = findEffectiveReads(snippet);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].key, 'melink.codex.path');
});

test('the guard rejects a destructured get through a constant section', () => {
  const snippet = [
    "const CODEX_SECTION = 'melink.codex';",
    'const { get } = vscode.workspace.getConfiguration(CODEX_SECTION);',
    "const path = get('path', 'codex');"
  ].join('\n');
  const reads = findEffectiveReads(snippet);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].key, 'melink.codex.path');
});

test('the guard rejects a read through a constant built from another constant', () => {
  const snippet = [
    "const ROOT = 'melink.codex';",
    'const CODEX_SECTION = ROOT;',
    "const path = vscode.workspace.getConfiguration(CODEX_SECTION).get('path', 'codex');"
  ].join('\n');
  const reads = findEffectiveReads(snippet);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].key, 'melink.codex.path');
});

test('the guard rejects the pre-rework permission default read', () => {
  const snippet = [
    "const DEFAULTS_SECTION = 'melink.defaults';",
    "const value = vscode.workspace.getConfiguration(DEFAULTS_SECTION).get('permissionLevel', 'default');"
  ].join('\n');
  const reads = findEffectiveReads(snippet);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].key, 'melink.defaults.permissionLevel');
});

test('the guard rejects a read through a template-literal section', () => {
  const snippet = [
    "const CODEX_SECTION = 'melink.codex';",
    'const path = vscode.workspace.getConfiguration(`${CODEX_SECTION}`).get(\'path\', \'codex\');'
  ].join('\n');
  const reads = findEffectiveReads(snippet);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].key, 'melink.codex.path');
});

test('the guard accepts a constant section with an ordinary leaf', () => {
  const snippet = [
    "const CODEX_SECTION = 'melink.codex';",
    "const model = vscode.workspace.getConfiguration(CODEX_SECTION).get('defaultModel', '');"
  ].join('\n');
  assert.deepEqual(findEffectiveReads(snippet), []);
});

test('the guard accepts an unknown constant section', () => {
  // A section the file does not define resolves to nothing, so the read
  // cannot be matched to a trust-sensitive key.
  const snippet = [
    'const SOME_SECTION = otherSection();',
    "const path = vscode.workspace.getConfiguration(SOME_SECTION).get('path', 'codex');"
  ].join('\n');
  assert.deepEqual(findEffectiveReads(snippet), []);
});

test('the guard rejects a template-literal read of a trust-sensitive key', () => {
  const snippet = [
    "const CODEX_SECTION = 'melink.codex';",
    "const path = vscode.workspace.getConfiguration().get(`${CODEX_SECTION}.path`, 'codex');"
  ].join('\n');
  const reads = findEffectiveReads(snippet);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].key, 'melink.codex.path');
});

test('the guard accepts an ordinary read of a non-sensitive key', () => {
  const snippet = [
    "const config = vscode.workspace.getConfiguration('melink.codex');",
    "const model = config.get('defaultModel', '');"
  ].join('\n');
  assert.deepEqual(findEffectiveReads(snippet), []);
});

test('the guard accepts a read of a sensitive leaf in the wrong section', () => {
  const snippet = [
    "const config = vscode.workspace.getConfiguration('melink.opencode');",
    "const model = config.get('defaultModel', '');"
  ].join('\n');
  assert.deepEqual(findEffectiveReads(snippet), []);
});

/**
 * The guard must not flag the trusted readers themselves: they call
 * `inspect()`, which is the whole point.
 */
test('the guard accepts the trusted inspect read', () => {
  const snippet = [
    "const inspected = vscode.workspace.getConfiguration().inspect<string>('melink.ollama.baseUrl');"
  ].join('\n');
  assert.deepEqual(findEffectiveReads(snippet), []);
});

test('the trust-sensitive key list covers every trust-scoped key', async () => {
  const trust = await source('config/trust.ts');
  for (const key of TRUST_SENSITIVE_KEYS) {
    assert.match(trust, new RegExp(`'${key.replace(/\./g, '\\.')}'`), `${key} is not in the trust list`);
  }
});

/**
 * The probe paths.
 *
 * The settings screen probes the configured CLI path to show a status line.
 * The probe runs a child process, so it must apply the same executable rules
 * as the spawn: a relative path with a separator, or a Windows drive-relative
 * path, must never be launched.
 */
test('the settings probes resolve the executable before spawning it', async () => {
  const settings = await source('settings.ts');
  // The two status-line probes resolve first, then spawn the resolved
  // command — never the raw configured value.
  assert.match(settings, /const command = resolveProbedExecutable\(executable, fallback\);/);
  assert.match(settings, /const result = await probeOpencode\(command\);/);
  // The install probes use a resolver-derived executable, which already
  // applies the same rules.
  assert.match(settings, /resolveAstGrepExecutable\(\{ source, path, roots/);
  assert.match(settings, /resolveZvecGrepExecutable\(\{ source, path, roots/);
});

test('the opencode probe resolves the executable before spawning it', async () => {
  const status = await source('backends/opencode/status.ts');
  assert.match(status, /resolveProbedExecutable\(executable, 'opencode'\)/);
  // The resolved command is the only one spawned: the probe launches `exe`,
  // and the upgrade launches the same resolved value.
  assert.match(status, /launch\(exe, \['--version'\]/);
  assert.match(status, /launch\(exe, \['upgrade'\]/);
  // No spawn of a raw, unresolved value.
  assert.equal(
    /spawn\(exe/.test(status),
    false,
    'the probe no longer spawns the resolved command'
  );
});

/**
 * The connection test.
 *
 * The "Test connection" action is the one place a credential leaves the
 * machine on the user's explicit say-so, so it must go through the same
 * client every other request does: the transport seam then observes the exact
 * host that receives the token.
 */
test('the connection test goes through the observable client', async () => {
  const ollama = await source('backends/ollama.ts');
  assert.match(ollama, /this\.client\.probe\('\/api\/tags', token, undefined, \{ timeoutMs \}\)/);
  // No raw fetch: a raw fetch would bypass the transport seam, and with it
  // the only way to observe which host received the credential.
  assert.equal(/\bfetch\(/.test(ollama), false, 'the Ollama adapter uses a raw fetch');
  const client = await source('backends/ollamaBaseUrl.ts');
  assert.match(client, /export async function ollamaProbe\(/);
  assert.match(client, /async probe\(/);
});

/**
 * The skill CLI paths.
 *
 * The zvec-grep and ast-grep paths are spawned the same way the codex and
 * opencode paths are, so a save must apply the same validation: a relative
 * path is refused and never persisted.
 */
test('the settings write plan validates the skill CLI paths before saving them', async () => {
  const plan = await source('settings/planWrites.ts');
  assert.match(plan, /skillCliPathError\(patch\.zvecGrepPath/);
  assert.match(plan, /skillCliPathError\(patch\.astGrepPath/);
  assert.match(plan, /errors\.zvecGrepPath = pathError/);
  assert.match(plan, /errors\.astGrepPath = pathError/);
});

/**
 * The skill toggles write the path too.
 *
 * `setZvecGrep` and `setAstGrep` persist the draft path outside the settings
 * patch, so they need the same validation: a relative path — with a
 * separator, or in the Windows drive-relative form — would name a file inside
 * the repository, so the value is refused and never stored. The refusal is
 * reported on the path field, not only in the result strip.
 */
test('the skill toggles validate the path before persisting it', async () => {
  const settings = await source('settings.ts');
  assert.match(settings, /skillCliPathError\(draft\.path, 'zg', 'zg CLI'\)/);
  assert.match(settings, /skillCliPathError\(draft\.path, 'ast-grep', 'ast-grep CLI'\)/);
  // The refusal names the field it belongs to, so the screen can show it
  // inline on the path input.
  assert.match(settings, /field: 'zvecGrepPath'/);
  assert.match(settings, /field: 'astGrepPath'/);
});

test('the skill toggle refusal reaches the screen on the path field', async () => {
  const view = await source('sidebarView.ts');
  assert.match(view, /applied\.fieldError/);
  const screen = await source('webview/SettingsScreen.tsx');
  assert.match(screen, /zvecGrep\?\.field === 'zvecGrepPath'/);
  assert.match(screen, /astGrep\?\.field === 'astGrepPath'/);
});

test('the trust-sensitive read sites use the trusted reader', async () => {
  const ollama = await source('backends/ollama.ts');
  // Both Ollama profiles read the base URL through the shared profile key and
  // `inspect()`, so Cloud and Local share one trusted rule.
  assert.match(ollama, /inspect<string>\(this\.profile\.baseUrlKey\)/);
  const profiles = await source('backends/ollamaProfile.ts');
  assert.match(profiles, /baseUrlKey: 'melink\.ollama\.baseUrl'/);
  assert.match(profiles, /baseUrlKey: 'melink\.ollamaLocal\.baseUrl'/);
  const codex = await source('backends/codex.ts');
  assert.match(codex, /readTrustedCodexExecutable\(\)/);
  const opencode = await source('backends/opencodeBackend.ts');
  assert.match(opencode, /readTrustedOpencodeCliSource\(\)/);
  assert.match(opencode, /readTrustedOpencodePath\(\)/);
  const defaults = await source('backends/defaults.ts');
  assert.match(defaults, /inspect<string>\(`\$\{DEFAULTS_SECTION\}\.permissionLevel`\)/);
  const skills = await source('skills/resolveForTurn.ts');
  assert.match(skills, /readTrustedZvecGrepPath\(\)/);
  assert.match(skills, /readTrustedAstGrepPath\(\)/);
});

test('the settings service reads the trust-sensitive keys from the trusted reader', async () => {
  const settings = await source('settings.ts');
  assert.match(settings, /readTrustedBaseUrl\(\)/);
  assert.match(settings, /readTrustedOllamaLocalBaseUrl\(\)/);
  assert.match(settings, /readTrustedCodexPath\(\)/);
  assert.match(settings, /readTrustedOpencodeCliSource\(\)/);
  assert.match(settings, /readTrustedOpencodePath\(\)/);
  assert.match(settings, /readTrustedZvecGrepCliSource\(\)/);
  assert.match(settings, /readTrustedAstGrepCliSource\(\)/);
});

test('the settings write plan sends every trust-sensitive write to user settings', async () => {
  const plan = await import('../settings/planWrites.ts');
  const planned = plan.planSettingsWrites(
    {
      ollamaBaseUrl: 'https://ollama.com',
      ollamaLocalBaseUrl: 'http://localhost:11434',
      opencodeCliSource: 'local',
      opencodePath: 'opencode',
      codexPath: 'codex',
      permissionLevel: 'default',
      zvecGrepCliSource: 'local',
      zvecGrepPath: 'zg',
      astGrepCliSource: 'local',
      astGrepPath: 'ast-grep'
    },
    'workspace'
  );
  for (const field of [
    'ollamaBaseUrl',
    'ollamaLocalBaseUrl',
    'opencodeCliSource',
    'opencodePath',
    'codexPath',
    'permissionLevel',
    'zvecGrepCliSource',
    'zvecGrepPath',
    'astGrepCliSource',
    'astGrepPath'
  ] as const) {
    assert.equal(
      planned.writes.find((write) => write.field === field)?.scope,
      'global',
      `${field} is not forced to user settings`
    );
  }
});

test('the approval prefix matching and the opencode sandbox defaults are untouched', async () => {
  // These are separate tickets (T64 items 2 and 3). A guard here makes an
  // accidental change in this area visible.
  const approvals = await source('backends/approvals.ts');
  assert.match(approvals, /export function commandPrefix\(/);
  assert.match(approvals, /export function ruleMatchesRequest\(/);
  const config = await source('backends/opencode/config.ts');
  assert.match(config, /case 'unrestricted':/);
});
