import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const stylesPath = join(root, 'src', 'webview', 'styles.css');
const tokenSourcePath = join(root, 'tokens.css');
const tokenMirrorPath = join(root, 'design-systems', 'melink', 'tokens.css');

const requiredTokens: Record<string, string> = {
  '--melink-on-accent': '#1A1604',
  '--melink-on-primary': '#FFFFFF',
  '--melink-scrim': '#000000',
  '--melink-mask': '#000000'
};

function tokenValue(css: string, token: string): string | undefined {
  const match = css.match(new RegExp(`${token}\\s*:\\s*([^;]+);`));
  return match?.[1]?.trim();
}

test('styles.css has no literal hex colors or hex fallbacks', () => {
  const css = readFileSync(stylesPath, 'utf8');
  const hexes = [...css.matchAll(/#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/g)].map((match) => match[0]);
  assert.deepEqual(hexes, [], `literal hex colors found: ${hexes.join(', ')}`);
  assert.doesNotMatch(css, /var\([^)]*#[0-9a-fA-F]{3,8}/, 'hex color used as a var() fallback');
});

test('brand tokens are identical in the repo and the design system', () => {
  assert.ok(
    readFileSync(tokenSourcePath).equals(readFileSync(tokenMirrorPath)),
    'tokens.css must be mirrored verbatim in design-systems/melink/tokens.css'
  );
});

test('neutral on-color, scrim, and mask tokens exist with their expected values', () => {
  for (const file of [tokenSourcePath, tokenMirrorPath]) {
    const css = readFileSync(file, 'utf8');
    for (const [token, value] of Object.entries(requiredTokens)) {
      assert.equal(tokenValue(css, token), value, `${token} in ${file}`);
    }
  }
});

test('existing brand hues are unchanged', () => {
  const css = readFileSync(tokenSourcePath, 'utf8');
  assert.equal(tokenValue(css, '--melink-shell'), '#019ACE');
  assert.equal(tokenValue(css, '--melink-primary'), '#006F8F');
  assert.equal(tokenValue(css, '--melink-yellow'), '#F5C518');
});

test('npm run check:hex passes', () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-no-hex.mjs')], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /check:hex OK/);
});
