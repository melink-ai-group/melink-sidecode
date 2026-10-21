#!/usr/bin/env node
/*
 * Dev-only visual harness.
 *
 * Builds the real webview bundle with the same esbuild settings as
 * `esbuild.mjs`, serves only that bundle and the harness assets from a tiny
 * local server, seeds the host messages the extension would normally post, and
 * captures one PNG per screen and viewport with installed Chrome or Edge. No
 * extension host or provider is involved. Artifacts land under
 * `.melink/reports/visual/`.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { SCREENS, VIEWPORTS, compareBaseline, validateManifest } from './catalog.mjs';
import { captureScreen } from './capture.mjs';
import { startStaticServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT_DIR = path.join(ROOT, '.melink', 'reports', 'visual');
const LOCK_FILE = path.join(OUT_DIR, '.run.lock');
const STALE_LOCK_MS = 2 * 60 * 60 * 1000;
const CHROME_CANDIDATES = [
  process.env['PROGRAMFILES'] && path.join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['PROGRAMFILES'] && path.join(process.env['PROGRAMFILES'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
].filter(Boolean);

function nowIso() {
  return new Date().toISOString();
}

function gitState() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0;
    return { commit: commit || 'unknown', dirty };
  } catch {
    return { commit: 'unknown', dirty: null };
  }
}

async function harnessHash() {
  const files = [];
  for (const entry of await readdir(HERE, { withFileTypes: true })) {
    if (entry.isFile()) {
      files.push(path.join(HERE, entry.name));
    }
  }
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(ROOT, file).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function buildWebview() {
  console.log('[visual] building the real webview bundle (dist/webview.js + dist/webview.css)');
  await build({
    entryPoints: [path.join(ROOT, 'src', 'webview', 'index.tsx')],
    outfile: path.join(ROOT, 'dist', 'webview.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    loader: { '.css': 'css', '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'silent'
  });
}

function browserLaunchOptions() {
  const requested = process.env.MELINK_VISUAL_BROWSER?.trim();
  const args = [
    '--force-device-scale-factor=1',
    '--force-color-profile=srgb',
    '--disable-gpu',
    '--disable-accelerated-2d-canvas',
    '--font-render-hinting=none',
    '--disable-lcd-text',
    '--disable-font-subpixel-positioning',
    '--disable-partial-raster',
    '--run-all-compositor-stages-before-draw'
  ];
  if (requested === 'chrome' || requested === 'msedge') {
    return { type: 'channel', value: requested, options: { channel: requested, headless: true, args } };
  }
  let executable = requested || '';
  if (!executable) {
    executable = CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? '';
  }
  if (!executable || !existsSync(executable)) {
    throw new Error(
      'No Chrome or Edge found. Install one, or set MELINK_VISUAL_BROWSER to "chrome", "msedge", or an absolute browser executable path.'
    );
  }
  return { type: 'executable', value: executable, options: { executablePath: executable, headless: true, args } };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock() {
  await mkdir(OUT_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(LOCK_FILE, `${JSON.stringify({ pid: process.pid, startedAt: nowIso() })}\n`, {
        encoding: 'utf8',
        flag: 'wx'
      });
      return async () => {
        await rm(LOCK_FILE, { force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      let stale = true;
      let owner = 'unknown';
      try {
        const info = JSON.parse(await readFile(LOCK_FILE, 'utf8'));
        owner = Number.isInteger(info.pid) ? String(info.pid) : 'unknown';
        const age = Date.now() - (await stat(LOCK_FILE)).mtimeMs;
        stale = !Number.isInteger(info.pid) || !pidAlive(info.pid) || age > STALE_LOCK_MS;
      } catch {
        stale = true;
      }
      if (!stale) {
        throw new Error(
          `another visual run is active (pid ${owner}); remove ${path.relative(ROOT, LOCK_FILE)} if it is stale`
        );
      }
      await rm(LOCK_FILE, { force: true });
    }
  }
  throw new Error('could not acquire the visual harness lock');
}

function renderIndex(manifest) {
  const dirty = manifest.dirty === null ? 'unknown (git unavailable)' : manifest.dirty ? 'yes' : 'no';
  const lines = [
    '# Visual harness report',
    '',
    `Generated: ${manifest.generatedAt}`,
    `Commit: \`${manifest.commit}\` (dirty: ${dirty})`,
    `Harness: \`${manifest.harnessHash}\``,
    `Theme: ${manifest.theme} | DPR ${manifest.deviceScaleFactor} | locale ${manifest.locale} | timezone ${manifest.timezone}`,
    `Browser: ${manifest.browser.name} ${manifest.browser.version} (headless)`,
    '',
    'These are Chromium renders of the built webview with seeded host state.',
    'They do not come from a real VS Code extension host.',
    '',
    '| Screen | Viewport | File | SHA-256 | Bytes |',
    '| --- | --- | --- | --- | --- |',
    ...manifest.screens.map(
      (entry) =>
        `| ${entry.screen} | ${entry.viewport.width}x${entry.viewport.height} | \`${entry.file}\` | \`${entry.sha256}\` | ${entry.bytes} |`
    ),
    '',
    'Compare a run with `npm run visual -- --check` after saving a baseline with `npm run visual -- --update-baseline`.',
    ''
  ];
  return lines.join('\n');
}

async function writeArtifacts(manifest) {
  const problems = validateManifest(manifest);
  if (problems.length > 0) {
    throw new Error(`manifest validation failed:\n- ${problems.join('\n- ')}`);
  }
  await writeFile(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(path.join(OUT_DIR, 'index.md'), renderIndex(manifest), 'utf8');
}

async function checkBaseline(manifest) {
  const file = path.join(OUT_DIR, 'baseline.json');
  if (!existsSync(file)) {
    throw new Error('--check needs a baseline. Run `npm run visual -- --update-baseline` first.');
  }
  const baseline = JSON.parse(await readFile(file, 'utf8'));
  const problems = compareBaseline(manifest, baseline.files ?? {});
  if (problems.length > 0) {
    throw new Error(`baseline check failed:\n- ${problems.join('\n- ')}`);
  }
  console.log('[visual] baseline check passed');
}

async function updateBaseline(manifest) {
  const payload = {
    generatedAt: manifest.generatedAt,
    commit: manifest.commit,
    dirty: manifest.dirty,
    harnessHash: manifest.harnessHash,
    files: Object.fromEntries(manifest.screens.map((entry) => [entry.file, entry.sha256]))
  };
  await writeFile(path.join(OUT_DIR, 'baseline.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[visual] baseline written to ${path.relative(ROOT, path.join(OUT_DIR, 'baseline.json'))}`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  await mkdir(OUT_DIR, { recursive: true });
  const release = await acquireLock();
  try {
    await rm(path.join(OUT_DIR, 'manifest.json'), { force: true });
    await rm(path.join(OUT_DIR, 'index.md'), { force: true });
    for (const name of await readdir(OUT_DIR)) {
      if (name.endsWith('.png')) {
        await rm(path.join(OUT_DIR, name));
      }
    }

    await buildWebview();
    const launch = browserLaunchOptions();
    const { server, baseUrl } = await startStaticServer(ROOT, HERE);
    let browser;
    try {
      console.log(`[visual] launching ${launch.value} (headless)`);
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          browser = await chromium.launch({ ...launch.options, timeout: 45000 });
          break;
        } catch (error) {
          if (attempt === 2) {
            throw error;
          }
          console.warn('[visual] browser launch failed, retrying once');
        }
      }

      const version = browser.version();
      const screens = [];
      for (const screen of SCREENS) {
        for (const viewport of VIEWPORTS) {
          screens.push(await captureScreen({ browser, baseUrl, screen, viewport, outDir: OUT_DIR }));
        }
      }
      const git = gitState();
      const manifest = {
        schemaVersion: 1,
        generatedAt: nowIso(),
        commit: git.commit,
        dirty: git.dirty,
        harnessHash: await harnessHash(),
        theme: 'light',
        deviceScaleFactor: 1,
        locale: 'en-US',
        timezone: 'UTC',
        browser: {
          name: launch.type === 'channel' ? launch.value : path.basename(launch.value),
          version,
          headless: true
        },
        screens
      };
      await writeArtifacts(manifest);
      if (args.has('--update-baseline')) {
        await updateBaseline(manifest);
      }
      if (args.has('--check')) {
        await checkBaseline(manifest);
      }
      console.log(`[visual] wrote ${screens.length} screenshots + manifest.json + index.md`);
      console.log(`[visual] artifacts: ${path.relative(ROOT, OUT_DIR)}`);
    } finally {
      if (browser) {
        await browser.close();
      }
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await release();
  }
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.startsWith('[visual] FAILED ') ? message : `[visual] FAILED: ${message}`);
  process.exitCode = 1;
});
