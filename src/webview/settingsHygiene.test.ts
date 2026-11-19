import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Narrow encoding guard for the settings surface only.
 *
 * The settings UI is English copy, so `â`, `Â` and `Ã` followed by a non-ASCII
 * character can only come from UTF-8 bytes decoded as Windows-1252 and
 * re-encoded (double encoding). The guard deliberately covers just the files
 * that render settings: apply it to docs or multilingual text and legitimate
 * accented copy would trip it.
 */

const ROOT = process.cwd();

const SETTINGS_FILES = [
  'src/webview/SettingsScreen.tsx',
  'src/webview/settings/labels.ts',
  'src/webview/settings/constants.ts',
  'src/webview/settings/orchestrationCopy.ts',
  'src/webview/settings/OrchestrationFields.tsx',
  'src/webview/settings/SkillPanel.tsx',
  'src/webview/settings/SaveFooter.tsx',
  'src/webview/settings/primitives.tsx',
  'src/webview/composer/ModelSettingsPanel.tsx'
] as const;

const COPY_FILES = [
  'src/webview/App.tsx',
  'src/webview/state.ts',
  'README.md',
  'docs/usage.md',
  'docs/manual-test.md',
  'docs/settings-audit.md'
] as const;

const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['U+FFFD replacement character', /\uFFFD/],
  ['double-encoded `â€` sequence (intended …, •, —, ’, “ or ”)', /\u00E2\u20AC/],
  ['double-encoded `â†’` sequence (intended →)', /\u00E2\u2020\u2019/],
  ['double-encoded `Â` sequence (intended · or a non-breaking space)', /\u00C2[\u0080-\u00BF]/],
  ['double-encoded `Ã` sequence (intended a Latin-1 letter)', /\u00C3[\u0080-\u00BF]/]
];

function read(relative: string): string {
  return readFileSync(join(ROOT, ...relative.split('/')), 'utf8');
}

function lineNumber(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

test('settings UI sources carry no U+FFFD or double-encoded UTF-8', () => {
  const failures: string[] = [];
  for (const file of SETTINGS_FILES) {
    const source = read(file);
    for (const [label, pattern] of FORBIDDEN) {
      const match = pattern.exec(source);
      if (match) {
        failures.push(`${file}:${lineNumber(source, match.index)} ${label}`);
      }
    }
  }
  assert.deepEqual(failures, [], `settings text is corrupted:\n${failures.join('\n')}`);
});

test('the repaired settings glyphs are still in place', () => {
  const screen = read('src/webview/SettingsScreen.tsx');
  assert.equal(
    (screen.match(/\u2022{16}/g) ?? []).length,
    2,
    'the two masked-key placeholders must render 16 real bullets (U+2022) each'
  );
  assert.equal(
    (screen.match(/Settings \u2192 CLI/g) ?? []).length,
    2,
    'the two `Settings → CLI` hints must use a real arrow (U+2192)'
  );
  assert.match(screen, /'Checking\u2026'/, 'the pending label must use a real ellipsis (U+2026)');
  assert.equal(
    (screen.match(/model\u2019s/g) ?? []).length,
    2,
    'both model default hints must use a real apostrophe (U+2019)'
  );
});

test('user-facing copy and docs carry no double-encoded UTF-8', () => {
  const failures: string[] = [];
  for (const file of COPY_FILES) {
    const source = read(file);
    for (const [label, pattern] of FORBIDDEN) {
      const match = pattern.exec(source);
      if (match) {
        failures.push(`${file}:${lineNumber(source, match.index)} ${label}`);
      }
    }
  }
  assert.deepEqual(failures, [], `copy is corrupted:\n${failures.join('\n')}`);
});
