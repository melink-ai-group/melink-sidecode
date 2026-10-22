/**
 * Copies the recorder binary and the Whisper runtime into dist so a packaged
 * extension can run them without node_modules. Platform binaries match the
 * machine that builds the extension.
 */
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeHost,
  ffmpegLicenseFileName,
  hostFfmpegPath,
  hostOnnxBinaryDir,
  onnxDirectoryProblems,
  stagedFfmpegPath,
  stagedOnnxBinaryDir
} from './dictation-artifacts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = path.join(root, 'node_modules');
const runtime = path.join(root, 'dist', 'dictation-runtime');
const runtimeModules = path.join(runtime, 'node_modules');

function copyPackage(name, extra) {
  const from = path.join(modules, name);
  const to = path.join(runtimeModules, name);
  if (!existsSync(from)) {
    throw new Error(`Missing ${name}. Run npm install before building.`);
  }
  const nested = `${from}${path.sep}node_modules${path.sep}`;
  cpSync(from, to, {
    recursive: true,
    filter: (source) => !source.startsWith(nested) && (extra ? extra(source, from) : true)
  });
}

const host = describeHost();
const ffmpegFrom = hostFfmpegPath(modules);
if (!existsSync(ffmpegFrom) || statSync(ffmpegFrom).size === 0) {
  throw new Error(
    `Cannot package dictation for ${host}: ${ffmpegFrom} is missing or empty. ` +
      `The build host must install ffmpeg-static for ${host}; sideCode will not package another platform's ffmpeg binary.`
  );
}
const binDir = path.join(root, 'dist', 'bin');
rmSync(binDir, { recursive: true, force: true });
mkdirSync(binDir, { recursive: true });
cpSync(ffmpegFrom, stagedFfmpegPath(root));
const license = path.join(modules, 'ffmpeg-static', ffmpegLicenseFileName());
if (existsSync(license)) {
  cpSync(license, path.join(binDir, ffmpegLicenseFileName()));
}

mkdirSync(runtimeModules, { recursive: true });
cpSync(path.join(root, 'src', 'dictation', 'transcribe.mjs'), path.join(runtime, 'transcribe.mjs'));

copyPackage(path.join('@xenova', 'transformers'), (source, from) => {
  const dist = path.join(from, 'dist');
  return source !== dist && !source.startsWith(`${dist}${path.sep}`);
});
copyPackage(path.join('@huggingface', 'jinja'));
copyPackage('onnxruntime-common');

const onnxFrom = path.join(modules, 'onnxruntime-node');
const onnxTo = path.join(runtimeModules, 'onnxruntime-node');
const platformBin = hostOnnxBinaryDir(modules);
const platformTo = stagedOnnxBinaryDir(root);
if (!existsSync(platformBin) || statSync(platformBin).isDirectory() === false) {
  throw new Error(
    `Cannot package dictation for ${host}: missing ONNX runtime directory ${platformBin}. ` +
      `The build host must install onnxruntime-node for ${host}; sideCode will not package another platform's ONNX binary.`
  );
}
const hostOnnxProblems = onnxDirectoryProblems(platformBin);
if (hostOnnxProblems.length > 0) {
  throw new Error(
    `Cannot package dictation for ${host}: ONNX runtime directory ${platformBin} is incomplete ` +
      `(${hostOnnxProblems.join('; ')}). The build host must install onnxruntime-node for ${host}; ` +
      `sideCode will not package another platform's ONNX binary.`
  );
}
rmSync(onnxTo, { recursive: true, force: true });
mkdirSync(onnxTo, { recursive: true });
cpSync(path.join(onnxFrom, 'package.json'), path.join(onnxTo, 'package.json'));
cpSync(path.join(onnxFrom, 'dist'), path.join(onnxTo, 'dist'), { recursive: true });
mkdirSync(path.dirname(platformTo), { recursive: true });
cpSync(platformBin, platformTo, { recursive: true });

function stub(name, body) {
  const dir = path.join(runtimeModules, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0', type: 'module', main: 'index.js' })
  );
  writeFileSync(path.join(dir, 'index.js'), body);
}

stub('sharp', "function sharp() { throw new Error('Image decoding is not included.'); }\nexport default sharp;\n");
stub(
  'onnxruntime-web',
  [
    'const env = {};',
    'export class InferenceSession {}',
    'export class Tensor {}',
    'export { env };',
    'export default { InferenceSession, Tensor, env };',
    ''
  ].join('\n')
);

console.log(`[dictation] staged recorder and speech runtime for ${host}`);
