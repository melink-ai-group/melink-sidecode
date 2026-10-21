import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { astGrepReleaseFilename, extractAstGrepBinary, installAstGrepRelease } from './install.ts';
import { AST_GREP_SHA256, AST_GREP_VERSION, astGrepReleaseUrl, sha256Hex } from '../cliManifest.ts';

test('a stored zip yields the ast-grep binary', () => {
  const payload = Buffer.from('ast-grep-cli');
  const archive = zipArchive([{ name: 'ast-grep', data: payload }]);
  assert.deepEqual(extractAstGrepBinary(archive), payload);
});

test('a deflated zip yields the ast-grep binary', () => {
  const payload = Buffer.from('deflated-ast-grep');
  const archive = zipArchive([{ name: 'ast-grep.exe', data: payload, method: 8 }]);
  assert.deepEqual(extractAstGrepBinary(archive), payload);
});

test('an archive holding the sg wrapper and the real CLI picks ast-grep', () => {
  const wrapper = Buffer.from('deprecated-sg-wrapper');
  const cli = Buffer.from('real-ast-grep-cli');
  const archive = zipArchive([
    { name: 'sg', data: wrapper },
    { name: 'ast-grep', data: cli }
  ]);
  assert.deepEqual(extractAstGrepBinary(archive), cli);
  const windowsArchive = zipArchive([
    { name: 'sg.exe', data: wrapper },
    { name: 'ast-grep.exe', data: cli }
  ]);
  assert.deepEqual(extractAstGrepBinary(windowsArchive), cli);
});

test('install writes the downloaded ast-grep binary after checksum verification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ast-grep-install-'));
  const payload = Buffer.from('installed-ast-grep');
  const archive = zipArchive([{ name: 'ast-grep', data: payload }]);
  let requested = '';
  try {
    const result = await installAstGrepRelease({
      platform: { os: 'linux', arch: 'x64' },
      installDir: dir,
      checksums: { 'app-x86_64-unknown-linux-gnu.zip': sha256Hex(archive) },
      fetchImpl: async (input) => {
        requested = String(input);
        return new Response(archive, { status: 200 });
      }
    });
    assert.equal(result.ok, true);
    assert.match(requested, /\/download\/0\.51\.0\/app-x86_64-unknown-linux-gnu\.zip$/);
    assert.doesNotMatch(requested, /latest/i);
    const installedName = process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep';
    assert.equal(result.executablePath, join(dir, installedName));
    assert.deepEqual(await readFile(result.executablePath ?? ''), payload);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a checksum mismatch leaves an existing ast-grep executable untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ast-grep-install-mismatch-'));
  const installedName = process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep';
  const executablePath = join(dir, installedName);
  const original = Buffer.from('existing-ast-grep');
  try {
    await writeFile(executablePath, original);
    const archive = zipArchive([{ name: 'ast-grep', data: Buffer.from('downloaded-ast-grep') }]);
    const result = await installAstGrepRelease({
      platform: { os: 'linux', arch: 'x64' },
      installDir: dir,
      checksums: { 'app-x86_64-unknown-linux-gnu.zip': '0'.repeat(64) },
      fetchImpl: async () => new Response(archive, { status: 200 })
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /SHA-256 mismatch.*0\.51\.0.*app-x86_64-unknown-linux-gnu\.zip/);
    assert.deepEqual(await readFile(executablePath), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing ast-grep checksum entry fails before download and without writing the executable', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ast-grep-install-missing-'));
  const installDir = join(parent, 'not-created');
  const installedName = process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep';
  let fetched = false;
  try {
    const archive = zipArchive([{ name: 'ast-grep', data: Buffer.from('downloaded-ast-grep') }]);
    const result = await installAstGrepRelease({
      platform: { os: 'linux', arch: 'x64' },
      installDir,
      checksums: {},
      fetchImpl: async () => {
        fetched = true;
        return new Response(archive, { status: 200 });
      }
    });
    assert.equal(result.ok, false);
    assert.equal(fetched, false);
    assert.match(result.message, /No SHA-256 is pinned.*app-x86_64-unknown-linux-gnu\.zip.*\(version 0\.51\.0\).*not supported by the pinned release.*Nothing was installed/);
    assert.equal(result.executablePath, undefined);
    await assert.rejects(readFile(join(installDir, installedName)), /ENOENT/);
    await assert.rejects(readdir(installDir), /ENOENT/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('every ast-grep asset name has a pinned digest', () => {
  const platforms = [
    { os: 'windows' as const, arch: 'x64' as const },
    { os: 'windows' as const, arch: 'arm64' as const },
    { os: 'darwin' as const, arch: 'x64' as const },
    { os: 'darwin' as const, arch: 'arm64' as const },
    { os: 'linux' as const, arch: 'x64' as const },
    { os: 'linux' as const, arch: 'arm64' as const }
  ];
  assert.equal(Object.keys(AST_GREP_SHA256).length, 6);
  for (const platform of platforms) {
    const filename = astGrepReleaseFilename(platform);
    assert.match(AST_GREP_SHA256[filename] ?? '', /^[0-9a-f]{64}$/, `${filename} is missing a digest`);
    assert.equal(astGrepReleaseUrl(filename), `https://github.com/ast-grep/ast-grep/releases/download/${AST_GREP_VERSION}/${filename}`);
  }
});

test('ast-grep release URLs use the pinned tag instead of latest', () => {
  const url = astGrepReleaseUrl('app-x86_64-unknown-linux-gnu.zip');
  assert.equal(url, 'https://github.com/ast-grep/ast-grep/releases/download/0.51.0/app-x86_64-unknown-linux-gnu.zip');
  assert.doesNotMatch(url, /latest/i);
});

function zipArchive(files: { name: string; data: Buffer; method?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const method = file.method ?? 0;
    const payload = method === 8 ? deflateRawSync(file.data) : file.data;
    const name = Buffer.from(file.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localRecord = Buffer.concat([local, name, payload]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    locals.push(localRecord);
    offset += localRecord.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}
