import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  requireWorkspaceRoot,
  sanitizeScreenshotPart,
  saveScreenshot,
  screenshotBaseName,
  screenshotDirectory,
  screenshotTimestamp
} from './screenshots.ts';

test('screenshot names use the title or the URL host without queries or tokens', () => {
  assert.equal(sanitizeScreenshotPart('  Hello, World!  '), 'hello-world');
  assert.equal(sanitizeScreenshotPart('Café / Menu'), 'cafe-menu');
  assert.equal(screenshotBaseName('Login page', 'https://example.com/app?token=SECRET'), 'login-page');
  assert.equal(screenshotBaseName('https://example.com/a?token=SECRET#frag', 'http://other'), 'https-example-com-a');
  assert.equal(screenshotBaseName('', 'https://example.com/app?token=SECRET'), 'example-com');
  assert.equal(screenshotBaseName('', 'not a url'), 'screenshot');
  assert.doesNotMatch(screenshotBaseName('', 'https://example.com/app?token=SECRET'), /secret/i);
});

test('the timestamp is sortable and Windows-safe', () => {
  const stamp = screenshotTimestamp(new Date(2026, 9, 21, 12, 34, 56, 789));
  assert.equal(stamp, '20261021-123456-789');
  assert.doesNotMatch(stamp, /[:/\\]/);
});

test('saveScreenshot creates the gitignored directory and writes unique png files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'melink-shots-'));
  try {
    const now = new Date(2026, 9, 21, 12, 34, 56, 789);
    const first = await saveScreenshot(
      root,
      Buffer.from('png-one').toString('base64'),
      'Login page',
      'https://example.com/app?token=SECRET',
      now
    );
    const second = await saveScreenshot(
      root,
      Buffer.from('png-two').toString('base64'),
      'Login page',
      'https://example.com/app?token=SECRET',
      now
    );

    const directory = screenshotDirectory(root);
    assert.equal(directory, join(root, '.melink', 'reports', 'browser'));
    assert.equal(first, join(directory, '20261021-123456-789-001-login-page.png'));
    assert.equal(second, join(directory, '20261021-123456-789-002-login-page.png'));
    assert.notEqual(first, second);
    assert.doesNotMatch(first, /secret|token/i);
    assert.equal(await readFile(first, 'utf8'), 'png-one');
    assert.equal(await readFile(second, 'utf8'), 'png-two');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('saveScreenshot creates nested parent directories on demand', async () => {
  const root = await mkdtemp(join(tmpdir(), 'melink-shots-nested-'));
  try {
    const nested = join(root, 'a', 'b', 'workspace');
    const path = await saveScreenshot(nested, Buffer.from('bytes').toString('base64'), '', '');
    assert.ok(path.startsWith(screenshotDirectory(nested)));
    assert.equal(await readFile(path, 'utf8'), 'bytes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing workspace root gives the exact screenshot error', () => {
  assert.equal(requireWorkspaceRoot('/work/project'), '/work/project');
  assert.throws(
    () => requireWorkspaceRoot(undefined),
    /^Error: No workspace folder is open, so the screenshot cannot be saved\.$/
  );
  assert.throws(
    () => requireWorkspaceRoot(''),
    /^Error: No workspace folder is open, so the screenshot cannot be saved\.$/
  );
});
