import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Static guards for the copy-truth pass. They read the documents and the empty
 * state, never run the extension, so an old provider claim or stale brand cannot
 * quietly come back.
 */

const ROOT = process.cwd();

async function read(relative: string): Promise<string> {
  return readFile(join(ROOT, ...relative.split('/')), 'utf8');
}

const DOC_FILES = ['README.md', 'docs/usage.md', 'docs/manual-test.md'] as const;

test('docs and the empty state carry no stale provider or brand claims', async () => {
  const entries: Array<[string, string]> = [];
  for (const file of DOC_FILES) {
    entries.push([file, await read(file)]);
  }
  entries.push(['src/webview/App.tsx', await read('src/webview/App.tsx')]);
  entries.push(['src/webview/screens/EmptyState.tsx', await read('src/webview/screens/EmptyState.tsx')]);

  const staleClaims: Array<[RegExp, string]> = [
    [/one of two providers/i, 'one of two providers'],
    [/\btwo providers\b/i, 'two providers'],
    [/(?:reports|offers|advertises|lists)\s+`?agent`?\s+only/i, 'agent only'],
    [/no approval channel/i, 'no approval channel'],
    [/not on a timeout/i, 'not on a timeout'],
    [/nothing is decided for you/i, 'nothing is decided for you'],
    [/auto-rejected/i, 'auto-rejected'],
    [/headless[^\n]*\bask\b/i, 'headless ask'],
    [/asks for every/i, 'asks for every'],
    [/only Codex|Codex and Ollama/i, 'approval picker limited to Codex/Ollama']
  ];

  for (const [file, text] of entries) {
    for (const [pattern, label] of staleClaims) {
      assert.equal(pattern.test(text), false, `${file} still says "${label}"`);
    }
    // Case-sensitive: `melink` package and setting ids are legitimate; only the
    // old display spelling `meLink` is stale.
    assert.equal(/meLink/.test(text), false, `${file} still uses the meLink brand`);
  }
});

test('the empty state renders the SideCode brand', async () => {
  const empty = await read('src/webview/screens/EmptyState.tsx');
  assert.match(empty, /empty-title--brand">SideCode</);
  assert.equal(/>melink</.test(empty), false);
  assert.equal(/melink is working/.test(empty), false);
  const app = await read('src/webview/App.tsx');
  assert.equal(/meLink/.test(app), false);
});

test('the docs describe all four providers and the OpenCode Zen key command', async () => {
  const readme = await read('README.md');
  const usage = await read('docs/usage.md');
  for (const [name, text] of [
    ['README.md', readme],
    ['docs/usage.md', usage]
  ] as const) {
    assert.match(text, /four providers/i, `${name} must name four providers`);
    assert.match(text, /Ollama Local/, `${name} must name Ollama Local`);
    assert.match(text, /OpenCode Zen/, `${name} must name OpenCode Zen`);
    assert.match(text, /melink\.setOpencodeZenToken/, `${name} must document the Zen token command`);
    assert.match(text, /melink\.opencode\.zenToken/, `${name} must document the Zen secret key`);
    assert.match(text, /free models/i, `${name} must say free Zen models need no key`);
  }
  // A missing Zen key only blocks paid models; it does not make Zen an
  // unauthenticated provider in the picker.
});

test('the marketplace description names all four providers', async () => {
  const packageJson = JSON.parse(await read('package.json')) as { description?: string };
  assert.match(packageJson.description ?? '', /Ollama Cloud/);
  assert.match(packageJson.description ?? '', /Ollama Local/);
  assert.match(packageJson.description ?? '', /OpenAI Codex CLI/);
  assert.match(packageJson.description ?? '', /OpenCode Zen/);
});

test('OpenCode Zen stays available without a key and exposes the approval channel', async () => {
  const usage = await read('docs/usage.md');
  assert.match(usage, /missing OpenCode Zen key does not make Zen unauthenticated/i);
  assert.match(usage, /only blocks paid models per turn/i);
  assert.match(usage, /picker is shown for every backend that exposes an approval channel: Codex,\s+OpenCode Zen, Ollama Cloud, and Ollama Local/i);
});

test('the docs state the mode, approval-channel, and timeout behaviour truthfully', async () => {
  const readme = await read('README.md');
  const usage = await read('docs/usage.md');
  assert.match(readme, /`agent`, `plan`, and `ask` on every provider/);
  assert.match(usage, /all three modes/);
  assert.match(readme, /`default` auto-allows edits/);
  assert.match(usage, /`default` auto-allows edits/);
  assert.match(usage, /opencode serve/);
  assert.match(readme, /opencode serve/);
  for (const [name, text] of [
    ['README.md', readme],
    ['docs/usage.md', usage]
  ] as const) {
    assert.match(text, /hasApprovalChannel/, `${name} must name the approval-channel gate`);
    assert.match(text, /120 seconds/, `${name} must state the approval timeout`);
    assert.match(text, /APPROVAL_WAIT_MS|approvalWait\.ts/, `${name} must point at the timeout constant`);
  }
});

test('every contributed configuration key is in the settings audit and the usage audit', async () => {
  const packageJson = JSON.parse(await read('package.json')) as {
    contributes?: {
      configuration?: { properties?: Record<string, unknown> } | Array<{ properties?: Record<string, unknown> }>;
    };
  };
  const configuration = packageJson.contributes?.configuration;
  const sections = Array.isArray(configuration) ? configuration : configuration ? [configuration] : [];
  const keys = sections.flatMap((section) => Object.keys(section.properties ?? {}));

  assert.ok(keys.length >= 29, `expected at least 29 contributed keys, found ${keys.length}`);
  assert.ok(keys.includes('melink.opencode.defaultModel'));
  assert.ok(keys.includes('melink.defaults.dictationModel'));
  assert.ok(keys.includes('melink.skills.zvecGrep.path'));

  const settingsAudit = await read('docs/settings-audit.md');
  const usage = await read('docs/usage.md');
  const auditStart = usage.indexOf('### Audit: every contributed setting and stored credential');
  assert.ok(auditStart >= 0, 'usage.md is missing the settings audit section');
  const nextHeading = usage.indexOf('\n## ', auditStart);
  const usageAudit = usage.slice(auditStart, nextHeading === -1 ? undefined : nextHeading);

  for (const key of keys) {
    assert.ok(settingsAudit.includes(`\`${key}\``), `settings-audit.md is missing ${key}`);
    assert.ok(usageAudit.includes(`\`${key}\``), `usage.md audit table is missing ${key}`);
  }
});

test('both secrets are audited with a screen location and a consumer', async () => {
  const settingsAudit = await read('docs/settings-audit.md');
  const usage = await read('docs/usage.md');
  const auditStart = usage.indexOf('### Audit: every contributed setting and stored credential');
  const nextHeading = usage.indexOf('\n## ', auditStart);
  const usageAudit = usage.slice(auditStart, nextHeading === -1 ? undefined : nextHeading);

  for (const secret of ['melink.ollama.token', 'melink.opencode.zenToken']) {
    for (const [name, text] of [
      ['docs/settings-audit.md', settingsAudit],
      ['docs/usage.md', usageAudit]
    ] as const) {
      const line = text.split('\n').find((entry) => entry.includes(secret));
      assert.ok(line, `${name} is missing ${secret}`);
      assert.match(line as string, /Providers/, `${name} has no screen location for ${secret}`);
      assert.match(line as string, /SecretStorage/, `${name} has no consumer/store for ${secret}`);
    }
  }
});
