import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FILE_PATTERN,
  SCREENS,
  SLUG_PATTERN,
  VIEWPORTS,
  compareBaseline,
  expectedFiles,
  fileName,
  validateManifest
} from './catalog.mjs';

function validManifest() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-21T09:00:00.000Z',
    commit: '0123456789abcdef0123456789abcdef01234567',
    dirty: false,
    harnessHash: 'f'.repeat(64),
    theme: 'light',
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezone: 'UTC',
    browser: { name: 'chrome', version: '156.0.0.0', headless: true },
    screens: expectedFiles().map((entry, index) => ({
      screen: entry.slug,
      title: entry.title,
      viewport: entry.viewport,
      file: entry.file,
      sha256: String(index + 1).padStart(64, '0'),
      bytes: 12000 + index
    }))
  };
}

test('the visual catalog has stable unique slugs and sixteen expected files', () => {
  assert.equal(SCREENS.length, 8);
  assert.equal(new Set(SCREENS.map((screen) => screen.slug)).size, SCREENS.length);
  assert.equal(VIEWPORTS.length, 2);
  for (const screen of SCREENS) {
    assert.match(screen.slug, SLUG_PATTERN);
  }
  const files = expectedFiles().map((entry) => entry.file);
  assert.equal(files.length, 16);
  assert.equal(new Set(files).size, 16);
  for (const file of files) {
    assert.match(file, FILE_PATTERN);
  }
  // The provider, orchestration and queued-composer surfaces are permanent.
  for (const slug of ['settings-orchestration', 'settings-provider-local', 'chat-queued']) {
    assert.equal(SCREENS.some((screen) => screen.slug === slug), true, slug);
  }
  assert.equal(fileName('chat-idle', { width: 1280, height: 800 }), 'chat-idle-1280x800.png');
});

test('manifest validation accepts the catalog shape and names a missing screen', () => {
  assert.deepEqual(validateManifest(validManifest()), []);
  const missing = validManifest();
  missing.screens = missing.screens.filter((entry) => entry.file !== 'settings-390x844.png');
  assert.deepEqual(validateManifest(missing), ['missing screen settings-390x844.png']);
});

test('a baseline mismatch names the screen and viewport', () => {
  const manifest = validManifest();
  const files = Object.fromEntries(manifest.screens.map((entry) => [entry.file, entry.sha256]));
  assert.deepEqual(compareBaseline(manifest, files), []);

  files['chat-idle-1280x800.png'] = 'a'.repeat(64);
  assert.deepEqual(compareBaseline(manifest, files), [
    'chat-idle @ 1280x800 (chat-idle-1280x800.png): hash changed (' +
      `${'a'.repeat(64)} -> ${manifest.screens[0].sha256})`
  ]);

  delete files['settings-390x844.png'];
  assert.ok(
    compareBaseline(manifest, files).includes(
      'settings @ 390x844 (settings-390x844.png): not in baseline'
    )
  );
});

test('manifest validation rejects a non-fixed locale, timezone, and browser', () => {
  const locale = validManifest();
  locale.locale = 'de-DE';
  assert.deepEqual(validateManifest(locale), ['locale must be en-US']);

  const timezone = validManifest();
  timezone.timezone = 'Europe/Berlin';
  assert.deepEqual(validateManifest(timezone), ['timezone must be UTC']);

  const browser = validManifest();
  browser.browser = { name: '', version: '', headless: false };
  assert.deepEqual(validateManifest(browser), [
    'browser.name must be a non-empty string',
    'browser.version must be a non-empty string',
    'browser.headless must be true'
  ]);

  const dirty = validManifest();
  dirty.dirty = 'no';
  assert.deepEqual(validateManifest(dirty), ['dirty must be true, false, or null when git is unavailable']);

  const harness = validManifest();
  harness.harnessHash = 'not-a-hash';
  assert.deepEqual(validateManifest(harness), ['harnessHash must be 64 lowercase hex characters']);
});
