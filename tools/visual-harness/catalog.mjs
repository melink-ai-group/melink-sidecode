/*
 * The screen catalog is the single source of truth for the harness, the
 * manifest and the host-free unit test. Adding a screen here makes the run
 * fail until it also produces a non-blank image at both viewports.
 */

export const VIEWPORTS = Object.freeze([
  Object.freeze({ width: 1280, height: 800 }),
  Object.freeze({ width: 390, height: 844 })
]);

export const SCREENS = Object.freeze([
  Object.freeze({
    slug: 'chat-idle',
    title: 'Composer / chat idle',
    expectText: 'SideCode',
    waitFor: '.app--chat-empty'
  }),
  Object.freeze({
    slug: 'stream-reasoning',
    title: 'Streamed turn with expanded reasoning',
    expectText: 'Refactor the auth guard',
    waitFor: '.turn--reasoning .reasoning-toggle',
    click: '.turn--reasoning .reasoning-toggle',
    afterClick: '.turn--reasoning:not(.turn--reasoning--collapsed)'
  }),
  Object.freeze({
    slug: 'change-review',
    title: 'Change review',
    expectText: 'Files changed',
    waitFor: '.changes-review',
    click: '.changes-review__collapse',
    afterClick: '.changes-review.is-open'
  }),
  Object.freeze({
    slug: 'plan-todos',
    title: 'Plan / todos',
    expectText: 'Run typecheck, unit tests, and the build',
    waitFor: '.plan-card',
    // Capture-only: the product bounds `.plan-doc` to 216px and scrolls it, so
    // the fourth plan step is clipped in a screenshot. Expand it for the
    // capture and assert every row fits in the viewport.
    captureCss:
      '.plan-doc { max-height: none !important; overflow: visible !important; } .transcript-end { display: none !important; }',
    assertRows: Object.freeze({ selector: '.plan-steps li', count: 4 })
  }),
  Object.freeze({
    slug: 'settings',
    title: 'Settings',
    expectText: 'Settings',
    waitFor: '.settings',
    clickTab: 'Defaults',
    afterClickText: 'Default permission level'
  }),
  Object.freeze({
    slug: 'settings-orchestration',
    title: 'Settings / Orchestration',
    expectText: 'Effective policy',
    waitFor: '.settings',
    clickTab: 'Orchestration',
    afterClickText: 'Effective policy'
  }),
  Object.freeze({
    slug: 'settings-provider-local',
    title: 'Settings / Ollama Local',
    expectText: 'Ollama Local',
    waitFor: '.settings',
    clickTabs: Object.freeze(['Providers', 'Ollama Local']),
    afterClickText: 'No API key is used'
  }),
  Object.freeze({
    slug: 'chat-queued',
    title: 'Composer / busy with queued turns',
    expectText: '2 queued',
    waitFor: '.composer-queue'
  })
]);

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const FILE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d+x\d+\.png$/;
export const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function fileName(slug, viewport) {
  return `${slug}-${viewport.width}x${viewport.height}.png`;
}

export function screenLabel(screen, viewport) {
  return `${screen.slug} @ ${viewport.width}x${viewport.height}`;
}

export function expectedLabel(file) {
  const entry = expectedFiles().find((candidate) => candidate.file === file);
  return entry
    ? `${entry.slug} @ ${entry.viewport.width}x${entry.viewport.height}`
    : file;
}

export function expectedFiles() {
  return SCREENS.flatMap((screen) =>
    VIEWPORTS.map((viewport) => ({
      slug: screen.slug,
      title: screen.title,
      viewport: { width: viewport.width, height: viewport.height },
      file: fileName(screen.slug, viewport)
    }))
  );
}

/**
 * Compare a manifest against stored baseline hashes. Problems always name the
 * screen and viewport, not only the filename.
 */
export function compareBaseline(manifest, baselineFiles) {
  const problems = [];
  for (const entry of manifest.screens) {
    const where = `${entry.screen} @ ${entry.viewport.width}x${entry.viewport.height} (${entry.file})`;
    if (!(entry.file in baselineFiles)) {
      problems.push(`${where}: not in baseline`);
    } else if (baselineFiles[entry.file] !== entry.sha256) {
      problems.push(`${where}: hash changed (${baselineFiles[entry.file]} -> ${entry.sha256})`);
    }
  }
  const produced = new Set(manifest.screens.map((entry) => entry.file));
  for (const file of Object.keys(baselineFiles)) {
    if (!produced.has(file)) {
      problems.push(`${expectedLabel(file)}: in baseline but not produced`);
    }
  }
  return problems;
}

/**
 * Structural validation shared by the writer and the unit test. Returns a list
 * of human-readable problems; an empty list means the manifest is usable.
 */
export function validateManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object') {
    return ['manifest is not an object'];
  }
  if (manifest.schemaVersion !== 1) {
    problems.push('schemaVersion must be 1');
  }
  if (manifest.theme !== 'light') {
    problems.push('theme must be light');
  }
  if (manifest.deviceScaleFactor !== 1) {
    problems.push('deviceScaleFactor must be 1');
  }
  if (!manifest.commit || typeof manifest.commit !== 'string') {
    problems.push('commit must be a non-empty string');
  }
  if (!(typeof manifest.dirty === 'boolean' || manifest.dirty === null)) {
    problems.push('dirty must be true, false, or null when git is unavailable');
  }
  if (typeof manifest.harnessHash !== 'string' || !HASH_PATTERN.test(manifest.harnessHash)) {
    problems.push('harnessHash must be 64 lowercase hex characters');
  }
  if (manifest.locale !== 'en-US') {
    problems.push('locale must be en-US');
  }
  if (manifest.timezone !== 'UTC') {
    problems.push('timezone must be UTC');
  }
  if (!manifest.browser || typeof manifest.browser !== 'object') {
    problems.push('browser must be an object');
  } else {
    if (!manifest.browser.name || typeof manifest.browser.name !== 'string') {
      problems.push('browser.name must be a non-empty string');
    }
    if (!manifest.browser.version || typeof manifest.browser.version !== 'string') {
      problems.push('browser.version must be a non-empty string');
    }
    if (manifest.browser.headless !== true) {
      problems.push('browser.headless must be true');
    }
  }
  if (!manifest.generatedAt || Number.isNaN(Date.parse(manifest.generatedAt))) {
    problems.push('generatedAt must be an ISO timestamp');
  }
  if (!Array.isArray(manifest.screens) || manifest.screens.length === 0) {
    return [...problems, 'screens must be a non-empty array'];
  }
  const expected = expectedFiles();
  const byFile = new Map(manifest.screens.map((entry) => [entry.file, entry]));
  for (const wanted of expected) {
    const entry = byFile.get(wanted.file);
    if (!entry) {
      problems.push(`missing screen ${wanted.file}`);
      continue;
    }
    if (entry.screen !== wanted.slug) {
      problems.push(`${wanted.file}: screen slug is ${entry.screen}, expected ${wanted.slug}`);
    }
    if (
      !entry.viewport ||
      entry.viewport.width !== wanted.viewport.width ||
      entry.viewport.height !== wanted.viewport.height
    ) {
      problems.push(`${wanted.file}: viewport does not match the catalog`);
    }
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      problems.push(`${wanted.file}: sha256 must be 64 lowercase hex characters`);
    }
    if (!Number.isInteger(entry.bytes) || entry.bytes <= 0) {
      problems.push(`${wanted.file}: bytes must be a positive integer`);
    }
  }
  for (const entry of manifest.screens) {
    if (!expected.some((wanted) => wanted.file === entry.file)) {
      problems.push(`unexpected screen ${entry.file}`);
    }
  }
  return problems;
}
