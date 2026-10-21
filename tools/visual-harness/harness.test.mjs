import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { captureScreen } from './capture.mjs';
import { resolveStaticTarget } from './server.mjs';

const ROOT = path.resolve(path.sep, 'repo');
const HARNESS = path.join(ROOT, 'tools', 'visual-harness');
const HARNESS_FORWARD_SLASHES = HARNESS.split(path.sep).join('/');
const ROOT_FORWARD_SLASHES = ROOT.split(path.sep).join('/');

function target(pathname) {
  return resolveStaticTarget(pathname, ROOT, HARNESS);
}

test('the static server only maps dist and harness assets', () => {
  assert.equal(target('/'), path.join(HARNESS, 'index.html'));
  assert.equal(target('/dist/webview.js'), path.join(ROOT, 'dist', 'webview.js'));
  assert.equal(
    target('/tools/visual-harness/theme.css'),
    path.join(HARNESS, 'theme.css')
  );
});

test('the static server normalizes forward-slash roots from other platforms', () => {
  assert.equal(
    resolveStaticTarget('/tools/visual-harness/theme.css', ROOT_FORWARD_SLASHES, HARNESS_FORWARD_SLASHES),
    path.join(HARNESS, 'theme.css')
  );
  assert.equal(
    resolveStaticTarget('/dist/webview.js', ROOT_FORWARD_SLASHES, HARNESS_FORWARD_SLASHES),
    path.join(ROOT, 'dist', 'webview.js')
  );
});

test('the static server refuses the repo root, dotfiles, node_modules, and traversal', () => {
  for (const pathname of [
    '/package.json',
    '/.env',
    '/.git/config',
    '/node_modules/playwright-core/package.json',
    '/tools/visual-harness/.secret',
    '/tools/visual-harness/node_modules/x.js',
    '/dist/../package.json',
    '/dist/%2e%2e/package.json',
    '/tools/visual-harness/../../package.json',
    '/tools/visual-harness/%2e%2e/%2e%2e/package.json',
    '/dist/%00webview.js'
  ]) {
    assert.equal(target(pathname), null, `${pathname} must not be served`);
  }
});

function fakePage({ textTimeout = false, missingSelector = null, rowCount = 4, clipped = false } = {}) {
  return {
    on() {},
    goto: async () => {},
    waitForFunction: async (_fn, arg) => {
      if (typeof arg === 'string' && textTimeout) {
        throw new Error('Timeout 10000ms exceeded');
      }
      return true;
    },
    waitForSelector: async (selector) => {
      if (selector === missingSelector) {
        throw new Error(`Timeout 15000ms exceeded waiting for selector "${selector}"`);
      }
      return {};
    },
    addStyleTag: async () => {},
    locator: () => {
      const rows = {
        first() {
          return rows;
        },
        click: async () => {},
        count: async () => rowCount,
        nth: () => ({
          isVisible: async () => true,
          boundingBox: async () => ({ x: 0, y: clipped ? 900 : 100, width: 200, height: 20 })
        })
      };
      return rows;
    },
    getByRole: () => ({ first: () => ({ click: async () => {} }) }),
    evaluate: async (fn) => (String(fn).includes('innerText') ? 'enough body text for the harness check' : undefined),
    waitForTimeout: async () => {},
    screenshot: async () => {},
    close: async () => {}
  };
}

function fakeBrowser(page) {
  return {
    newContext: async () => ({
      newPage: async () => page,
      close: async () => {}
    })
  };
}

async function captureError(screen, { viewport = { width: 1280, height: 800 }, pageOptions } = {}) {
  try {
    await captureScreen({
      browser: fakeBrowser(fakePage(pageOptions)),
      baseUrl: 'http://127.0.0.1',
      screen,
      viewport,
      outDir: 'unused'
    });
  } catch (error) {
    return error.message;
  }
  assert.fail('captureScreen should have failed');
}

test('a missing expected text names the screen and viewport', async () => {
  const message = await captureError({
    slug: 'plan-todos',
    title: 'Plan / todos',
    waitFor: '.plan-card',
    expectText: 'this text is absent'
  }, { pageOptions: { textTimeout: true } });
  assert.match(
    message,
    /^\[visual\] FAILED plan-todos @ 1280x800: wait for text "this text is absent": Timeout/
  );
});

test('a missing selector names the screen and viewport', async () => {
  const message = await captureError(
    { slug: 'chat-idle', title: 'Composer / chat idle', waitFor: '.missing-panel' },
    {
      viewport: { width: 390, height: 844 },
      pageOptions: { missingSelector: '.missing-panel' }
    }
  );
  assert.match(
    message,
    /^\[visual\] FAILED chat-idle @ 390x844: wait for selector \.missing-panel: Timeout/
  );
});

test('a clipped or missing plan step names the screen and viewport', async () => {
  for (const pageOptions of [{ rowCount: 3 }, { clipped: true }]) {
    const message = await captureError(
      {
        slug: 'plan-todos',
        title: 'Plan / todos',
        waitFor: '.plan-card',
        assertRows: { selector: '.plan-steps li', count: 4 }
      },
      { pageOptions }
    );
    assert.match(message, /^\[visual\] FAILED plan-todos @ 1280x800: assert rows \.plan-steps li:/);
  }
});
