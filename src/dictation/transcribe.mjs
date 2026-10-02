/**
 * Whisper transcription loaded from the staged runtime next to this file.
 * Kept outside the extension bundle so the ONNX runtime resolves from here.
 */

/**
 * @param {Float32Array} samples Mono audio at 16 kHz.
 * @param {string} cacheDir Where the speech model is stored after download.
 * @param {(message: string) => void} onStatus
 * @returns {Promise<string>}
 */
export async function transcribeSamples(samples, cacheDir, onStatus) {
  const { pipeline, env } = await import('@xenova/transformers');
  env.cacheDir = cacheDir;
  env.allowLocalModels = false;
  onStatus('Preparing speech recognition…');
  const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', {
    progress_callback: (update) => {
      const message = progressMessage(update);
      if (message) {
        onStatus(message);
      }
    }
  });
  onStatus('Transcribing…');
  const result = await transcriber(samples);
  const text = typeof result?.text === 'string' ? result.text.trim() : '';
  if (!text) {
    throw new Error('No speech was heard.');
  }
  return text;
}

/**
 * @param {{ status?: string, file?: string, progress?: number }} update
 * @returns {string | undefined}
 */
function progressMessage(update) {
  if (update.status === 'progress' && typeof update.progress === 'number') {
    const percent = Math.max(0, Math.min(100, Math.round(update.progress)));
    return `Downloading the speech model… ${percent}%`;
  }
  if (update.status === 'initiate' || update.status === 'download') {
    return 'Downloading the speech model…';
  }
  if (update.status === 'done') {
    return 'Speech model ready.';
  }
  return undefined;
}
