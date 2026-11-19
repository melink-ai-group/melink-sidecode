import test from 'node:test';
import assert from 'node:assert/strict';
import { browserImageAttachment } from './capture.ts';

const pngBase64 = Buffer.from('png-bytes').toString('base64');

test('a saved capture names the PNG and keeps its path', () => {
  const path = 'C:\\work\\.melink\\reports\\browser\\20261021-123456-789-001-login.png';
  const attachment = browserImageAttachment({
    pngBase64,
    title: 'Login',
    url: 'http://localhost:3000/login',
    path,
    kind: 'page'
  });
  assert.match(attachment.id, /^att_/);
  assert.equal(attachment.name, '20261021-123456-789-001-login.png');
  assert.equal(attachment.path, path);
  assert.equal(attachment.mimeType, 'image/png');
  assert.equal(attachment.kind, 'image');
  assert.equal(attachment.size, Buffer.byteLength('png-bytes'));
  assert.equal(attachment.dataUrl, `data:image/png;base64,${pngBase64}`);

  const posix = browserImageAttachment({
    pngBase64,
    title: 'Login',
    url: 'http://localhost:3000/login',
    path: '/home/dev/.melink/reports/browser/shot.png',
    kind: 'page'
  });
  assert.equal(posix.name, 'shot.png');
  assert.equal(posix.path, '/home/dev/.melink/reports/browser/shot.png');
});

test('an unsaved snippet is named from its kind, time, and URL host', () => {
  const attachment = browserImageAttachment({
    pngBase64,
    title: '',
    url: 'http://localhost:5173/app?token=secret',
    kind: 'snippet',
    now: new Date(2026, 0, 2, 3, 4, 5, 6)
  });
  assert.equal(attachment.name, 'snippet-20260102-030405-006-localhost.png');
  assert.equal(attachment.path, undefined);
  assert.equal(attachment.size, Buffer.byteLength('png-bytes'));
});

test('an unsaved full capture falls back to a readable base name', () => {
  const attachment = browserImageAttachment({
    pngBase64,
    title: 'A page title!',
    url: 'http://example.com/',
    kind: 'page',
    now: new Date(2026, 0, 2, 3, 4, 5, 6)
  });
  assert.equal(attachment.name, 'page-20260102-030405-006-a-page-title.png');
});

test('an empty capture is refused instead of attaching an empty image', () => {
  assert.throws(
    () =>
      browserImageAttachment({
        pngBase64: '',
        title: 'Empty',
        url: 'http://localhost:3000/',
        kind: 'page'
      }),
    /empty/i
  );
});
