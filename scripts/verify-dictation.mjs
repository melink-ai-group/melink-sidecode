/**
 * Guard the packaged dictation artifacts for the build host. A release VSIX must
 * contain ffmpeg and the ONNX runtime for its own OS/architecture; a missing or
 * wrong-platform path fails the build instead of shipping a broken package.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeHost,
  isReleaseTarget,
  RELEASE_TARGETS,
  verifyDictationArtifacts
} from './dictation-artifacts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = describeHost();
const problems = verifyDictationArtifacts(root);

if (problems.length > 0) {
  console.error(`[verify:dictation] ${host}: this build has no usable dictation artifacts.`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  if (!isReleaseTarget(process.platform, process.arch)) {
    console.error(
      `[verify:dictation] ${host} is not a supported release target (${RELEASE_TARGETS.join(', ')}).`
    );
  }
  console.error(
    `[verify:dictation] Refusing to package another platform's ffmpeg/ONNX binary. ` +
      `Build on ${host} with its matching ffmpeg-static and onnxruntime-node installs.`
  );
  process.exit(1);
}

console.log(`[verify:dictation] ${host}: ffmpeg, Whisper runtime, and ONNX binary are present.`);
