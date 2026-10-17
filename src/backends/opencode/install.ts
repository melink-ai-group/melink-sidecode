import { execFile } from 'node:child_process';
import { appendFile, chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';

/**
 * Download the official opencode CLI and install it for the settings screen.
 *
 * The bytes come from the anomalyco/opencode GitHub release named by the same
 * asset the opencode install script uses. Nothing is piped through a shell.
 * The caller chooses `installDir` (bundled `vendor/opencode/bin`, a local
 * absolute path's parent, or `~/.opencode/bin`). SideCode upgrades by calling
 * this again rather than `opencode upgrade`, which can report success without
 * replacing the binary the path setting points at.
 */

export interface OpencodeInstallPlatform {
  os: 'windows' | 'darwin' | 'linux';
  arch: 'x64' | 'arm64';
  /** x64 machines without AVX2 need the baseline build. */
  baseline: boolean;
  /** Alpine and other musl hosts need the musl build. */
  musl: boolean;
}

export interface OpencodeInstallResult {
  ok: boolean;
  message: string;
  /** Absolute path of the installed binary when `ok` is true. */
  executablePath?: string;
}

export interface InstallOpencodeOptions {
  platform?: OpencodeInstallPlatform;
  /** Defaults to `~/.opencode/bin`. */
  installDir?: string;
  fetchImpl?: typeof fetch;
  /**
   * When false, the user PATH and shell rc are left alone. Tests set this so
   * a fixture install cannot change the machine running the suite.
   */
  persistPath?: boolean;
}

/** Hard cap so a bad response cannot fill memory. The release archives are smaller. */
const MAX_ARCHIVE_BYTES = 120 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const RELEASE_BASE = 'https://github.com/anomalyco/opencode/releases/latest/download/';

/** Asset file name for one platform, matching the official install script. */
export function opencodeReleaseFilename(platform: OpencodeInstallPlatform): string {
  let target = `${platform.os}-${platform.arch}`;
  if (platform.baseline && platform.arch === 'x64') {
    target += '-baseline';
  }
  if (platform.musl && platform.os === 'linux') {
    target += '-musl';
  }
  const extension = platform.os === 'linux' ? '.tar.gz' : '.zip';
  return `opencode-${target}${extension}`;
}

/**
 * Pull the opencode binary out of a release archive.
 *
 * Zip entries are read from the central directory, so a data-descriptor local
 * header still yields the real sizes. Tar entries are read after gunzip. Only
 * a file whose base name is `opencode` or `opencode.exe` is returned; the
 * archive path is never used as a write destination.
 */
export function extractOpencodeBinary(archive: Buffer): Buffer {
  if (archive.length >= 2 && archive[0] === 0x1f && archive[1] === 0x8b) {
    return pickBinary(readTar(gunzipSync(archive)));
  }
  if (archive.length >= 4 && archive.readUInt32LE(0) === 0x04034b50) {
    return pickBinary(readZip(archive));
  }
  throw new Error('The download was not an opencode archive.');
}

/** Download the release for this machine and write the CLI into the install directory. */
export async function installOpencodeRelease(
  options: InstallOpencodeOptions = {}
): Promise<OpencodeInstallResult> {
  try {
    const platform = options.platform ?? (await detectOpencodePlatform());
    const installDir = options.installDir ?? join(homedir(), '.opencode', 'bin');
    const filename = opencodeReleaseFilename(platform);
    const archive = await downloadRelease(filename, options.fetchImpl ?? fetch);
    const binary = extractOpencodeBinary(archive);
    const executableName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
    const executablePath = join(installDir, executableName);
    await mkdir(installDir, { recursive: true });
    // Write beside the target then rename so an in-use Windows binary can be
    // replaced more reliably than an in-place overwrite.
    const stagingPath = join(installDir, `.opencode-download-${randomBytes(6).toString('hex')}`);
    await writeFile(stagingPath, binary);
    if (process.platform !== 'win32') {
      await chmod(stagingPath, 0o755);
    }
    try {
      await rename(stagingPath, executablePath);
    } catch (error) {
      // Windows often refuses rename-over-existing; delete then rename.
      try {
        await unlink(executablePath);
        await rename(stagingPath, executablePath);
      } catch {
        await unlink(stagingPath).catch(() => undefined);
        throw error;
      }
    }
    if (options.persistPath !== false) {
      await rememberInstallDir(installDir);
    }
    return { ok: true, message: 'opencode installed.', executablePath };
  } catch (error) {
    return { ok: false, message: installErrorMessage(error) };
  }
}

async function detectOpencodePlatform(): Promise<OpencodeInstallPlatform> {
  const os =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : undefined;
  const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined;
  if (!os || !arch) {
    throw new Error('This operating system is not supported by the opencode installer.');
  }
  const baseline = arch === 'x64' ? !(await hasAvx2(os)) : false;
  const musl = os === 'linux' ? await isMusl() : false;
  return { os, arch, baseline, musl };
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
    throw new Error('The opencode download failed. Check the network and try again.');
  }
  if (!response.ok) {
    throw new Error('The opencode release for this machine could not be downloaded.');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
    throw new Error('The opencode download was larger than expected, so it was stopped.');
  }
  return readLimited(response, MAX_ARCHIVE_BYTES);
}

async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffered = Buffer.from(await response.arrayBuffer());
    if (buffered.length > maxBytes) {
      throw new Error('The opencode download was larger than expected, so it was stopped.');
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
      throw new Error('The opencode download was larger than expected, so it was stopped.');
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
    throw new Error('The opencode archive did not contain the CLI.');
  }
  return best.data;
}

/** 2 for `opencode.exe`, 1 for `opencode`, 0 when the name is not the CLI. */
function binaryRank(name: string): number {
  const base = safeBaseName(name);
  if (!base) {
    return 0;
  }
  if (base === 'opencode.exe') {
    return 2;
  }
  if (base === 'opencode') {
    return 1;
  }
  return 0;
}

/** The final path segment, or undefined when the name tries to leave its directory. */
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
    throw new Error('The opencode archive could not be read.');
  }
  const count = archive.readUInt16LE(eocd + 10);
  const files: ArchiveFile[] = [];
  let cursor = cdOffset;
  const cdEnd = cdOffset + cdSize;
  for (let index = 0; index < count && cursor + 46 <= archive.length && cursor + 46 <= cdEnd; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('The opencode archive could not be read.');
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
    throw new Error('The opencode archive could not be read.');
  }
  const nameLength = archive.readUInt16LE(localOffset + 26);
  const extraLength = archive.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > archive.length) {
    throw new Error('The opencode archive could not be read.');
  }
  const compressed = archive.subarray(dataStart, dataEnd);
  if (method === 0) {
    return Buffer.from(compressed);
  }
  if (method === 8) {
    return inflateRawSync(compressed);
  }
  throw new Error('The opencode archive could not be read.');
}

function findEocd(archive: Buffer): number {
  const start = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= start; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error('The download was not an opencode archive.');
}

function readTar(tar: Buffer): ArchiveFile[] {
  const files: ArchiveFile[] = [];
  let offset = 0;
  let pendingName: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const stored = parseInt(header.subarray(148, 156).toString('utf8').replace(/\0/g, '').trim(), 8);
    if (stored !== tarChecksum(header)) {
      throw new Error('The opencode archive could not be read.');
    }
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0/g, '').trim(), 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error('The opencode archive could not be read.');
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      throw new Error('The opencode archive could not be read.');
    }
    const data = tar.subarray(dataStart, dataEnd);
    let name = cString(header.subarray(0, 100));
    const prefix = cString(header.subarray(345, 500));
    if (prefix) {
      name = `${prefix}/${name}`;
    }
    if (pendingName) {
      name = pendingName;
      pendingName = undefined;
    }
    const type = header[156];
    if (type === 76) {
      pendingName = cString(data);
    } else if ((type === 0 || type === 48) && binaryRank(name) > 0) {
      files.push({ name, data: Buffer.from(data) });
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function cString(value: Buffer): string {
  const end = value.indexOf(0);
  return (end === -1 ? value : value.subarray(0, end)).toString('utf8');
}

function tarChecksum(header: Buffer): number {
  let sum = 0;
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index] ?? 0;
  }
  return sum;
}

/**
 * Make later processes able to resolve `opencode`. The extension itself uses
 * the absolute path written into settings, so a failed PATH update does not
 * fail the install.
 */
async function rememberInstallDir(dir: string): Promise<void> {
  prependProcessPath(dir);
  try {
    if (process.platform === 'win32') {
      await persistWindowsUserPath(dir);
    } else {
      await persistUnixShellPath(dir);
    }
  } catch {
    // The settings path is the one the sidebar uses. A shell PATH update is extra.
  }
}

function prependProcessPath(dir: string): void {
  const sep = process.platform === 'win32' ? ';' : ':';
  const current = process.env.PATH ?? process.env.Path ?? '';
  const already = current.split(sep).some((entry) => entry.replace(/[\\/]+$/, '') === dir.replace(/[\\/]+$/, ''));
  if (already) {
    return;
  }
  const next = current ? `${dir}${sep}${current}` : dir;
  process.env.PATH = next;
  if (process.platform === 'win32') {
    process.env.Path = next;
  }
}

async function persistWindowsUserPath(dir: string): Promise<void> {
  const script = [
    "$dir = $env:MELINK_OPENCODE_BIN",
    "if (-not $dir) { exit 1 }",
    "$user = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "$needle = $dir.TrimEnd('\\')",
    "$parts = @()",
    "if ($user) { $parts = $user -split ';' | Where-Object { $_.Trim() -and ($_.Trim().TrimEnd('\\') -ine $needle) } }",
    "$next = (@($dir) + $parts) -join ';'",
    "[Environment]::SetEnvironmentVariable('Path', $next, 'User')"
  ].join('; ');
  await execCaptured('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    ...process.env,
    MELINK_OPENCODE_BIN: dir
  });
}

async function persistUnixShellPath(dir: string): Promise<void> {
  if (dir.includes('"') || dir.includes('\n')) {
    return;
  }
  const home = homedir();
  const shellName = basename(process.env.SHELL || 'bash');
  const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
  const line = shellName === 'fish' ? `fish_add_path "${dir}"` : `export PATH="${dir}:$PATH"`;
  for (const file of shellConfigCandidates(shellName, home, xdg)) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      return;
    }
    if (text.includes('.opencode/bin')) {
      return;
    }
    const suffix = text.endsWith('\n') || text.length === 0 ? '' : '\n';
    await appendFile(file, `${suffix}\n# opencode\n${line}\n`);
    return;
  }
}

function shellConfigCandidates(shellName: string, home: string, xdg: string): string[] {
  switch (shellName) {
    case 'zsh':
      return [join(home, '.zshrc'), join(home, '.zshenv'), join(xdg, 'zsh', '.zshrc')];
    case 'fish':
      return [join(home, '.config', 'fish', 'config.fish')];
    case 'bash':
      return [join(home, '.bashrc'), join(home, '.bash_profile'), join(xdg, 'bash', '.bashrc')];
    default:
      return [join(home, '.bashrc'), join(home, '.profile')];
  }
}

function execCaptured(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15_000, windowsHide: true, env }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function hasAvx2(os: OpencodeInstallPlatform['os']): Promise<boolean> {
  try {
    if (os === 'linux') {
      const cpu = await readFile('/proc/cpuinfo', 'utf8');
      return /\bavx2\b/i.test(cpu);
    }
    if (os === 'darwin') {
      const output = await execText('sysctl', ['-n', 'hw.optional.avx2_0']);
      return output.trim() === '1';
    }
    const output = await execText('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Add-Type -MemberDefinition \'[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);\' -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'
    ]);
    const value = output.trim().toLowerCase();
    return value === 'true' || value === '1';
  } catch {
    // The official installer uses the baseline build when the CPU check cannot be read.
    return false;
  }
}

async function isMusl(): Promise<boolean> {
  try {
    await readFile('/etc/alpine-release', 'utf8');
    return true;
  } catch {
    // Not Alpine. Fall through to ldd, which prints musl on musl hosts.
  }
  try {
    const output = await execText('ldd', ['--version']);
    return /musl/i.test(output);
  } catch {
    return false;
  }
}

function execText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 8_000, windowsHide: true }, (error, stdout, stderr) => {
      const text = `${stdout ?? ''}${stderr ?? ''}`;
      if (error && text.trim().length === 0) {
        reject(error);
        return;
      }
      resolve(text);
    });
  });
}

function installErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    if ((error as NodeJS.ErrnoException).code === 'EBUSY' || (error as NodeJS.ErrnoException).code === 'EPERM') {
      return 'opencode is in use, so it could not be replaced. Quit it and try again.';
    }
    return error.message;
  }
  return 'opencode could not be installed.';
}
