import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSOLE_BUFFER_LIMIT,
  CONSOLE_ENTRY_TEXT_LIMIT,
  ConsoleBuffer,
  EMPTY_CONSOLE_TEXT,
  consoleEntry,
  formatConsoleEntries,
  pageErrorEntry,
  requestFailedEntry,
  responseEntry
} from './consoleBuffer.ts';

test('a console message keeps its level, text and URL', () => {
  const entry = consoleEntry({
    type: () => 'warning',
    text: () => 'Deprecated API',
    location: () => ({ url: 'http://localhost:3000/app.js' })
  });
  assert.deepEqual(entry, {
    level: 'warning',
    text: 'Deprecated API',
    url: 'http://localhost:3000/app.js'
  });
});

test('an uncaught page error is an error with a short stack summary', () => {
  const entry = pageErrorEntry({
    message: 'boom',
    stack: 'Error: boom\n    at handler (http://localhost:3000/app.js:12:4)\n    at other'
  });
  assert.equal(entry.level, 'error');
  assert.equal(entry.url, '');
  assert.match(entry.text, /^boom \(/);
  assert.match(entry.text, /app\.js:12:4/);
  assert.doesNotMatch(entry.text, /\n/);
});

test('a failed request is an error and names the failure reason', () => {
  const entry = requestFailedEntry({
    url: () => 'http://localhost:3000/api',
    failure: () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' })
  });
  assert.deepEqual(entry, {
    level: 'error',
    text: 'net::ERR_CONNECTION_REFUSED',
    url: 'http://localhost:3000/api'
  });
  assert.equal(entry.status, undefined);
});

test('a failed request without a reported reason still makes an error', () => {
  const entry = requestFailedEntry({
    url: () => 'http://localhost:3000/api',
    failure: () => null
  });
  assert.equal(entry.level, 'error');
  assert.equal(entry.text, 'Request failed.');
  assert.equal(entry.status, undefined);
});

test('HTTP 404 and 500 responses are errors carrying their status', () => {
  const notFound = responseEntry({
    url: () => 'http://localhost:3000/missing',
    status: () => 404,
    statusText: () => 'Not Found'
  });
  assert.deepEqual(notFound, {
    level: 'error',
    text: 'HTTP 404 Not Found',
    url: 'http://localhost:3000/missing',
    status: 404
  });

  const serverError = responseEntry({
    url: () => 'http://localhost:3000/api',
    status: () => 500
  });
  assert.equal(serverError?.level, 'error');
  assert.equal(serverError?.status, 500);
  assert.equal(serverError?.text, 'HTTP 500');
});

test('successful responses are not buffered', () => {
  assert.equal(responseEntry({ url: () => 'http://localhost:3000/', status: () => 200 }), undefined);
  assert.equal(responseEntry({ url: () => 'http://localhost:3000/', status: () => 302 }), undefined);
  assert.equal(responseEntry({ url: () => 'http://localhost:3000/', status: () => 399 }), undefined);
});

test('the buffer keeps the newest entries and drops the oldest at the cap', () => {
  assert.equal(CONSOLE_BUFFER_LIMIT, 200);
  const buffer = new ConsoleBuffer(CONSOLE_BUFFER_LIMIT);
  for (let index = 0; index < CONSOLE_BUFFER_LIMIT + 5; index += 1) {
    buffer.push({ level: 'log', text: `line ${index}`, url: 'http://localhost:3000/' });
  }
  assert.equal(buffer.size(), CONSOLE_BUFFER_LIMIT);
  const entries = buffer.entries();
  assert.equal(entries[0]?.text, 'line 5');
  assert.equal(entries[entries.length - 1]?.text, `line ${CONSOLE_BUFFER_LIMIT + 4}`);
});

test('clear empties the buffer and formats as the empty message', () => {
  const buffer = new ConsoleBuffer();
  assert.equal(buffer.format(), EMPTY_CONSOLE_TEXT);
  buffer.push({ level: 'log', text: 'hello', url: 'http://localhost:3000/' });
  assert.notEqual(buffer.format(), EMPTY_CONSOLE_TEXT);
  buffer.clear();
  assert.equal(buffer.size(), 0);
  assert.equal(buffer.format(), 'No console or network entries.');
});

test('the formatter writes one line per entry with level, URL, status and message', () => {
  const text = formatConsoleEntries([
    { level: 'log', text: 'ready', url: 'http://localhost:3000/' },
    { level: 'error', text: 'HTTP 404 Not Found', url: 'http://localhost:3000/missing', status: 404 },
    { level: 'error', text: 'boom (at app.js:1:2)', url: '' }
  ]);
  assert.equal(
    text,
    [
      '[log] http://localhost:3000/: ready',
      '[error] http://localhost:3000/missing [404]: HTTP 404 Not Found',
      '[error] (no url): boom (at app.js:1:2)'
    ].join('\n')
  );
});

test('very long entry text is truncated to keep the tool output bounded', () => {
  const buffer = new ConsoleBuffer();
  buffer.push({ level: 'log', text: 'x'.repeat(CONSOLE_ENTRY_TEXT_LIMIT + 500), url: 'http://localhost:3000/' });
  const text = buffer.entries()[0]?.text ?? '';
  assert.equal(text.length, CONSOLE_ENTRY_TEXT_LIMIT);
  assert.match(text, /\.\.\.$/);
});

test('the buffer feeds Playwright-shaped events through the normalisers', () => {
  const buffer = new ConsoleBuffer(10);
  buffer.pushConsole({ type: () => 'info', text: () => 'hi', location: () => ({ url: 'http://localhost:3000/' }) });
  buffer.pushPageError(new Error('boom'));
  buffer.pushRequestFailed({
    url: () => 'http://localhost:3000/api',
    failure: () => ({ errorText: 'net::ERR_FAILED' })
  });
  buffer.pushResponse({ url: () => 'http://localhost:3000/missing', status: () => 404 });
  buffer.pushResponse({ url: () => 'http://localhost:3000/ok', status: () => 200 });
  assert.deepEqual(
    buffer.entries().map((entry) => entry.level),
    ['info', 'error', 'error', 'error']
  );
  assert.equal(buffer.entries()[3]?.status, 404);
});
