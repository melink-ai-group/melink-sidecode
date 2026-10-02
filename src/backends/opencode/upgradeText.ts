/**
 * Turn `opencode upgrade` terminal output into one plain sentence.
 *
 * The CLI prints ANSI color, carriage-return progress bars, and box-drawing
 * glyphs. None of that belongs in the settings screen. This module has no
 * Node imports so the webview can use the same wording as the host.
 */

const VERSION = String.raw`\d+\.\d+\.\d+(?:[-+][\w.]+)?`;

/** CSI, OSC, and other escape sequences, plus block and box-drawing glyphs. */
const ANSI =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[@-_])/g;
const BLOCKS = /[\u2500-\u259F\u2800-\u28FF]/g;

/**
 * A short status line for the settings screen.
 *
 * `exitCode` is the CLI's exit code, or null when the process never exited.
 * A message that is already a short sentence is returned unchanged.
 */
export function summarizeOpencodeCliOutput(raw: string, exitCode: number | null = 0): string {
  const cleaned = stripTerminalChrome(raw);
  if (!cleaned) {
    if (exitCode === 0) {
      return 'opencode is up to date.';
    }
    return exitCode === null ? 'The opencode update failed.' : `The opencode update failed (exit ${exitCode}).`;
  }

  const skipped = cleaned.match(new RegExp(`upgrade skipped:\\s*(${VERSION})\\s+is already installed`, 'i'));
  if (skipped?.[1]) {
    return `Already up to date (${skipped[1]}).`;
  }

  const updated = cleaned.match(
    new RegExp(`(?:updated|upgraded|installed)\\s+(?:to\\s+)?v?(${VERSION})`, 'i')
  );
  if (updated?.[1] && !/already/i.test(cleaned)) {
    return exitCode === 0 ? `Updated to ${updated[1]}.` : `Update failed at ${updated[1]}.`;
  }

  const sentence = usefulSentence(cleaned);
  if (exitCode === 0) {
    return sentence || 'opencode is up to date.';
  }
  if (sentence) {
    return sentence;
  }
  return exitCode === null ? 'The opencode update failed.' : `The opencode update failed (exit ${exitCode}).`;
}

/**
 * Drop terminal decoration.
 *
 * Carriage returns usually redraw one line, but a progress bar can follow the
 * status text in the same stream. Every frame is kept when it still has words,
 * and a repeated frame is dropped so a spinner does not become a paragraph.
 */
export function stripTerminalChrome(value: string): string {
  const lines: string[] = [];
  for (const frame of value.split(/\r\n|\n|\r/)) {
    const text = frame.replace(ANSI, '').replace(BLOCKS, '').replace(/\s+/g, ' ').trim();
    if (!text || text === lines[lines.length - 1]) {
      continue;
    }
    lines.push(text);
  }
  return lines.join('\n');
}

function usefulSentence(cleaned: string): string {
  const lines = cleaned
    .split('\n')
    .map((line) => line.replace(/^[A-Z]\s+(?=Upgrade\b)/, '').trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^(using method:|done[.!]?|upgrade|t)$/i.test(line));
  const pick = lines[lines.length - 1] ?? '';
  if (!pick) {
    return '';
  }
  const oneLine = pick.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 180) {
    return oneLine;
  }
  return `${oneLine.slice(0, 180)}…`;
}
