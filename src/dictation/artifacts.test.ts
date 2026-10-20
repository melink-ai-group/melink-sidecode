import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

async function loadArtifacts() {
  return import('../../scripts/dictation-artifacts.mjs');
}

const extension = path.join('C:', 'extension');
const modules = path.join('C:', 'extension', 'node_modules');

test('release targets name the platforms that ship dictation binaries', async () => {
  const {
    RELEASE_TARGETS,
    isReleaseTarget,
    targetName
  } = await loadArtifacts();
  assert.deepEqual([...RELEASE_TARGETS], ['win32-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64']);
  assert.equal(isReleaseTarget('win32', 'x64'), true);
  assert.equal(isReleaseTarget('linux', 'x64'), true);
  assert.equal(isReleaseTarget('darwin', 'x64'), true);
  assert.equal(isReleaseTarget('darwin', 'arm64'), true);
  assert.equal(isReleaseTarget('win32', 'arm64'), false);
  assert.equal(isReleaseTarget('linux', 'arm64'), false);
  assert.equal(targetName('darwin', 'arm64'), 'darwin-arm64');
});

test('ffmpeg is named for the host platform', async () => {
  const { ffmpegFileName } = await loadArtifacts();
  assert.equal(ffmpegFileName('win32'), 'ffmpeg.exe');
  assert.equal(ffmpegFileName('darwin'), 'ffmpeg');
  assert.equal(ffmpegFileName('linux'), 'ffmpeg');
});

test('the staged Windows x64 artifacts use the Windows names and ONNX path', async () => {
  const {
    expectedArtifacts,
    stagedFfmpegPath,
    stagedOnnxBinaryDir,
    stagedTranscribePath
  } = await loadArtifacts();
  const staged = expectedArtifacts(extension, 'win32', 'x64');
  assert.deepEqual(
    staged.map((artifact) => artifact.role),
    ['ffmpeg', 'ffmpeg license', 'Whisper runtime', 'ONNX runtime']
  );
  assert.equal(stagedFfmpegPath(extension, 'win32'), path.join(extension, 'dist', 'bin', 'ffmpeg.exe'));
  assert.equal(staged[0]?.path, path.join(extension, 'dist', 'bin', 'ffmpeg.exe'));
  assert.equal(staged[1]?.path, path.join(extension, 'dist', 'bin', 'ffmpeg.exe.LICENSE'));
  assert.equal(
    stagedTranscribePath(extension),
    path.join(extension, 'dist', 'dictation-runtime', 'transcribe.mjs')
  );
  assert.equal(
    stagedOnnxBinaryDir(extension, 'win32', 'x64'),
    path.join(
      extension,
      'dist',
      'dictation-runtime',
      'node_modules',
      'onnxruntime-node',
      'bin',
      'napi-v3',
      'win32',
      'x64'
    )
  );
});

test('a macOS arm64 build points at the darwin arm64 ONNX directory', async () => {
  const { expectedArtifacts } = await loadArtifacts();
  const staged = expectedArtifacts(extension, 'darwin', 'arm64');
  assert.equal(staged[0]?.path, path.join(extension, 'dist', 'bin', 'ffmpeg'));
  assert.equal(staged[1]?.path, path.join(extension, 'dist', 'bin', 'ffmpeg.LICENSE'));
  assert.equal(
    staged[3]?.path,
    path.join(
      extension,
      'dist',
      'dictation-runtime',
      'node_modules',
      'onnxruntime-node',
      'bin',
      'napi-v3',
      'darwin',
      'arm64'
    )
  );
});

test('a Linux x64 build points at the linux x64 ONNX directory', async () => {
  const { expectedArtifacts } = await loadArtifacts();
  const staged = expectedArtifacts(extension, 'linux', 'x64');
  assert.equal(staged[0]?.path, path.join(extension, 'dist', 'bin', 'ffmpeg'));
  assert.equal(staged[1]?.path, path.join(extension, 'dist', 'bin', 'ffmpeg.LICENSE'));
  assert.equal(
    staged[3]?.path,
    path.join(
      extension,
      'dist',
      'dictation-runtime',
      'node_modules',
      'onnxruntime-node',
      'bin',
      'napi-v3',
      'linux',
      'x64'
    )
  );
});

test('host sources come from the matching ffmpeg-static and onnxruntime-node installs', async () => {
  const { hostFfmpegPath, hostOnnxBinaryDir } = await loadArtifacts();
  assert.equal(hostFfmpegPath(modules, 'win32'), path.join(modules, 'ffmpeg-static', 'ffmpeg.exe'));
  assert.equal(hostFfmpegPath(modules, 'linux'), path.join(modules, 'ffmpeg-static', 'ffmpeg'));
  assert.equal(
    hostOnnxBinaryDir(modules, 'darwin', 'arm64'),
    path.join(modules, 'onnxruntime-node', 'bin', 'napi-v3', 'darwin', 'arm64')
  );
});

test('another platform or architecture never shares the host artifact path', async () => {
  const { stagedFfmpegPath, stagedOnnxBinaryDir } = await loadArtifacts();
  const windows = stagedOnnxBinaryDir(extension, 'win32', 'x64');
  assert.notEqual(windows, stagedOnnxBinaryDir(extension, 'linux', 'x64'));
  assert.notEqual(windows, stagedOnnxBinaryDir(extension, 'win32', 'arm64'));
  assert.notEqual(stagedFfmpegPath(extension, 'win32'), stagedFfmpegPath(extension, 'darwin'));
});

test('an empty or partial ONNX directory is rejected on every release platform', async () => {
  const { missingOnnxFiles } = await loadArtifacts();
  assert.deepEqual(missingOnnxFiles([], 'win32'), ['onnxruntime_binding.node', 'onnxruntime.dll']);
  assert.deepEqual(missingOnnxFiles(['onnxruntime_binding.node'], 'win32'), ['onnxruntime.dll']);
  assert.deepEqual(missingOnnxFiles(['onnxruntime.dll'], 'win32'), ['onnxruntime_binding.node']);
  assert.deepEqual(missingOnnxFiles(['stray.txt'], 'win32'), [
    'onnxruntime_binding.node',
    'onnxruntime.dll'
  ]);

  assert.deepEqual(missingOnnxFiles([], 'darwin'), [
    'onnxruntime_binding.node',
    'libonnxruntime*.dylib'
  ]);
  assert.deepEqual(missingOnnxFiles(['onnxruntime_binding.node'], 'darwin'), [
    'libonnxruntime*.dylib'
  ]);

  assert.deepEqual(missingOnnxFiles([], 'linux'), [
    'onnxruntime_binding.node',
    'libonnxruntime*.so*'
  ]);
  assert.deepEqual(missingOnnxFiles(['onnxruntime_binding.node'], 'linux'), [
    'libonnxruntime*.so*'
  ]);
});

function writeArtifact(root: string, relativePath: string, content = 'x'): void {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

interface FixtureOptions {
  extraFiles?: Record<string, string>;
  extraDirs?: string[];
}

function makeExtensionFixture(
  onnxFiles: Record<string, string>,
  options: FixtureOptions = {}
): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sidecode-dictation-'));
  writeArtifact(root, path.join('dist', 'bin', 'ffmpeg.exe'));
  writeArtifact(root, path.join('dist', 'bin', 'ffmpeg.exe.LICENSE'));
  writeArtifact(root, path.join('dist', 'dictation-runtime', 'transcribe.mjs'));
  const onnx = path.join(
    root,
    'dist',
    'dictation-runtime',
    'node_modules',
    'onnxruntime-node',
    'bin',
    'napi-v3',
    'win32',
    'x64'
  );
  mkdirSync(onnx, { recursive: true });
  for (const [name, content] of Object.entries(onnxFiles)) {
    writeFileSync(path.join(onnx, name), content);
  }
  for (const [relativePath, content] of Object.entries(options.extraFiles ?? {})) {
    writeArtifact(root, relativePath, content);
  }
  for (const relativePath of options.extraDirs ?? []) {
    mkdirSync(path.join(root, relativePath), { recursive: true });
  }
  return root;
}

test('empty, partial, zero-byte, and stale ONNX dirs fail verification', async () => {
  const { verifyDictationArtifacts } = await loadArtifacts();
  const cases: Array<{ name: string; files: Record<string, string>; expected: string[] }> = [
    {
      name: 'empty',
      files: {},
      expected: ['onnxruntime_binding.node is missing', 'onnxruntime.dll is missing']
    },
    {
      name: 'partial',
      files: { 'onnxruntime_binding.node': 'binding' },
      expected: ['onnxruntime.dll is missing']
    },
    {
      name: 'zero-byte binding',
      files: { 'onnxruntime_binding.node': '', 'onnxruntime.dll': 'dll' },
      expected: ['onnxruntime_binding.node is empty']
    },
    {
      name: 'stale only',
      files: { 'stale.txt': 'stale' },
      expected: ['onnxruntime_binding.node is missing', 'onnxruntime.dll is missing']
    }
  ];

  for (const scenario of cases) {
    const root = makeExtensionFixture(scenario.files);
    try {
      const problems = verifyDictationArtifacts(root, 'win32', 'x64');
      for (const expected of scenario.expected) {
        assert.ok(
          problems.some((problem) => problem.includes(expected)),
          `${scenario.name}: expected "${expected}" in ${problems.join(' | ')}`
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('a complete staged artifact tree passes verification', async () => {
  const { verifyDictationArtifacts } = await loadArtifacts();
  const root = makeExtensionFixture({
    'onnxruntime_binding.node': 'binding',
    'onnxruntime.dll': 'runtime'
  });
  try {
    assert.deepEqual(verifyDictationArtifacts(root, 'win32', 'x64'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale cross-platform dictation artifacts fail verification', async () => {
  const { verifyDictationArtifacts } = await loadArtifacts();
  const napi = path.join(
    'dist',
    'dictation-runtime',
    'node_modules',
    'onnxruntime-node',
    'bin',
    'napi-v3'
  );
  const root = makeExtensionFixture(
    { 'onnxruntime_binding.node': 'binding', 'onnxruntime.dll': 'runtime' },
    {
      extraFiles: { [path.join('dist', 'bin', 'ffmpeg')]: 'stale-linux-ffmpeg' },
      extraDirs: [path.join(napi, 'linux', 'x64')]
    }
  );
  try {
    const problems = verifyDictationArtifacts(root, 'win32', 'x64');
    assert.ok(
      problems.some((problem) => problem.includes('dist/bin: unexpected ffmpeg')),
      problems.join(' | ')
    );
    assert.ok(
      problems.some((problem) => problem.includes('ONNX bin/napi-v3: unexpected linux')),
      problems.join(' | ')
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a complete ONNX directory has the binding and the platform runtime', async () => {
  const { missingOnnxFiles } = await loadArtifacts();
  assert.deepEqual(missingOnnxFiles(['onnxruntime_binding.node', 'onnxruntime.dll'], 'win32'), []);
  assert.deepEqual(missingOnnxFiles(['onnxruntime_binding.node', 'onnxruntime.dll'], 'linux'), [
    'libonnxruntime*.so*'
  ]);
  assert.deepEqual(
    missingOnnxFiles(['onnxruntime_binding.node', 'libonnxruntime.1.14.0.dylib'], 'darwin'),
    []
  );
  assert.deepEqual(
    missingOnnxFiles(['onnxruntime_binding.node', 'libonnxruntime.so.1.14.0'], 'linux'),
    []
  );
});
