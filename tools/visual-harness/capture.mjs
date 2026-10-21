/*
 * Per-screen capture. Kept separate from `run.mjs` so the failure wrapping and
 * plan-capture assertions can be probed without launching a real browser.
 *
 * Every wait, click, text assertion, and screenshot runs through `step()`, so a
 * failure always names the screen and viewport:
 *   [visual] FAILED plan-todos @ 390x844: wait for selector .plan-card: ...
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileName, screenLabel } from './catalog.mjs';
import { screenMessages } from './fixtures.mjs';

const FAILURE_PREFIX = '[visual] FAILED ';

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function step(label, name, work) {
  try {
    return await work();
  } catch (error) {
    if (messageOf(error).startsWith(FAILURE_PREFIX)) {
      throw error;
    }
    throw new Error(`${FAILURE_PREFIX}${label}: ${name}: ${messageOf(error)}`);
  }
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function seed(page, messages) {
  await page.evaluate((hostMessages) => {
    for (const message of hostMessages) {
      window.postMessage(message, '*');
    }
  }, messages);
}

async function assertVisibleRows(page, label, spec, viewport) {
  const rows = page.locator(spec.selector);
  const count = await rows.count();
  if (count !== spec.count) {
    throw new Error(`expected ${spec.count} rows for ${spec.selector}, found ${count}`);
  }
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if (!(await row.isVisible())) {
      throw new Error(`row ${index + 1} of ${spec.selector} is not visible`);
    }
    const box = await row.boundingBox();
    if (!box || box.height < 1) {
      throw new Error(`row ${index + 1} of ${spec.selector} has no layout box`);
    }
    if (box.y < 0 || box.y + box.height > viewport.height) {
      throw new Error(
        `row ${index + 1} of ${spec.selector} is clipped (y ${Math.round(box.y)}..${Math.round(
          box.y + box.height
        )}, viewport 0..${viewport.height})`
      );
    }
  }
  console.log(`[visual] ${label}: asserted ${count} visible rows for ${spec.selector}`);
}

export async function captureScreen({ browser, baseUrl, screen, viewport, outDir }) {
  const label = screenLabel(screen, viewport);
  let context;
  let page;
  try {
    context = await step(label, 'create browser context', () =>
      browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: 'light',
        reducedMotion: 'reduce'
      })
    );
    page = await step(label, 'open page', () => context.newPage());
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
    });

    await step(label, 'navigate to the harness shell', () =>
      page.goto(`${baseUrl}/tools/visual-harness/index.html`, { waitUntil: 'load' })
    );
    await step(label, 'wait for webview ready', () =>
      page.waitForFunction(() => window.__visualReady === true, null, { timeout: 15000 })
    );
    await step(label, 'seed host messages', () => seed(page, screenMessages(screen.slug)));
    if (screen.captureCss) {
      await step(label, 'apply capture-only stylesheet', () =>
        page.addStyleTag({ content: screen.captureCss })
      );
    }
    await step(label, `wait for selector ${screen.waitFor}`, () =>
      page.waitForSelector(screen.waitFor, { state: 'visible', timeout: 15000 })
    );

    if (screen.click) {
      await step(label, `click ${screen.click}`, () => page.locator(screen.click).first().click());
    }
    for (const tab of screen.clickTabs ?? []) {
      await step(label, `click tab ${tab}`, () =>
        page.getByRole('tab', { name: tab, exact: true }).first().click()
      );
    }
    if (screen.clickTab) {
      await step(label, `click tab ${screen.clickTab}`, () =>
        page.getByRole('tab', { name: screen.clickTab, exact: true }).first().click()
      );
    }
    if (screen.afterClick) {
      await step(label, `wait for selector ${screen.afterClick}`, () =>
        page.waitForSelector(screen.afterClick, { state: 'visible', timeout: 10000 })
      );
    }
    if (screen.afterClickText) {
      await step(label, `wait for text "${screen.afterClickText}"`, () =>
        page.waitForFunction((text) => document.body.innerText.includes(text), screen.afterClickText, {
          timeout: 10000
        })
      );
    }
    if (screen.expectText) {
      await step(label, `wait for text "${screen.expectText}"`, () =>
        page.waitForFunction((text) => document.body.innerText.includes(text), screen.expectText, {
          timeout: 10000
        })
      );
    }

    await step(label, 'settle fonts and layout', () => settle(page));
    // A short fixed pause lets the last layout/paint settle. It is wall-clock
    // only; nothing on screen reads it, so it does not change the result.
    await step(label, 'settle last paint', () => page.waitForTimeout(250));

    if (screen.assertRows) {
      await step(label, `assert rows ${screen.assertRows.selector}`, () =>
        assertVisibleRows(page, label, screen.assertRows, viewport)
      );
    }

    const bodyText = await step(label, 'read body text', () =>
      page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim())
    );
    if (bodyText.length < 40) {
      throw new Error(`body text is empty or too short (${bodyText.length} characters)`);
    }
    if (errors.length > 0) {
      throw new Error(`page errors: ${errors.join(' | ')}`);
    }

    const file = fileName(screen.slug, viewport);
    const target = path.join(outDir, file);
    await step(label, `screenshot ${file}`, () =>
      page.screenshot({ path: target, type: 'png', animations: 'disabled', caret: 'hide', fullPage: false })
    );
    const info = await step(label, `stat ${file}`, () => stat(target));
    if (info.size < 5000) {
      throw new Error('screenshot is too small to be a real render (' + info.size + ' bytes)');
    }
    const bytes = await step(label, `read ${file}`, () => readFile(target));
    console.log(`[visual] ${label} -> ${file} (${info.size} bytes, ${sha256(bytes).slice(0, 12)}...)`);
    return {
      screen: screen.slug,
      title: screen.title,
      viewport: { width: viewport.width, height: viewport.height },
      file,
      sha256: sha256(bytes),
      bytes: info.size
    };
  } catch (error) {
    if (messageOf(error).startsWith(FAILURE_PREFIX)) {
      throw error;
    }
    throw new Error(`${FAILURE_PREFIX}${label}: capture failed: ${messageOf(error)}`);
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
    if (context) {
      await context.close().catch(() => {});
    }
  }
}
