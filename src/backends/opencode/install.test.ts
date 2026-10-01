import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { extractOpencodeBinary, installOpencodeRelease, opencodeReleaseFilename } from './install.ts';

test('release asset names follow the official install script', () => {
  assert.equal(
    opencodeReleaseFilename({ os: 'windows', arch: 'x64', baseline: false, musl: false }),
    'opencode-windows-x64.zip'
  );
  assert.equal(
    opencodeReleaseFilename({ os: 'windows', arch: 'x64', baseline: true, musl: false }),
    'opencode-windows-x64-baseline.zip'
  );
  assert.equal(
    opencodeReleaseFilename({ os: 'darwin', arch: 'arm64', baseline: false, musl: false }),
    'opencode-darwin-arm64.zip'
  );
  assert.equal(
    opencodeReleaseFilename({ os: 'linux', arch: 'x64', baseline: true, musl: true }),
    'opencode-linux-x64-baseline-musl.tar.gz'
  );
  assert.equal(
    opencodeReleaseFilename({ os: 'linux', arch: 'arm64', baseline: false, musl: true }),
    'opencode-linux-arm64-musl.tar.gz'
  );
});

test('a stored zip yields the opencode binary, including a nested path', () => {
  const payload = Buffer.from('cli-bytes');
  const archive = zipArchive([
    { name: 'README.md', data: Buffer.from('docs') },
    { name: 'bin/opencode', data: payload }
  ]);
  assert.deepEqual(extractOpencodeBinary(archive), payload);
});

test('a deflated zip yields the opencode binary', () => {
  const payload = Buffer.from('deflated-cli');
  const archive = zipArchive([{ name: 'opencode.exe', data: payload, method: 8 }]);
  assert.deepEqual(extractOpencodeBinary(archive), payload);
});

test('a path that leaves the archive is not treated as the CLI', () => {
  const archive = zipArchive([{ name: '../opencode', data: Buffer.from('nope') }]);
  assert.throws(() => extractOpencodeBinary(archive), /did not contain the CLI/);
});

test('a gzip tar yields the opencode binary', () => {
  const payload = Buffer.from('tar-cli');
  const archive = gzipSync(tarArchive('opencode', payload));
  assert.deepEqual(extractOpencodeBinary(archive), payload);
});

test('install writes the downloaded CLI into the install directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-install-'));
  const payload = Buffer.from('installed-cli');
  const archive = gzipSync(tarArchive('./opencode', payload));
  let requested = '';
  try {
    const result = await installOpencodeRelease({
      platform: { os: 'linux', arch: 'x64', baseline: false, musl: false },
      installDir: dir,
      persistPath: false,
      fetchImpl: async (input) => {
        requested = String(input);
        return new Response(archive, { status: 200 });
      }
    });
    assert.equal(result.ok, true);
    assert.match(requested, /\/opencode-linux-x64\.tar\.gz$/);
    const installedName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
    assert.equal(result.executablePath, join(dir, installedName));
    assert.deepEqual(await readFile(result.executablePath ?? ''), payload);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed download is a message and does not throw', async () => {
  const result = await installOpencodeRelease({
    platform: { os: 'darwin', arch: 'arm64', baseline: false, musl: false },
    installDir: join(tmpdir(), 'opencode-install-unused'),
    persistPath: false,
    fetchImpl: async () => new Response('missing', { status: 404 })
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /could not be downloaded/);
  assert.equal(result.executablePath, undefined);
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

function tarArchive(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(data.length.toString(8).padStart(11, '0'), 124);
  header.write('\0', 135);
  header.write('00000000000\0', 136);
  header.fill(0x20, 148, 156);
  header[156] = 48;
  let sum = 0;
  for (const byte of header) {
    sum += byte;
  }
  header.write(sum.toString(8).padStart(6, '0'), 148);
  header[154] = 0;
  header[155] = 0x20;
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded, Buffer.alloc(1024)]);
}
