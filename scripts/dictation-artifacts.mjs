/**
 * Host-free descriptions of the dictation binaries a packaged extension must
 * carry. A release is built on the platform it targets, so every path here is
 * derived from that build host and never from another platform.
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const RELEASE_TARGETS = Object.freeze([
  'win32-x64',
  'linux-x64',
  'darwin-x64',
  'darwin-arm64'
]);

const LICENSE_PLATFORMS = new Set(['win32', 'darwin', 'linux']);

export function targetName(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function isReleaseTarget(platform, arch) {
  return RELEASE_TARGETS.includes(targetName(platform, arch));
}

export function describeHost(platform = process.platform, arch = process.arch) {
  return targetName(platform, arch);
}

export function ffmpegFileName(platform = process.platform) {
  return platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

export function ffmpegLicenseFileName(platform = process.platform) {
  return `${ffmpegFileName(platform)}.LICENSE`;
}

/** ffmpeg-static publishes a LICENSE asset for every platform sideCode releases. */
export function ffmpegLicenseExpected(platform = process.platform) {
  return LICENSE_PLATFORMS.has(platform);
}

export function hostFfmpegPath(modulesDir, platform = process.platform) {
  return path.join(modulesDir, 'ffmpeg-static', ffmpegFileName(platform));
}

export function hostFfmpegLicensePath(modulesDir, platform = process.platform) {
  return path.join(modulesDir, 'ffmpeg-static', ffmpegLicenseFileName(platform));
}

export function hostOnnxBinaryDir(modulesDir, platform = process.platform, arch = process.arch) {
  return path.join(modulesDir, 'onnxruntime-node', 'bin', 'napi-v3', platform, arch);
}

export function onnxRuntimeFilePattern(platform = process.platform) {
  if (platform === 'win32') {
    return /^onnxruntime\.dll$/i;
  }
  if (platform === 'darwin') {
    return /^libonnxruntime(\..+)?\.dylib$/i;
  }
  return /^libonnxruntime(\..+)?\.so(\.\d+)*$/i;
}

/**
 * Names missing from an ONNX platform directory. Requires the native binding
 * plus that platform's shared runtime, so an empty or partial directory is
 * rejected rather than mistaken for a usable binary.
 */
export function missingOnnxFiles(fileNames, platform = process.platform) {
  const missing = [];
  if (!fileNames.includes('onnxruntime_binding.node')) {
    missing.push('onnxruntime_binding.node');
  }
  const runtime = onnxRuntimeFilePattern(platform);
  if (!fileNames.some((name) => runtime.test(name))) {
    missing.push(
      platform === 'win32'
        ? 'onnxruntime.dll'
        : platform === 'darwin'
          ? 'libonnxruntime*.dylib'
          : 'libonnxruntime*.so*'
    );
  }
  return missing;
}

/**
 * Problems with one host or staged ONNX platform directory. Missing files and
 * zero-byte files are both reported so a stale or partial directory cannot pass.
 */
export function onnxDirectoryProblems(dir, platform = process.platform) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [`${dir} does not exist`];
  }
  const stats = statSync(dir);
  if (!stats.isDirectory()) {
    return [`${dir} is not a directory`];
  }

  const sizes = new Map();
  for (const entry of entries) {
    if (entry.isFile()) {
      sizes.set(entry.name, statSync(path.join(dir, entry.name)).size);
    }
  }

  const problems = [];
  for (const missing of missingOnnxFiles([...sizes.keys()], platform)) {
    problems.push(`${missing} is missing`);
  }
  for (const [name, size] of sizes) {
    if (size === 0) {
      problems.push(`${name} is empty`);
    }
  }
  return problems;
}

export function stagedFfmpegPath(extensionPath, platform = process.platform) {
  return path.join(extensionPath, 'dist', 'bin', ffmpegFileName(platform));
}

export function stagedFfmpegLicensePath(extensionPath, platform = process.platform) {
  return path.join(extensionPath, 'dist', 'bin', ffmpegLicenseFileName(platform));
}

export function stagedTranscribePath(extensionPath) {
  return path.join(extensionPath, 'dist', 'dictation-runtime', 'transcribe.mjs');
}

export function stagedOnnxBinaryDir(extensionPath, platform = process.platform, arch = process.arch) {
  return path.join(
    extensionPath,
    'dist',
    'dictation-runtime',
    'node_modules',
    'onnxruntime-node',
    'bin',
    'napi-v3',
    platform,
    arch
  );
}

/**
 * Exact files a package for `platform`/`arch` must contain. Used by
 * verify-dictation.mjs and by the path unit test.
 */
export function expectedArtifacts(extensionPath, platform = process.platform, arch = process.arch) {
  const artifacts = [
    { role: 'ffmpeg', path: stagedFfmpegPath(extensionPath, platform), kind: 'file' }
  ];
  if (ffmpegLicenseExpected(platform)) {
    artifacts.push({
      role: 'ffmpeg license',
      path: stagedFfmpegLicensePath(extensionPath, platform),
      kind: 'file'
    });
  }
  artifacts.push(
    { role: 'Whisper runtime', path: stagedTranscribePath(extensionPath), kind: 'file' },
    { role: 'ONNX runtime', path: stagedOnnxBinaryDir(extensionPath, platform, arch), kind: 'directory' }
  );
  return artifacts;
}

function unexpectedEntryNames(dir, allowed) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = new Set(allowed);
  return entries.map((entry) => entry.name).filter((name) => !names.has(name));
}

/**
 * Testable verification used by verify-dictation.mjs. Returns an empty array
 * when every expected artifact is present, non-empty, the staged ONNX
 * directory contains the native binding and platform runtime, and no stale
 * cross-platform dictation files remain.
 */
export function verifyDictationArtifacts(
  extensionPath,
  platform = process.platform,
  arch = process.arch
) {
  const problems = [];
  for (const artifact of expectedArtifacts(extensionPath, platform, arch)) {
    let stats;
    try {
      stats = statSync(artifact.path);
    } catch {
      problems.push(`${artifact.role}: ${artifact.path} does not exist`);
      continue;
    }
    if (artifact.kind === 'file') {
      if (!stats.isFile()) {
        problems.push(`${artifact.role}: ${artifact.path} is not a file`);
      } else if (stats.size === 0) {
        problems.push(`${artifact.role}: ${artifact.path} is empty`);
      }
      continue;
    }
    if (!stats.isDirectory()) {
      problems.push(`${artifact.role}: ${artifact.path} is not a directory`);
      continue;
    }
    for (const problem of onnxDirectoryProblems(artifact.path, platform)) {
      problems.push(`${artifact.role}: ${problem}`);
    }
  }

  const allowedBin = [ffmpegFileName(platform)];
  if (ffmpegLicenseExpected(platform)) {
    allowedBin.push(ffmpegLicenseFileName(platform));
  }
  for (const name of unexpectedEntryNames(path.join(extensionPath, 'dist', 'bin'), allowedBin)) {
    problems.push(`dist/bin: unexpected ${name}; only ${allowedBin.join(' and ')} belongs here`);
  }

  const napi = path.join(
    extensionPath,
    'dist',
    'dictation-runtime',
    'node_modules',
    'onnxruntime-node',
    'bin',
    'napi-v3'
  );
  for (const name of unexpectedEntryNames(napi, [platform])) {
    problems.push(`ONNX bin/napi-v3: unexpected ${name}; only ${platform} is allowed`);
  }
  for (const name of unexpectedEntryNames(path.join(napi, platform), [arch])) {
    problems.push(`ONNX bin/napi-v3/${platform}: unexpected ${name}; only ${arch} is allowed`);
  }

  return problems;
}
