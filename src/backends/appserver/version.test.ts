import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codexVersionFromUserAgent,
  isSupportedCodexVersion,
  parseCodexVersion,
  PINNED_CODEX_VERSION,
  supportedCodexVersionRange
} from './version.ts';

test('parseCodexVersion reads a plain version and keeps the raw text', () => {
  assert.deepEqual(parseCodexVersion('codex-cli 0.156.1'), {
    major: 0,
    minor: 156,
    patch: 1,
    raw: '0.156.1'
  });
});

test('parseCodexVersion returns undefined rather than inventing a version', () => {
  assert.equal(parseCodexVersion('codex-cli dev'), undefined);
  assert.equal(parseCodexVersion(''), undefined);
  assert.equal(parseCodexVersion(undefined), undefined);
});

test('codexVersionFromUserAgent takes the server version from the leading token', () => {
  // The leading token is the server's own version; the client's version appears
  // later in the parenthesised suffix and must not win.
  const userAgent = 'melink-agent-sidebar/0.156.1 (Windows 10.0.26200; x86_64) xterm-256color (melink-agent-sidebar; 0.1.0)';
  assert.equal(codexVersionFromUserAgent(userAgent), '0.156.1');
});

test('the pinned version is inside the supported window', () => {
  assert.equal(isSupportedCodexVersion(PINNED_CODEX_VERSION), true);
  // The previously verified pin stays supported so older CLIs keep working.
  assert.equal(isSupportedCodexVersion('0.154.0'), true);
  assert.equal(isSupportedCodexVersion('0.155.7'), true);
  assert.equal(isSupportedCodexVersion('0.156.99'), true);
});

test('a version outside the window is unsupported', () => {
  assert.equal(isSupportedCodexVersion('0.153.0'), false);
  assert.equal(isSupportedCodexVersion('0.157.0'), false);
  assert.equal(isSupportedCodexVersion('1.0.0'), false);
});

test('an unparseable version is never treated as supported', () => {
  assert.equal(isSupportedCodexVersion('main'), false);
  assert.equal(isSupportedCodexVersion(undefined), false);
});

test('the supported range names both ends', () => {
  assert.match(supportedCodexVersionRange(), /0\.154\.0/);
  assert.match(supportedCodexVersionRange(), /0\.156\.x/);
});
