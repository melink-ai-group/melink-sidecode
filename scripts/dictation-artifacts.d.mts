export type ArtifactKind = 'file' | 'directory';

export interface ExpectedArtifact {
  role: string;
  path: string;
  kind: ArtifactKind;
}

export const RELEASE_TARGETS: readonly string[];

export function targetName(platform?: string, arch?: string): string;
export function isReleaseTarget(platform: string, arch: string): boolean;
export function describeHost(platform?: string, arch?: string): string;
export function ffmpegFileName(platform?: string): string;
export function ffmpegLicenseFileName(platform?: string): string;
export function ffmpegLicenseExpected(platform?: string): boolean;
export function hostFfmpegPath(modulesDir: string, platform?: string): string;
export function hostFfmpegLicensePath(modulesDir: string, platform?: string): string;
export function hostOnnxBinaryDir(modulesDir: string, platform?: string, arch?: string): string;
export function onnxRuntimeFilePattern(platform?: string): RegExp;
export function missingOnnxFiles(fileNames: string[], platform?: string): string[];
export function onnxDirectoryProblems(dir: string, platform?: string): string[];
export function stagedFfmpegPath(extensionPath: string, platform?: string): string;
export function stagedFfmpegLicensePath(extensionPath: string, platform?: string): string;
export function stagedTranscribePath(extensionPath: string): string;
export function stagedOnnxBinaryDir(extensionPath: string, platform?: string, arch?: string): string;
export function expectedArtifacts(
  extensionPath: string,
  platform?: string,
  arch?: string
): ExpectedArtifact[];
export function verifyDictationArtifacts(
  extensionPath: string,
  platform?: string,
  arch?: string
): string[];
