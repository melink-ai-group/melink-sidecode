import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BrowserPage,
  checkAssertion,
  classifyNavigationError,
  hasRenderableContent,
  isReady,
  NAVIGATION_ATTEMPTS,
  NAVIGATION_DEADLINE_MS,
  NAVIGATION_GOTO_TIMEOUT_MS,
  NAVIGATION_POLL_MS,
  navigateWithReadiness,
  navigationFailureMessage,
  readinessProbe,
  type AssertionPage,
  type NavigationPage,
  type ReadinessSnapshot
} from './session.ts';

type GotoStep = 'ok' | Error;

class FakePage implements NavigationPage {
  attempts = 0;
  evaluations = 0;
  readonly gotoTimeouts: number[] = [];
  readonly gotoWaitUntil: string[] = [];
  currentUrl = 'about:blank';
  private readonly gotoPlan: GotoStep[];
  private readonly snapshots: ReadinessSnapshot[];
  private readonly status: number | undefined;

  constructor(gotoPlan: GotoStep[], snapshots: ReadinessSnapshot[], status: number | undefined = 200) {
    this.gotoPlan = gotoPlan;
    this.snapshots = snapshots;
    this.status = status;
  }

  async goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown> {
    this.gotoWaitUntil.push(options.waitUntil);
    this.gotoTimeouts.push(options.timeout);
    const step = this.gotoPlan[Math.min(this.attempts, this.gotoPlan.length - 1)] ?? 'ok';
    this.attempts += 1;
    if (step instanceof Error) {
      throw step;
    }
    this.currentUrl = url;
    return { status: () => this.status };
  }

  async evaluate<T>(_probe: () => T): Promise<T> {
    const snapshot = this.snapshots[Math.min(this.evaluations, this.snapshots.length - 1)] ?? {};
    this.evaluations += 1;
    return snapshot as unknown as T;
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return 'Fake title';
  }
}

function clock(start = 0): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let value = start;
  return {
    now: () => value,
    sleep: async (ms) => {
      value += ms;
    }
  };
}

test('readiness constants stay bounded', () => {
  assert.equal(NAVIGATION_ATTEMPTS, 3);
  assert.ok(NAVIGATION_DEADLINE_MS <= 15_000);
  assert.ok(NAVIGATION_GOTO_TIMEOUT_MS <= 8_000);
  assert.ok(NAVIGATION_POLL_MS <= 200);
});

test('isReady needs body content, not just a later readyState', () => {
  assert.equal(isReady({ state: 'interactive', hasBody: true, hasContent: true }), true);
  assert.equal(isReady({ state: 'complete', hasBody: true, hasContent: true }), true);
  assert.equal(isReady({ state: 'interactive', hasBody: true, hasContent: false }), false);
  assert.equal(isReady({ state: 'interactive', hasBody: false, hasContent: true }), false);
  assert.equal(isReady({ state: 'loading', hasBody: true, hasContent: true }), false);
});

test('readiness accepts text or media but rejects an empty root shell', () => {
  const emptyRoot = { textContent: '  \n ', querySelector: () => null };
  assert.equal(hasRenderableContent(emptyRoot), false);
  assert.equal(isReady({ state: 'interactive', hasBody: true, hasContent: hasRenderableContent(emptyRoot) }), false);

  const textPage = { textContent: 'Dashboard', querySelector: () => null };
  assert.equal(hasRenderableContent(textPage), true);
  assert.equal(isReady({ state: 'interactive', hasBody: true, hasContent: hasRenderableContent(textPage) }), true);

  const mediaPage = { textContent: '', querySelector: (selector: string) => (selector === 'img, canvas, svg, video' ? {} : null) };
  assert.equal(hasRenderableContent(mediaPage), true);
  assert.equal(hasRenderableContent(null), false);
});

function probeWithDocument(documentLike: unknown): ReadinessSnapshot {
  const source = `return (${readinessProbe.toString()})();`;
  const run = new Function('document', source);
  return run(documentLike) as ReadinessSnapshot;
}

test('serialized readinessProbe is self-contained and detects real content', () => {
  const empty = probeWithDocument({
    readyState: 'interactive',
    body: { innerText: '  \n ', querySelector: () => null }
  });
  assert.equal(empty.state, 'interactive');
  assert.equal(empty.hasBody, true);
  assert.equal(empty.hasContent, false);
  assert.equal(isReady(empty), false);

  const text = probeWithDocument({
    readyState: 'interactive',
    body: { innerText: 'Dashboard', querySelector: () => null }
  });
  assert.equal(text.hasContent, true);
  assert.equal(isReady(text), true);

  for (const tag of ['img', 'canvas', 'svg', 'video']) {
    const media = probeWithDocument({
      readyState: 'complete',
      body: { innerText: '', querySelector: (selector: string) => (selector.includes(tag) ? {} : null) }
    });
    assert.equal(media.hasContent, true, tag);
    assert.equal(isReady(media), true, tag);
  }
});

test('navigation becomes ready after the first attempt fails', async () => {
  const time = clock();
  const page = new FakePage([new Error('net::ERR_CONNECTION_REFUSED'), 'ok'], [
    { state: 'complete', hasBody: true, hasContent: true }
  ]);
  const result = await navigateWithReadiness(page, 'http://localhost:3000', { now: time.now, sleep: time.sleep });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.url, 'http://localhost:3000');
    assert.equal(result.title, 'Fake title');
    assert.equal(result.status, 200);
  }
  assert.equal(page.attempts, 2);
  assert.equal(page.evaluations, 1);
  assert.equal(page.gotoWaitUntil[0], 'domcontentloaded');
});

test('connection refused is not-reachable and stops after the attempt budget', async () => {
  const time = clock();
  const page = new FakePage([new Error('connect ECONNREFUSED 127.0.0.1:9')], []);
  const result = await navigateWithReadiness(page, 'http://localhost:9', { now: time.now, sleep: time.sleep });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, 'not-reachable');
    assert.equal(result.reason, 'connection refused');
  }
  assert.equal(page.attempts, NAVIGATION_ATTEMPTS);
});

test('DNS failure is not-reachable with its own reason', async () => {
  const time = clock();
  const page = new FakePage([new Error('getaddrinfo ENOTFOUND no-such-host')], []);
  const result = await navigateWithReadiness(page, 'http://no-such-host', { now: time.now, sleep: time.sleep });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, 'not-reachable');
    assert.equal(result.reason, 'DNS lookup failed');
  }
});

test('an overall deadline is reported as timeout, not as a network failure', async () => {
  const time = clock();
  const page = new FakePage(['ok'], [{ state: 'loading', hasBody: true, hasContent: true }]);
  const result = await navigateWithReadiness(page, 'http://localhost:3000', {
    now: time.now,
    sleep: time.sleep,
    deadlineMs: 1_000,
    pollMs: 100
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, 'timeout');
    assert.match(result.reason, /did not become ready within 1s/);
  }
  assert.ok(page.evaluations > 1);
});

test('sub-second deadlines still report at least 1s', async () => {
  const time = clock();
  const page = new FakePage(['ok'], [{ state: 'loading', hasBody: true, hasContent: true }]);
  const result = await navigateWithReadiness(page, 'http://localhost:3000', {
    now: time.now,
    sleep: time.sleep,
    deadlineMs: 50,
    pollMs: 10
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'the page did not become ready within 1s');
  }
});

test('a per-attempt goto timeout is classified as timeout', async () => {
  const time = clock();
  const page = new FakePage([new Error('page.goto: Timeout 8000ms exceeded.')], []);
  const result = await navigateWithReadiness(page, 'http://localhost:3000', { now: time.now, sleep: time.sleep });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, 'timeout');
    assert.equal(result.reason, 'the page did not respond before the deadline');
  }
  assert.equal(page.attempts, NAVIGATION_ATTEMPTS);
});

test('domcontentloaded-only never counts as success', async () => {
  const time = clock();
  const page = new FakePage(['ok'], [{ state: 'interactive', hasBody: true, hasContent: false }]);
  const result = await navigateWithReadiness(page, 'http://localhost:3000', { now: time.now, sleep: time.sleep });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, 'timeout');
  }
  assert.ok(page.evaluations > 1);
});

test('a blocked evaluate cannot exceed the navigation deadline', async () => {
  const page: NavigationPage = {
    async goto() {
      return { status: () => 200 };
    },
    evaluate<T>(): Promise<T> {
      return new Promise<T>(() => undefined);
    },
    url: () => 'http://localhost:3000/',
    title: async () => 'Blocked'
  };
  const started = Date.now();
  const result = await navigateWithReadiness(page, 'http://localhost:3000/', { deadlineMs: 80, pollMs: 10 });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, 'timeout');
    assert.match(result.reason, /did not become ready within/);
  }
  assert.ok(Date.now() - started < 2_000);
});

test('the per-attempt goto timeout never exceeds the overall deadline', async () => {
  const time = clock();
  const page = new FakePage(['ok'], [{ state: 'complete', hasBody: true, hasContent: true }]);
  await navigateWithReadiness(page, 'http://localhost:3000', {
    now: time.now,
    sleep: time.sleep,
    deadlineMs: 500,
    gotoTimeoutMs: 8_000
  });
  assert.ok(page.gotoTimeouts[0] !== undefined && page.gotoTimeouts[0] <= 500);
});

test('classifyNavigationError separates refused, DNS, timeout, and other', () => {
  assert.equal(classifyNavigationError(new Error('net::ERR_CONNECTION_REFUSED')).reason, 'connection refused');
  assert.equal(classifyNavigationError(new Error('net::ERR_NAME_NOT_RESOLVED')).reason, 'DNS lookup failed');
  assert.equal(
    classifyNavigationError(new Error('Timeout 8000ms exceeded')).kind,
    'timeout'
  );
  const other = classifyNavigationError(new Error('net::ERR_CERT_AUTHORITY_INVALID'));
  assert.equal(other.kind, 'not-reachable');
  assert.equal(other.reason, 'net::ERR_CERT_AUTHORITY_INVALID');
});

function assertionPage(url: string, selectorCount: number, textCount: number): AssertionPage {
  return {
    url: () => url,
    locator: () => ({ count: async () => selectorCount }),
    getByText: () => ({ count: async () => textCount })
  };
}

test('checkAssertion passes and names each matched criterion', async () => {
  const result = await checkAssertion(
    assertionPage('http://localhost:3000/', 1, 1),
    { selector: '#save', text: 'Save', url: 'http://localhost:3000/', status: 200 },
    200
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.matched, [
      'selector "#save"',
      'text "Save"',
      'URL "http://localhost:3000/"',
      'status 200'
    ]);
  }
});

test('checkAssertion reports an explicit selector miss', async () => {
  const result = await checkAssertion(assertionPage('http://localhost:3000/', 0, 1), { selector: '#missing' }, 200);
  assert.deepEqual(result, { ok: false, message: 'Selector not found: #missing at http://localhost:3000/.' });
});

test('checkAssertion reports an explicit text miss', async () => {
  const result = await checkAssertion(assertionPage('http://localhost:3000/', 1, 0), { text: 'Dashboard' }, 200);
  assert.deepEqual(result, { ok: false, message: 'Text not found: "Dashboard" at http://localhost:3000/.' });
});

test('checkAssertion reports a URL mismatch with both values', async () => {
  const result = await checkAssertion(assertionPage('http://localhost:3000/other', 1, 1), {
    url: 'http://localhost:3000/'
  }, 200);
  assert.deepEqual(result, {
    ok: false,
    message: 'URL mismatch: expected http://localhost:3000/, got http://localhost:3000/other.'
  });
});

test('checkAssertion reports a status mismatch, including unknown', async () => {
  const mismatch = await checkAssertion(assertionPage('http://localhost:3000/', 1, 1), { status: 200 }, 404);
  assert.deepEqual(mismatch, { ok: false, message: 'Status mismatch: expected 200, got 404.' });
  const unknown = await checkAssertion(assertionPage('http://localhost:3000/', 1, 1), { status: 200 }, undefined);
  assert.deepEqual(unknown, { ok: false, message: 'Status mismatch: expected 200, got unknown.' });
});

test('a blocked count returns an assertion timeout without hanging', async () => {
  const page: AssertionPage = {
    url: () => 'http://localhost:3000/',
    locator: () => ({ count: () => new Promise<number>(() => undefined) }),
    getByText: () => ({ count: async () => 1 })
  };
  const started = Date.now();
  const result = await checkAssertion(page, { selector: '#save' }, 200, { deadline: Date.now() + 80 });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /^Assertion timed out: selector "#save" at http:\/\/localhost:3000\/\.$/);
  }
  assert.ok(Date.now() - started < 2_000);
});

type BrowserInternals = {
  page?: unknown;
  lastNavigation?: unknown;
  lastStatus?: number;
};

function attach(browser: BrowserPage, page: unknown, lastNavigation?: unknown): BrowserInternals {
  const internals = browser as unknown as BrowserInternals;
  internals.page = page;
  internals.lastNavigation = lastNavigation;
  return internals;
}

test('BrowserPage.assert refuses to pass after a failed navigation', async () => {
  const browser = new BrowserPage();
  attach(browser, assertionPage('http://localhost:3000/', 1, 1), {
    ok: false,
    kind: 'not-reachable',
    url: 'http://localhost:3000/',
    reason: 'connection refused'
  });
  const result = await browser.assert({ selector: '#save' });
  assert.deepEqual(result, {
    ok: false,
    message: 'Navigation failed: connection refused at http://localhost:3000/.'
  });
  assert.equal(
    navigationFailureMessage({ ok: false, kind: 'timeout', url: 'http://x/', reason: 'too slow' }),
    'Navigation failed: too slow at http://x/.'
  );
  assert.equal(navigationFailureMessage({ ok: true, url: 'http://x/', title: 'X' }), undefined);
});

function interactionPage(): Record<string, unknown> {
  const noop = async (): Promise<void> => undefined;
  return {
    url: () => 'http://localhost:3000/',
    title: async () => 'Title',
    locator: () => ({ click: noop, count: async () => 1, ariaSnapshot: async () => 'tree' }),
    getByText: () => ({ first: () => ({ click: noop }), count: async () => 1 }),
    mouse: { click: noop },
    keyboard: { type: noop, press: noop },
    viewportSize: () => ({ width: 1280, height: 800 })
  };
}

test('click, type, and press clear stale navigation status', async () => {
  const browser = new BrowserPage();
  const internals = attach(browser, interactionPage());
  const markNavigated = (): void => {
    internals.lastStatus = 200;
    internals.lastNavigation = { ok: true, url: 'http://localhost:3000/', title: 'Title', status: 200 };
  };

  markNavigated();
  await browser.click({ x: 10, y: 10 });
  assert.equal(browser.status(), undefined);
  assert.equal(internals.lastNavigation, undefined);

  markNavigated();
  await browser.type('hello');
  assert.equal(browser.status(), undefined);
  assert.equal(internals.lastNavigation, undefined);

  markNavigated();
  await browser.press('Enter');
  assert.equal(browser.status(), undefined);
  assert.equal(internals.lastNavigation, undefined);
});

test('snapshot reads the page title once', async () => {
  const browser = new BrowserPage();
  let titleCalls = 0;
  attach(browser, {
    url: () => 'http://localhost:3000/',
    title: async () => {
      titleCalls += 1;
      return 'Once';
    },
    locator: () => ({ ariaSnapshot: async () => 'tree' }),
    screenshot: async () => Buffer.from('png')
  });
  const shot = await browser.snapshot();
  assert.equal(shot.text, 'tree');
  assert.equal(shot.title, 'Once');
  assert.equal(titleCalls, 1);
});
