import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AST_GREP_VERSION,
  AST_GREP_MANIFEST,
  astGrepReleaseUrl,
  sha256Hex,
  verifyArchiveSha256
} from './cliManifest.ts';

test('the manifest pins the ast-grep release', () => {
  assert.equal(AST_GREP_VERSION, '0.51.0');
  assert.equal(astGrepReleaseUrl('asset.zip'), 'https://github.com/ast-grep/ast-grep/releases/download/0.51.0/asset.zip');
});

test('sha256Hex matches the known digest of a fixed byte string', () => {
  assert.equal(sha256Hex(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('verifyArchiveSha256 rejects a missing digest and a mismatch with a plain message', () => {
  const archive = Buffer.from('archive-bytes');
  assert.throws(
    () => verifyArchiveSha256('unknown.zip', archive, { ...AST_GREP_MANIFEST, checksums: {} }),
    (error: Error) => {
      assert.match(error.message, /No SHA-256 is pinned.*unknown\.zip.*\(version 0\.51\.0\).*not supported by the pinned release.*Nothing was installed/);
      return true;
    }
  );
  assert.throws(
    () => verifyArchiveSha256('unknown.zip', archive, { ...AST_GREP_MANIFEST, checksums: { 'unknown.zip': '0'.repeat(64) } }),
    (error: Error) => {
      assert.match(error.message, /SHA-256 mismatch.*0\.51\.0.*unknown\.zip/);
      return true;
    }
  );
});

test('archive downloads never use a moving latest release URL', async () => {
  const sources = [
    join('src', 'backends', 'cliManifest.ts'),
    join('src', 'backends', 'opencode', 'install.ts'),
    join('src', 'backends', 'astGrep', 'install.ts')
  ];
  for (const source of sources) {
    const text = await readFile(source, 'utf8');
    assert.doesNotMatch(text, /\/releases\/latest\//, `${source} still uses a latest release URL`);
  }
});
