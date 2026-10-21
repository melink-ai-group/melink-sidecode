#!/usr/bin/env node
/*
 * Style hygiene gate: the webview stylesheet must not contain literal hex
 * colors, and the brand tokens must be mirrored in the design system.
 *
 * `src/webview/styles.css` imports `../../tokens.css`, so the repo-root file is
 * the source of truth for this project. A `src/webview/tokens.css` is honoured
 * instead when present, so the ticket's original layout keeps working.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stylesPath = path.join(root, 'src', 'webview', 'styles.css');
const localTokens = path.join(root, 'src', 'webview', 'tokens.css');
const rootTokens = path.join(root, 'tokens.css');
const tokenSource = existsSync(localTokens) ? localTokens : rootTokens;
const tokenMirror = path.join(root, 'design-systems', 'melink', 'tokens.css');

const requiredTokens = [
  '--melink-on-accent',
  '--melink-on-primary',
  '--melink-scrim',
  '--melink-mask'
];

const hexPattern = /#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/g;
const relative = (file) => path.relative(root, file) || file;

const failures = [];

if (!existsSync(stylesPath)) {
  failures.push(`${relative(stylesPath)}: file not found`);
} else {
  const lines = readFileSync(stylesPath, 'utf8').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(hexPattern)) {
      failures.push(`${relative(stylesPath)}:${index + 1}: hex color ${match[0]}`);
    }
  }
}

for (const file of [tokenSource, tokenMirror]) {
  if (!existsSync(file)) {
    failures.push(`${relative(file)}: token file not found`);
    continue;
  }
  const source = readFileSync(file, 'utf8');
  for (const token of requiredTokens) {
    if (!new RegExp(`${token}\\s*:`).test(source)) {
      failures.push(`${relative(file)}: missing ${token}`);
    }
  }
}

if (existsSync(tokenSource) && existsSync(tokenMirror)) {
  const source = readFileSync(tokenSource);
  const mirror = readFileSync(tokenMirror);
  if (!source.equals(mirror)) {
    failures.push(
      `${relative(tokenSource)} and ${relative(tokenMirror)} are not byte-identical; mirror the source of truth verbatim`
    );
  }
}

if (failures.length > 0) {
  console.error('check:hex failed');
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `check:hex OK — 0 hex literals in ${relative(stylesPath)}; ${requiredTokens.join(', ')} present and mirrored in ${relative(tokenMirror)}`
  );
}
