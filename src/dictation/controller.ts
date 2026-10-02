import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MicRecorder, resolveFfmpeg } from './recorder';

export interface DictationEvents {
  status(requestId: string, message: string): void;
  cleaned(requestId: string, text: string): void;
  failed(requestId: string, message: string, raw?: string): void;
}

interface RuntimeModule {
  transcribeSamples(samples: Float32Array, cacheDir: string, onStatus: (message: string) => void): Promise<string>;
}

/**
 * One dictation at a time: record in this process, transcribe with the staged
 * Whisper runtime, then hand the words to the cleanup model.
 */
export class DictationController {
  private requestId?: string;
  private recorder?: MicRecorder;
  private opening?: Promise<void>;
  private finishing = false;
  private stopRequested = false;

  constructor(
    private readonly extensionPath: string,
    private readonly cacheDir: string,
    private readonly events: DictationEvents,
    private readonly clean: (text: string) => Promise<string>
  ) {}

  async start(requestId: string): Promise<void> {
    if (this.requestId) {
      this.events.failed(requestId, 'Dictation is already running.');
      return;
    }
    this.requestId = requestId;
    this.stopRequested = false;
    this.events.status(requestId, 'Starting the microphone…');
    const opening = this.open(requestId);
    this.opening = opening;
    try {
      await opening;
    } finally {
      if (this.opening === opening) {
        this.opening = undefined;
      }
    }
    if (this.stopRequested && this.requestId === requestId) {
      await this.finish(requestId);
    }
  }

  async stop(requestId: string): Promise<void> {
    if (this.requestId !== requestId) {
      return;
    }
    this.stopRequested = true;
    if (this.opening) {
      return;
    }
    await this.finish(requestId);
  }

  dispose(): void {
    this.requestId = undefined;
    try {
      this.recorder?.stop();
    } catch {
      // The view is going away. Drop whatever was recorded.
    }
    this.recorder = undefined;
  }

  private async open(requestId: string): Promise<void> {
    try {
      const ffmpeg = resolveFfmpeg(this.extensionPath);
      this.recorder = await MicRecorder.start(ffmpeg, () => {
        this.events.status(requestId, 'Reached the recording limit. Transcribing…');
        void this.stop(requestId);
      });
      if (this.requestId === requestId && !this.stopRequested) {
        this.events.status(requestId, 'Listening…');
      }
    } catch (error) {
      this.requestId = undefined;
      this.recorder = undefined;
      this.events.failed(requestId, error instanceof Error && error.message ? error.message : 'The microphone could not be opened.');
    }
  }

  private async finish(requestId: string): Promise<void> {
    if (this.finishing || this.requestId !== requestId) {
      return;
    }
    this.finishing = true;
    const recorder = this.recorder;
    this.recorder = undefined;
    let raw = '';
    try {
      if (!recorder) {
        throw new Error('The microphone is not open.');
      }
      const samples = recorder.stop();
      mkdirSync(this.cacheDir, { recursive: true });
      this.events.status(requestId, 'Preparing speech recognition…');
      const runtime = await loadRuntime(this.extensionPath);
      raw = await runtime.transcribeSamples(samples, this.cacheDir, (message) => {
        if (this.requestId === requestId) {
          this.events.status(requestId, message);
        }
      });
      this.events.status(requestId, 'Cleaning transcript…');
      const cleaned = await this.clean(raw);
      if (this.requestId !== requestId) {
        return;
      }
      this.events.cleaned(requestId, cleaned);
    } catch (error) {
      if (this.requestId === requestId) {
        const message = error instanceof Error && error.message ? error.message : 'Dictation failed.';
        this.events.failed(requestId, message, raw || undefined);
      }
    } finally {
      if (this.requestId === requestId) {
        this.requestId = undefined;
      }
      this.finishing = false;
      this.stopRequested = false;
    }
  }
}

async function loadRuntime(extensionPath: string): Promise<RuntimeModule> {
  const file = path.join(extensionPath, 'dist', 'dictation-runtime', 'transcribe.mjs');
  return import(pathToFileURL(file).href) as Promise<RuntimeModule>;
}
