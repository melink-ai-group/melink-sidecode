import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const SAMPLE_RATE = 16_000;
/** Shorter than this is treated as silence, not an utterance. */
const MIN_SAMPLES = SAMPLE_RATE / 2;
/** Stop on its own so a lost click cannot record forever. */
const MAX_MS = 90_000;

export function resolveFfmpeg(extensionPath: string): string {
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const bundled = path.join(extensionPath, 'dist', 'bin', name);
  if (existsSync(bundled)) {
    return bundled;
  }
  const installed = path.join(extensionPath, 'node_modules', 'ffmpeg-static', name);
  if (existsSync(installed)) {
    return installed;
  }
  throw new Error('The recorder is missing. Rebuild the extension and try again.');
}

/** Audio device names from `ffmpeg -list_devices`. */
export function audioDeviceNames(listing: string): string[] {
  const names: string[] = [];
  for (const match of listing.matchAll(/"([^"]+)"\s+\(audio\)/g)) {
    const name = match[1]?.trim();
    if (name) {
      names.push(name);
    }
  }
  return names;
}

export function pcmToSamples(pcm: Buffer): Float32Array {
  const samples = Math.floor(pcm.length / 2);
  const audio = new Float32Array(samples);
  for (let index = 0; index < samples; index += 1) {
    audio[index] = pcm.readInt16LE(index * 2) / 32_768;
  }
  return audio;
}

function run(ffmpeg: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function inputArgs(ffmpeg: string): Promise<string[]> {
  if (process.platform === 'win32') {
    const listing = await run(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
    const names = audioDeviceNames(listing);
    const preferred = names.find((name) => /microphone|mic\b/i.test(name)) ?? names[0];
    if (!preferred) {
      throw new Error('No microphone was found.');
    }
    return ['-f', 'dshow', '-i', `audio=${preferred}`];
  }
  if (process.platform === 'darwin') {
    return ['-f', 'avfoundation', '-i', 'none:0'];
  }
  return ['-f', 'pulse', '-i', 'default'];
}

/**
 * Records mono 16 kHz PCM from the default microphone. The bytes stay in memory,
 * so stopping the process does not depend on a finished WAV header.
 */
export class MicRecorder {
  private readonly chunks: Buffer[] = [];
  private child?: ChildProcessWithoutNullStreams;
  private limit?: ReturnType<typeof setTimeout>;
  private failure?: string;

  private constructor(private readonly onLimit: () => void) {}

  static async start(ffmpeg: string, onLimit: () => void): Promise<MicRecorder> {
    const recorder = new MicRecorder(onLimit);
    const input = await inputArgs(ffmpeg);
    const child = spawn(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', ...input, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    recorder.child = child;
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdout.on('data', (chunk: Buffer) => recorder.chunks.push(chunk));
    child.on('error', (error) => {
      recorder.failure = error.message;
    });
    child.on('close', () => {
      if (recorder.chunks.length === 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim();
        recorder.failure = detail || recorder.failure || 'The microphone stopped before any audio arrived.';
      }
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 800);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', () => {
        clearTimeout(timer);
        reject(new Error(recorder.failure || 'The microphone could not be opened.'));
      });
      child.stdout.once('data', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    recorder.limit = setTimeout(() => recorder.onLimit(), MAX_MS);
    return recorder;
  }

  /** End the recording and return the samples heard so far. */
  stop(): Float32Array {
    if (this.limit) {
      clearTimeout(this.limit);
      this.limit = undefined;
    }
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      child.kill();
    }
    const samples = pcmToSamples(Buffer.concat(this.chunks));
    if (samples.length < MIN_SAMPLES) {
      throw new Error(this.failure || 'No speech was heard.');
    }
    return samples;
  }
}
