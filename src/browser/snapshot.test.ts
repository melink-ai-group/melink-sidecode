import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_WORKSPACE_SCREENSHOT_NOTE, saveSnapshotPng, type SavedSnapshot } from './snapshot.ts';
import { runBrowserTool, type BrowserActions } from './tools.ts';

const shot = { pngBase64: Buffer.from('png').toString('base64'), title: 'Login page', url: 'https://example.com/' };

test('a snapshot without a workspace folder keeps the image and explains why no path exists', async () => {
  const saved = await saveSnapshotPng(undefined, shot);
  assert.equal(saved.path, undefined);
  assert.equal(saved.note, NO_WORKSPACE_SCREENSHOT_NOTE);

  const result = await runBrowserTool(
    snapshotActions({ text: 'button "Save"', pngBase64: shot.pngBase64, url: shot.url, title: shot.title, ...saved }),
    'browser_snapshot',
    {},
    async () => 'deny',
    new Set()
  );
  assert.equal(result.isError, undefined);
  assert.equal(result.content[1]?.type, 'image');
  assert.equal(result.content[1]?.data, shot.pngBase64);
  const text = result.content[0]?.text ?? '';
  assert.match(text, /button "Save"/);
  assert.doesNotMatch(text, /Screenshot saved/);
  assert.ok(text.includes(NO_WORKSPACE_SCREENSHOT_NOTE));
});

test('a snapshot with a workspace folder still writes a PNG', async () => {
  const root = await mkdtemp(join(tmpdir(), 'melink-snapshot-'));
  try {
    const saved = await saveSnapshotPng(root, shot);
    assert.ok(saved.path);
    assert.match(saved.path ?? '', /\.melink[\\/]reports[\\/]browser[\\/].*login-page\.png$/);
    assert.equal(saved.note, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function snapshotActions(overrides: SavedSnapshot & {
  text: string;
  pngBase64: string;
  url: string;
  title: string;
}): BrowserActions {
  return {
    async navigate(url) {
      return { ok: true, url, title: 'Page', status: 200 };
    },
    async resize(width, height) {
      return { width, height };
    },
    async snapshot() {
      return overrides;
    },
    async click() {
      return 'clicked';
    },
    async type() {
      return undefined;
    },
    async press() {
      return undefined;
    },
    async console() {
      return '';
    },
    async assert() {
      return { ok: true, message: 'Assertion passed.' };
    }
  };
}
