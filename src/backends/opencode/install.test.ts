import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { extractOpencodeBinary, installOpencodeRelease, opencodeReleaseFilename } from './install.ts';
import { sha256Hex } from '../cliManifest.ts';

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

const filename = 'opencode-linux-x64.tar.gz';
const platform = { os: 'linux' as const, arch: 'x64' as const, baseline: false, musl: false };
const releaseApi = 'https://api.github.com/repos/anomalyco/opencode/releases/latest';

function releaseMetadata(archive: Buffer, version = '1.19.4') {
  return {
    tag_name: `v${version}`, draft: false, prerelease: false,
    assets: [{ name: filename, digest: `sha256:${sha256Hex(archive)}`,
      browser_download_url: `https://github.com/anomalyco/opencode/releases/download/v${version}/${filename}` }]
  };
}

test('install follows latest stable metadata for current and future versions using exact tagged downloads', async () => {
  for (const version of ['1.19.4', '1.20.0', '2.0.0']) {
    const dir = await mkdtemp(join(tmpdir(), 'opencode-install-'));
    const payload = Buffer.from(`installed-cli-${version}`);
    const archive = gzipSync(tarArchive('./opencode', payload));
    const metadata = releaseMetadata(archive, version);
    const requests: string[] = [];
    try {
      const result = await installOpencodeRelease({
        platform, installDir: dir, persistPath: false,
        fetchImpl: async (input) => {
          requests.push(String(input));
          return String(input) === releaseApi ? Response.json(metadata) : new Response(archive);
        }
      });
      assert.equal(result.ok, true, result.message);
      assert.equal(result.version, version);
      assert.deepEqual(requests, [releaseApi, metadata.assets[0].browser_download_url]);
      const installedName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
      assert.equal(result.executablePath, join(dir, installedName));
      assert.deepEqual(await readFile(result.executablePath!), payload);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('Update replaces an existing executable using a newly resolved release on each action', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-upgrade-'));
  const executablePath = join(dir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  try {
    await writeFile(executablePath, 'old-cli');
    for (const version of ['1.19.4', '1.20.0']) {
      const archive = gzipSync(tarArchive('./opencode', Buffer.from(version)));
      const result = await installOpencodeRelease({
        platform, installDir: dir, persistPath: false,
        fetchImpl: async (input, options) => {
          if (String(input) === releaseApi) {
            assert.equal(options?.cache, 'no-store');
            return Response.json(releaseMetadata(archive, version));
          }
          return new Response(archive);
        }
      });
      assert.equal(result.ok, true, result.message);
      assert.equal(result.version, version);
      assert.equal(await readFile(executablePath, 'utf8'), version);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a checksum mismatch leaves an existing executable untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-install-mismatch-'));
  const executablePath = join(dir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  const original = Buffer.from('existing-cli');
  const archive = gzipSync(tarArchive('./opencode', Buffer.from('downloaded-cli')));
  const metadata = releaseMetadata(archive);
  metadata.assets[0].digest = `sha256:${'0'.repeat(64)}`;
  try {
    await writeFile(executablePath, original);
    const result = await installOpencodeRelease({
      platform, installDir: dir, persistPath: false,
      fetchImpl: async (input) => String(input) === releaseApi ? Response.json(metadata) : new Response(archive)
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /SHA-256 mismatch.*1\.19\.4.*opencode-linux-x64\.tar\.gz/);
    assert.deepEqual(await readFile(executablePath), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid release metadata fails before archive download and leaves existing files untouched', async () => {
  const archive = gzipSync(tarArchive('./opencode', Buffer.from('downloaded-cli')));
  const valid = releaseMetadata(archive);
  const invalid = [
    null, {}, { ...valid, prerelease: true }, { ...valid, draft: true },
    { ...valid, tag_name: 'v2.0.0-beta.1' }, { ...valid, tag_name: '../evil' },
    { ...valid, assets: [] }, { ...valid, assets: [null] },
    { ...valid, assets: [valid.assets[0], valid.assets[0]] },
    { ...valid, assets: [{ ...valid.assets[0], digest: null }] },
    { ...valid, assets: [{ ...valid.assets[0], digest: 'sha256:invalid' }] },
    { ...valid, assets: [{ ...valid.assets[0], browser_download_url: 'https://example.com/cli.zip' }] }
  ];
  const dir = await mkdtemp(join(tmpdir(), 'opencode-install-invalid-'));
  const executablePath = join(dir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  try {
    await writeFile(executablePath, 'existing-cli');
    for (const metadata of invalid) {
      let fetched = 0;
      const result = await installOpencodeRelease({
        platform, installDir: dir, persistPath: false,
        fetchImpl: async () => { fetched++; return Response.json(metadata); }
      });
      assert.equal(result.ok, false, JSON.stringify(metadata));
      assert.match(result.message, /Nothing was installed/);
      assert.equal(fetched, 1);
      assert.equal(await readFile(executablePath, 'utf8'), 'existing-cli');
      assert.deepEqual(await readdir(dir), [process.platform === 'win32' ? 'opencode.exe' : 'opencode']);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing platform asset fails before archive download and creates nothing', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'opencode-install-arm64-'));
  const installDir = join(parent, 'not-created');
  let fetched = 0;
  try {
    const result = await installOpencodeRelease({
      platform: { os: 'windows', arch: 'arm64', baseline: false, musl: false },
      installDir, persistPath: false,
      fetchImpl: async () => { fetched++; return Response.json(releaseMetadata(Buffer.from('archive'))); }
    });
    assert.equal(fetched, 1);
    assert.equal(result.ok, false);
    assert.match(result.message, /1\.19\.4.*does not provide opencode-windows-arm64\.zip/);
    await assert.rejects(readdir(installDir), /ENOENT/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('metadata HTTP, network, malformed JSON and size failures return actionable errors', async () => {
  for (const fetchImpl of [
    async () => new Response('rate limited', { status: 403 }),
    async () => new Response('unavailable', { status: 503 }),
    async () => { throw new Error('offline'); },
    async () => new Response('{broken'),
    async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))
  ]) {
    const result = await installOpencodeRelease({ platform, persistPath: false, fetchImpl });
    assert.equal(result.ok, false);
    assert.match(result.message, /Could not check|could not be read/);
    assert.equal(result.executablePath, undefined);
  }
});

test('a failed archive download returns an error and creates no install directory', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'opencode-install-network-'));
  const installDir = join(parent, 'not-created');
  try {
    const result = await installOpencodeRelease({
      platform, installDir, persistPath: false,
      fetchImpl: async (input) => String(input) === releaseApi
        ? Response.json(releaseMetadata(Buffer.from('archive')))
        : new Response('missing', { status: 404 })
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /could not be downloaded/);
    await assert.rejects(readdir(installDir), /ENOENT/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
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
