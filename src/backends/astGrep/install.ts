import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { astGrepExecutableName } from './resolve.ts';

/**
 * Download the official ast-grep CLI release into an install directory.
 *
 * Assets come from ast-grep/ast-grep GitHub releases (`app-<triple>.zip`).
 */

export interface AstGrepInstallPlatform {
  os: 'windows' | 'darwin' | 'linux';
  arch: 'x64' | 'arm64';
}

export interface AstGrepInstallResult {
  ok: boolean;
  message: string;
  executablePath?: string;
}

export interface InstallAstGrepOptions {
  platform?: AstGrepInstallPlatform;
  installDir: string;
  fetchImpl?: typeof fetch;
}

const MAX_ARCHIVE_BYTES = 80 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const RELEASE_BASE = 'https://github.com/ast-grep/ast-grep/releases/latest/download/';

/** Release zip name for one platform. */
export function astGrepReleaseFilename(platform: AstGrepInstallPlatform): string {
  const triple =
    platform.os === 'windows'
      ? platform.arch === 'arm64'
        ? 'aarch64-pc-windows-msvc'
        : 'x86_64-pc-windows-msvc'
      : platform.os === 'darwin'
        ? platform.arch === 'arm64'
          ? 'aarch64-apple-darwin'
          : 'x86_64-apple-darwin'
        : platform.arch === 'arm64'
          ? 'aarch64-unknown-linux-gnu'
          : 'x86_64-unknown-linux-gnu';
  return `app-${triple}.zip`;
}

export function extractAstGrepBinary(archive: Buffer): Buffer {
  if (archive.length >= 4 && archive.readUInt32LE(0) === 0x04034b50) {
    return pickBinary(readZip(archive));
  }
  throw new Error('The download was not an ast-grep archive.');
}

export async function installAstGrepRelease(
  options: InstallAstGrepOptions
): Promise<AstGrepInstallResult> {
  try {
    const platform = options.platform ?? detectAstGrepPlatform();
    const filename = astGrepReleaseFilename(platform);
    const archive = await downloadRelease(filename, options.fetchImpl ?? fetch);
    const binary = extractAstGrepBinary(archive);
    const executableName = astGrepExecutableName();
    const executablePath = join(options.installDir, executableName);
    await mkdir(options.installDir, { recursive: true });
    const stagingPath = join(options.installDir, `.ast-grep-download-${randomBytes(6).toString('hex')}`);
    await writeFile(stagingPath, binary);
    if (process.platform !== 'win32') {
      await chmod(stagingPath, 0o755);
    }
    try {
      await rename(stagingPath, executablePath);
    } catch (error) {
      try {
        await unlink(executablePath);
        await rename(stagingPath, executablePath);
      } catch {
        await unlink(stagingPath).catch(() => undefined);
        throw error;
      }
    }
    return { ok: true, message: 'ast-grep installed.', executablePath };
  } catch (error) {
    return { ok: false, message: installErrorMessage(error) };
  }
}

function detectAstGrepPlatform(): AstGrepInstallPlatform {
  const os =
    process.platform === 'win32'
      ? 'windows'
      : process.platform === 'darwin'
        ? 'darwin'
        : process.platform === 'linux'
          ? 'linux'
          : undefined;
  const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined;
  if (!os || !arch) {
    throw new Error('This operating system is not supported by the ast-grep installer.');
  }
  return { os, arch };
}

async function downloadRelease(filename: string, fetchImpl: typeof fetch): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchImpl(`${RELEASE_BASE}${filename}`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': 'melink-sidecode'
      }
    });
  } catch {
    throw new Error('The ast-grep download failed. Check the network and try again.');
  }
  if (!response.ok) {
    throw new Error('The ast-grep release for this machine could not be downloaded.');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
    throw new Error('The ast-grep download was larger than expected, so it was stopped.');
  }
  return readLimited(response, MAX_ARCHIVE_BYTES);
}

async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffered = Buffer.from(await response.arrayBuffer());
    if (buffered.length > maxBytes) {
      throw new Error('The ast-grep download was larger than expected, so it was stopped.');
    }
    return buffered;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('The ast-grep download was larger than expected, so it was stopped.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

interface ArchiveFile {
  name: string;
  data: Buffer;
}

function pickBinary(files: ArchiveFile[]): Buffer {
  let best: { rank: number; data: Buffer } | undefined;
  for (const file of files) {
    const rank = binaryRank(file.name);
    if (rank > 0 && (!best || rank > best.rank)) {
      best = { rank, data: file.data };
    }
  }
  if (!best || best.data.length === 0) {
    throw new Error('The ast-grep archive did not contain the CLI.');
  }
  return best.data;
}

function binaryRank(name: string): number {
  const base = safeBaseName(name);
  if (!base) {
    return 0;
  }
  if (base === 'ast-grep.exe' || base === 'sg.exe') {
    return 2;
  }
  if (base === 'ast-grep' || base === 'sg') {
    return 1;
  }
  return 0;
}

function safeBaseName(name: string): string | undefined {
  const parts = name
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.');
  if (parts.includes('..')) {
    return undefined;
  }
  const base = parts[parts.length - 1]?.toLowerCase() ?? '';
  return base.length > 0 ? base : undefined;
}

function readZip(archive: Buffer): ArchiveFile[] {
  const eocd = findEocd(archive);
  const cdOffset = archive.readUInt32LE(eocd + 16);
  const cdSize = archive.readUInt32LE(eocd + 12);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error('The ast-grep archive could not be read.');
  }
  const count = archive.readUInt16LE(eocd + 10);
  const files: ArchiveFile[] = [];
  let cursor = cdOffset;
  const cdEnd = cdOffset + cdSize;
  for (let index = 0; index < count && cursor + 46 <= archive.length && cursor + 46 <= cdEnd; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('The ast-grep archive could not be read.');
    }
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (binaryRank(name) === 0 || name.endsWith('/')) {
      continue;
    }
    files.push({ name, data: inflateZipEntry(archive, localOffset, method, compressedSize) });
  }
  return files;
}

function inflateZipEntry(archive: Buffer, localOffset: number, method: number, compressedSize: number): Buffer {
  if (localOffset + 30 > archive.length) {
    throw new Error('The ast-grep archive could not be read.');
  }
  const nameLength = archive.readUInt16LE(localOffset + 26);
  const extraLength = archive.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > archive.length) {
    throw new Error('The ast-grep archive could not be read.');
  }
  const compressed = archive.subarray(dataStart, dataEnd);
  if (method === 0) {
    return Buffer.from(compressed);
  }
  if (method === 8) {
    return inflateRawSync(compressed);
  }
  throw new Error('The ast-grep archive could not be read.');
}

function findEocd(archive: Buffer): number {
  const start = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= start; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error('The download was not an ast-grep archive.');
}

function installErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'ast-grep could not be installed.';
}
