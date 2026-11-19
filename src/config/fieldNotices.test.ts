import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  TRUST_SENSITIVE_FIELDS,
  TRUST_SENSITIVE_FIELD_KEYS,
  noticeForField,
  trustSensitiveNotice
} from './fieldNotices.ts';
import { TRUST_SCOPED_KEYS } from './trust.ts';
import { planSettingsWrites } from '../settings/planWrites.ts';

/**
 * The scope notices on the trust-sensitive fields.
 *
 * Ten fields decide where a credential or prompt is sent, which binary is
 * spawned, or what the permission default is. They are read from the user's
 * own settings only, so a "Save to workspace" writes them to the user settings
 * instead. The value *is* persisted, so the screen shows a notice rather than an
 * error — but the notice has to appear on every one of the ten. A field
 * that silently saved somewhere else than the button said is a lie.
 */

test('the notice table covers exactly the ten trust-sensitive fields', () => {
  assert.equal(TRUST_SENSITIVE_FIELDS.length, 10);
  assert.deepEqual([...TRUST_SENSITIVE_FIELDS].sort(), [
    'astGrepCliSource',
    'astGrepPath',
    'codexPath',
    'ollamaBaseUrl',
    'ollamaLocalBaseUrl',
    'opencodeCliSource',
    'opencodePath',
    'permissionLevel',
    'zvecGrepCliSource',
    'zvecGrepPath'
  ]);
});

test('every trust-sensitive field maps to a trust-scoped key', () => {
  const mapped = Object.values(TRUST_SENSITIVE_FIELD_KEYS);
  assert.equal(mapped.length, 10);
  for (const key of mapped) {
    assert.equal(TRUST_SCOPED_KEYS.includes(key), true, key);
  }
  // The mapping and the trust-scoped list agree, except for the two skill
  // enable flags: they decide whether a binary-spawning skill runs, but they
  // are toggled (not part of the settings patch), so they have no field notice.
  const extras = TRUST_SCOPED_KEYS.filter((key) => !mapped.includes(key));
  assert.deepEqual([...extras].sort(), ['melink.skills.astGrep', 'melink.skills.zvecGrep']);
});

test('the host notice is shown verbatim on a redirected field', () => {
  assert.equal(
    noticeForField('codexPath', { codexPath: 'Saved to your user settings.' }),
    'Saved to your user settings.'
  );
});

test('a field the host did not redirect has no notice', () => {
  assert.equal(noticeForField('codexPath', {}), undefined);
  assert.equal(noticeForField('codexPath', undefined), undefined);
  assert.equal(noticeForField('contextMaxBytes', { contextMaxBytes: 'x' }), 'x');
});

test('every trust-sensitive field has a notice for a workspace save', () => {
  for (const field of TRUST_SENSITIVE_FIELDS) {
    const notice = trustSensitiveNotice(field);
    assert.ok(notice, field);
    assert.match(notice, /user settings/);
  }
});

/**
 * The screen must actually render the notice for each of the ten fields.
 *
 * A pure-logic test proves the wording exists; this reads the screen source
 * to prove every field renders one, so a field that is redirected but shows
 * nothing fails here. The screen reads the host's map through one accessor,
 * `noticeFor('<field>')`, so the field name must appear there.
 */
test('the screen renders a notice for every trust-sensitive field', async () => {
  const text = await readFile(join(process.cwd(), 'src', 'webview', 'SettingsScreen.tsx'), 'utf8');
  assert.match(text, /noticeForField\(/, 'the screen does not read the host notice map');
  for (const field of TRUST_SENSITIVE_FIELDS) {
    assert.match(
      text,
      new RegExp(`noticeFor\\('${field}'\\)`),
      `the screen renders no notice for ${field}`
    );
  }
});

/**
 * The host must produce a notice for each of the ten, so the screen has
 * something truthful to show.
 */
test('the write plan produces a notice for every trust-sensitive field', () => {
  const plan = planSettingsWrites(
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
  for (const field of TRUST_SENSITIVE_FIELDS) {
    assert.equal(
      plan.writes.find((write) => write.field === field)?.scope,
      'global',
      `${field} was not redirected to user settings`
    );
    assert.ok(plan.notices[field], `the write plan produces no notice for ${field}`);
  }
});

/**
 * A path field always has help text.
 *
 * The opencode path field shows an error, a notice, or nothing. The last
 * case used to render an empty branch, so the field lost its explanation
 * exactly when the user most needed one. The help paragraph is now outside
 * the branch, so the field always says what the value means.
 */
test('the opencode path field always renders its help text', async () => {
  const text = await readFile(join(process.cwd(), 'src', 'webview', 'SettingsScreen.tsx'), 'utf8');
  assert.match(text, /id="opencode-path-help"/);
  // The help paragraph sits after the error/notice branches, so it is
  // rendered in every branch rather than only in the empty one.
  const helpIndex = text.indexOf('id="opencode-path-help"');
  const noticeIndex = text.indexOf('id="opencode-path-notice"');
  assert.ok(noticeIndex > 0, 'the opencode path field has no notice branch');
  assert.ok(helpIndex > noticeIndex, 'the help text is not rendered after the notice branch');
  // The input points at the help text, so a screen reader reads it too.
  assert.match(text, /'opencode-path-help opencode-status'/);
});

